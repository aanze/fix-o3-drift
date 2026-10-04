# SPDX-License-Identifier: GPL-2.0-or-later
"""AYN Odin 3 stick calibration on Armada OS: rsinput module parameters,
Armada's calibration store, live stick readout and InputPlumber control.

No Decky import here so the module can be tested on its own. Every absolute
path sits under ROOT (empty on the device, a fake tree in tests).
"""

import copy
import fcntl
import json
import os
import stat
import struct
import subprocess
import time
from pathlib import Path

ROOT = os.environ.get("STICKCAL_ROOT", "")


def _p(path):
    return Path(ROOT + path)


CONFIG = _p("/etc/armada/input-calibration.json")
PARAMS = _p("/sys/module/rsinput/parameters")
SYS_INPUT = _p("/sys/class/input")
DEV_INPUT = _p("/dev/input")
# InputPlumber hides the physical node it grabs by moving it here.
IP_SOURCES = _p("/dev/inputplumber/sources")
RUN_DIR = _p("/run/odin3-stick-fix")
INTERCEPT = "/usr/libexec/armada/inputplumber-intercept"

AXES = ("leftx", "lefty", "rightx", "righty")
AXIS_CODES = {"leftx": 0, "lefty": 1, "rightx": 3, "righty": 4}  # ABS_X, ABS_Y, ABS_RX, ABS_RY
AXIS_FIELDS = ("min", "center", "max", "deadzone", "antideadzone")
TRIGGERS = ("left", "right")
TRIGGER_FIELDS = ("max", "deadzone", "antideadzone")
PARAM_NAMES = tuple(
    [f"axis_{a}_{f}" for a in AXES for f in AXIS_FIELDS]
    + [f"trigger_{t}_{f}" for t in TRIGGERS for f in TRIGGER_FIELDS]
)

# Allowed ranges. The MCU reports roughly +/-1000 raw counts per side.
LIMITS = {
    "min": (-2048, -1),
    "max": (1, 2048),
    "center": (-512, 512),
    "deadzone": (0, 512),
    "antideadzone": (0, 512),
    "trigger_max": (1, 4096),
    "trigger_deadzone": (0, 1024),
    "trigger_antideadzone": (0, 1024),
}


def _axis_params(lx, ly, rx, ry, deadzone):
    params = {}
    for axis, reach in (("leftx", lx), ("lefty", ly), ("rightx", rx), ("righty", ry)):
        params[f"axis_{axis}_min"] = -reach
        params[f"axis_{axis}_center"] = 0
        params[f"axis_{axis}_max"] = reach
        params[f"axis_{axis}_deadzone"] = deadzone
        params[f"axis_{axis}_antideadzone"] = 0
    for trigger in TRIGGERS:
        params[f"trigger_{trigger}_max"] = 1552
        params[f"trigger_{trigger}_deadzone"] = 0
        params[f"trigger_{trigger}_antideadzone"] = 0
    return params


BUILTIN_PRESETS = (
    {
        # rsinput-cal-default in aanze/distribution (ROCKNIX), commit 1da7c87f46.
        "id": "aanze-odin3",
        "name": "aanze Odin 3 (fix ROCKNIX)",
        "builtin": True,
        "params": _axis_params(700, 835, 910, 825, 70),
    },
    {
        # rsinput.c defaults on Armada (0x580, no deadzone in the Odin 3 DT).
        "id": "driver-defaults",
        "name": "Défauts du driver Armada",
        "builtin": True,
        "params": _axis_params(1408, 1408, 1408, 1408, 0),
    },
)


def clean_env():
    # Decky's loader is a PyInstaller bundle exporting its unpack dir as
    # LD_LIBRARY_PATH; system binaries must not load those libraries.
    env = dict(os.environ)
    original = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if original:
        env["LD_LIBRARY_PATH"] = original
    else:
        env.pop("LD_LIBRARY_PATH", None)
    return env


def _limit_key(name):
    if name.startswith("trigger_"):
        return "trigger_" + name.rsplit("_", 1)[1]
    return name.rsplit("_", 1)[1]


def sanitize(params):
    """Keep known parameters only, as ints, inside LIMITS; raise on anything else."""
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    clean = {}
    for name in PARAM_NAMES:
        if name not in params:
            continue
        value = params[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value):
            raise ValueError(f"{name}: not an integer")
        value = int(value)
        low, high = LIMITS[_limit_key(name)]
        if not low <= value <= high:
            raise ValueError(f"{name}: {value} outside {low}..{high}")
        clean[name] = value
    return clean


def module_loaded():
    return PARAMS.is_dir()


def read_live():
    params = {}
    if not module_loaded():
        return params
    for name in PARAM_NAMES:
        try:
            params[name] = int((PARAMS / name).read_text().strip())
        except (OSError, ValueError):
            pass
    return params


def write_live(params):
    """Write the driver parameters; update_params makes the driver re-declare
    its axis ranges at the next MCU frame."""
    params = sanitize(params)
    if not module_loaded():
        raise RuntimeError("le module rsinput n'est pas chargé")
    for name, value in params.items():
        (PARAMS / name).write_text(str(value))
    (PARAMS / "update_params").write_text("1")


def read_stored():
    try:
        data = json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return sanitize({k: v for k, v in data.items() if k in PARAM_NAMES})
    except ValueError:
        return None


def persist(params):
    """Write Armada's calibration store, which armada-input-calibration.service
    applies at every boot before InputPlumber starts."""
    params = sanitize(params)
    data = dict(params)
    data["backend"] = "rsinput"
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG.with_name(CONFIG.name + f".tmp.{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, CONFIG)


def restart_inputplumber():
    # InputPlumber caches each axis range when it attaches to the device, so
    # new ranges only reach games after a restart.
    subprocess.run(
        ["systemctl", "restart", "inputplumber.service"],
        check=True, capture_output=True, timeout=30, env=clean_env(),
    )


def set_intercept(enabled):
    """Route all controller input to InputPlumber's D-Bus interface (Steam
    sees nothing) so sticks can be moved freely while testing."""
    mode = "overlay" if enabled else "reset"
    if os.access(INTERCEPT, os.X_OK):
        cmd = [INTERCEPT, mode]
    else:
        cmd = ["busctl", "--system", "set-property", "org.shadowblip.InputPlumber",
               "/org/shadowblip/InputPlumber/CompositeDevice0",
               "org.shadowblip.Input.CompositeDevice", "InterceptMode", "u", "2" if enabled else "0"]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=5, env=clean_env())
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def find_event():
    """(eventN, st_rdev) of the rsinput gamepad, or None."""
    for event in sorted(SYS_INPUT.glob("event*")):
        try:
            name = (event / "device/name").read_text().strip()
        except OSError:
            continue
        try:
            phys = (event / "device/phys").read_text().strip()
        except OSError:
            phys = ""
        if name == "AYN Odin3 Gamepad" or "rsinput" in name.lower() or "rsinput" in phys.lower():
            try:
                major, minor = (event / "dev").read_text().strip().split(":")
            except (OSError, ValueError):
                continue
            return event.name, os.makedev(int(major), int(minor))
    return None


def _node_matches(path, rdev):
    try:
        st = os.stat(path)
    except OSError:
        return False
    return stat.S_ISCHR(st.st_mode) and st.st_rdev == rdev


def open_event():
    """Open the gamepad's evdev node read-only. Reading the axis state with
    EVIOCGABS works even while InputPlumber holds an exclusive grab."""
    found = find_event()
    if not found:
        return None, None
    name, rdev = found
    for directory in (DEV_INPUT, IP_SOURCES):
        path = directory / name
        if _node_matches(path, rdev):
            return os.open(path, os.O_RDONLY | os.O_NONBLOCK), name
    # Node hidden or moved: make a private one.
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    path = RUN_DIR / name
    if not _node_matches(path, rdev):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        os.mknod(path, 0o600 | stat.S_IFCHR, rdev)
    return os.open(path, os.O_RDONLY | os.O_NONBLOCK), name


def _eviocgabs(code):
    return 0x80184540 + code


def read_axes(fd):
    axes = {}
    for axis, code in AXIS_CODES.items():
        data = fcntl.ioctl(fd, _eviocgabs(code), b"\0" * 24)
        value, minimum, maximum, _fuzz, _flat, _res = struct.unpack("iiiiii", data)
        axes[axis] = {"value": value, "min": minimum, "max": maximum}
    return axes


def measure_rest(fd, base_params, duration=2.0, interval=0.01):
    """Sample the sticks at rest with center 0 and deadzone 0, so the evdev
    value is the raw MCU reading. Restores base_params afterwards."""
    probe = copy.deepcopy(base_params)
    for axis in AXES:
        probe[f"axis_{axis}_center"] = 0
        probe[f"axis_{axis}_deadzone"] = 0
        probe[f"axis_{axis}_antideadzone"] = 0
    write_live(probe)
    samples = {axis: [] for axis in AXES}
    try:
        time.sleep(0.2)  # let the next MCU frames carry the new parameters
        end = time.monotonic() + duration
        while time.monotonic() < end:
            for axis, data in read_axes(fd).items():
                samples[axis].append(data["value"])
            time.sleep(interval)
    finally:
        write_live(base_params)
    return rest_stats(samples)


def rest_stats(samples):
    stats = {}
    for axis, values in samples.items():
        if not values:
            continue
        mean = sum(values) / len(values)
        noise = max(abs(v - mean) for v in values)
        stats[axis] = {
            "mean": round(mean, 1),
            "min": min(values),
            "max": max(values),
            "noise": round(noise, 1),
            # driver: value = raw + center, so center = -mean puts rest at 0
            "center": -int(round(mean)),
        }
    return stats


def merge(base, overrides):
    params = dict(base or {})
    params.update(overrides or {})
    return params
