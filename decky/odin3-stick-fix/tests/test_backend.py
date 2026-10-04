"""Backend tests on a fake sysfs tree: python3 tests/test_backend.py"""
import asyncio
import json
import os
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
ROOT = tempfile.mkdtemp()
os.environ["STICKCAL_ROOT"] = ROOT
SETTINGS = Path(ROOT) / "settings"
sys.modules["decky"] = types.SimpleNamespace(
    DECKY_PLUGIN_SETTINGS_DIR=str(SETTINGS),
    logger=types.SimpleNamespace(warning=print, info=print),
)
sys.path.insert(0, str(HERE / "py_modules"))
sys.path.insert(0, str(HERE))

import stickcal  # noqa: E402
import main  # noqa: E402

PARAMS = Path(ROOT) / "sys/module/rsinput/parameters"
PARAMS.mkdir(parents=True)
for a in stickcal.AXES:
    for f, v in (("min", -1408), ("center", 0), ("max", 1408), ("deadzone", 0), ("antideadzone", 0)):
        (PARAMS / f"axis_{a}_{f}").write_text(f"{v}\n")
for t in stickcal.TRIGGERS:
    for f, v in (("max", 1552), ("deadzone", 0), ("antideadzone", 0)):
        (PARAMS / f"trigger_{t}_{f}").write_text(f"{v}\n")
(PARAMS / "update_params").write_text("0\n")

ev = Path(ROOT) / "sys/class/input/event5"
(ev / "device").mkdir(parents=True)
(ev / "device/name").write_text("AYN Odin3 Gamepad\n")
(ev / "device/phys").write_text("serial1-0/input0\n")
(ev / "dev").write_text("13:69\n")

calls = []
stickcal.restart_inputplumber = lambda: calls.append("restart")
stickcal.set_intercept = lambda on: calls.append(f"intercept:{on}") or True


def live(name):
    return int((PARAMS / name).read_text())


def run(coro):
    return asyncio.run(coro)


AANZE = stickcal.BUILTIN_PRESETS[0]["params"]

# sanitize
try:
    stickcal.sanitize({"axis_leftx_min": 5})
    raise AssertionError("positive min accepted")
except ValueError:
    pass
assert stickcal.sanitize({"axis_leftx_min": -700.0, "junk": 1}) == {"axis_leftx_min": -700}

# device discovery
assert stickcal.find_event() == ("event5", os.makedev(13, 69))

p = main.Plugin() if callable(main.Plugin) else main.Plugin
state = run(p.get_state())
assert state["deviceFound"] and state["moduleLoaded"] and state["stored"] is None
assert [x["id"] for x in state["presets"]] == ["aanze-odin3", "driver-defaults"]

# preview writes live only, revert restores the pre-preview values
run(p.preview({"axis_leftx_min": -650, "axis_leftx_max": 650}))
assert live("axis_leftx_max") == 650 and live("update_params") == 1
run(p.preview({"axis_leftx_min": -600, "axis_leftx_max": 600}))
assert not (Path(ROOT) / "etc/armada/input-calibration.json").exists()
run(p.revert())
assert live("axis_leftx_max") == 1408, live("axis_leftx_max")

# apply preset: persisted in Armada's store, live, InputPlumber restarted once
state = run(p.apply_preset("aanze-odin3"))
stored = json.loads((Path(ROOT) / "etc/armada/input-calibration.json").read_text())
assert stored["backend"] == "rsinput" and stored["axis_lefty_min"] == -835
assert live("axis_righty_max") == 825 and live("axis_leftx_deadzone") == 70
assert calls.count("restart") == 1
assert state["active"] == "aanze-odin3"

# preview over a stored config, then revert: back to the stored values
run(p.preview({"axis_leftx_center": 30}))
assert live("axis_leftx_center") == 30
run(p.revert())
assert live("axis_leftx_center") == 0

# custom preset saved, applied, deleted
state = run(p.save_preset("Mon réglage", dict(AANZE, axis_leftx_center=25)))
custom = [x for x in state["presets"] if not x["builtin"]][0]
assert custom["name"] == "Mon réglage" and custom["params"]["axis_leftx_center"] == 25
state = run(p.apply_preset(custom["id"]))
assert live("axis_leftx_center") == 25 and state["active"] == custom["id"]
state = run(p.delete_preset(custom["id"]))
assert state["active"] is None and len(state["presets"]) == 2

# a file rewritten outside the plugin is not reported as the active preset
run(p.apply_preset("aanze-odin3"))
data = json.loads((Path(ROOT) / "etc/armada/input-calibration.json").read_text())
data["axis_leftx_max"] = 1301
(Path(ROOT) / "etc/armada/input-calibration.json").write_text(json.dumps(data))
assert run(p.get_state())["active"] is None

# rest measurement: raw values with center/deadzone 0, params restored after
seen = []


def fake_axes(fd):
    seen.append((live("axis_leftx_center"), live("axis_leftx_deadzone")))
    return {"leftx": {"value": -40, "min": -700, "max": 700}, "lefty": {"value": -20, "min": -835, "max": 835},
            "rightx": {"value": 2, "min": -910, "max": 910}, "righty": {"value": 0, "min": -825, "max": 825}}


stickcal.read_axes = fake_axes
p._fd = 99
rest = stickcal.measure_rest(99, dict(AANZE, axis_leftx_center=12), duration=0.05)
assert all(s == (0, 0) for s in seen)
assert rest["leftx"]["center"] == 40 and rest["lefty"]["center"] == 20
assert live("axis_leftx_center") == 12

# test mode: intercept on, watchdog turns it off without heartbeat
calls.clear()
run(p.start_test(30))
assert calls == ["intercept:True"] and p._test_until
p._heartbeat -= 10


async def watchdog_once():
    task = asyncio.create_task(p._main())
    await asyncio.sleep(0.7)
    task.cancel()


run(watchdog_once())
assert calls == ["intercept:True", "intercept:False"] and not p._test_until

print("OK")
