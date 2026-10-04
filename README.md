# AYN Odin 3 stick fix for Armada OS

Port of the ROCKNIX stick calibration fix from
[aanze/distribution](https://github.com/aanze/distribution) (left stick short
of its left and forward edges, rest position off-center) to
[Armada OS](https://github.com/virtudude/armada).

## Install (one line, over SSH)

On the Odin 3 running Armada:

```sh
curl -fsSL https://raw.githubusercontent.com/aanze/fix-o3-drift/claude/busy-bardeen-htwnbi/install.sh | sudo sh
```

This installs the **Odin 3 Stick Fix** Decky plugin into
`~armada/homebrew/plugins/odin3-stick-fix` and adds the reapply hook (see
below). It then restarts Decky. It does not change the calibration: choose a
preset in the plugin.

To uninstall, run the command below. It leaves
`/etc/armada/input-calibration.json` unchanged.

```sh
curl -fsSL https://raw.githubusercontent.com/aanze/fix-o3-drift/claude/busy-bardeen-htwnbi/install.sh | sudo sh -s -- --uninstall
```

## Decky plugin

The panel is opened from Decky's (…) menu > Odin 3 Stick Fix.

- **Presets**: apply one of the built-in presets. "aanze Odin 3 (fix ROCKNIX)"
  holds the values below. "Défauts du driver Armada" holds ±1408 with no
  deadzone. Your own saved presets (★) are also listed here. Applying a preset
  writes `/etc/armada/input-calibration.json`, so it is re-applied at every
  boot. It also writes the values to the driver and restarts InputPlumber.
- **Anti-drift editor**: each stick has its own settings:
  - center X/Y offset, which cancels a resting drift;
  - deadzone;
  - reach in each of the four directions (← → ↑ forward, ↓ back), with an
    optional symmetric lock.

  Every change is sent to the driver right away. The live preview therefore
  shows exactly what the new values produce:
  - the dot is the driver's output;
  - the red bands are the deadzone;
  - the percentages around each stick are the maximum deflection reached since
    the last change. Orange (< 98 %) means that edge is not reached.

  Nothing is saved until **Appliquer**. **Fermer** puts the previous values
  back. **Enregistrer en preset** stores the values as a preset without
  applying them.
- **Tester (30 s)**: while it runs, InputPlumber holds back all controller
  input from Steam (the same intercept mode Armada Control uses for its
  calibration). You can move the sticks to the edges without driving the
  menus. Stop it early with the touchscreen. It also ends on its own after
  30 s, or 4 s after the editor stops polling.
- **Mesurer le repos**: samples the sticks for 2 s with center and deadzone
  at 0, so it reads the raw resting value. It then offers to set the center to
  cancel that offset and to widen the deadzone to cover the noise plus 20.
  Do not touch the sticks while it runs.

Built files (`decky/odin3-stick-fix/dist/index.js`) are committed so the
installer needs no Node.js on the device. To rebuild:
`cd decky/odin3-stick-fix && npm ci && npm run build`.

## Command line (without the plugin)

```sh
curl -LO https://raw.githubusercontent.com/aanze/fix-o3-drift/claude/busy-bardeen-htwnbi/odin3-stick-fix.sh
sudo sh odin3-stick-fix.sh install
```

| Command     | Effect |
|-------------|--------|
| `install`   | Saves the current `/etc/armada/input-calibration.json`, writes the fixed values, installs the reapply hook, applies the values now and restarts InputPlumber. |
| `apply`     | Writes the values again and applies them now. This is the ROCKNIX "Fix Sticks" tool. |
| `status`    | Shows the stored values next to the live values. |
| `uninstall` | Removes the hook and restores the saved file. Reboot afterwards. |
| `hook` / `unhook` | Installs or removes the reapply hook only. |

If you see `/bin/sh^M: bad interpreter`, the file picked up Windows line
endings: run `sed -i 's/\r$//' odin3-stick-fix.sh`.

Values: LX ±700, LY ±835, RX ±910, RY ±825, deadzone 70, center 0,
triggers 1552. They come from `rsinput-cal-default` as of commit `1da7c87f46`.
Rationale (from the ROCKNIX commits):

- Each declared range is symmetric and set below the weakest side of its axis.
  InputPlumber, SDL and Steam put the center at (min+max)/2, so an asymmetric
  range moves the rest position off-center.
- The left stick on this unit measured -725 to the left and -870 forward
  (sustained push). Those are the two weak sides.

## How the ROCKNIX pieces map to Armada

| ROCKNIX (aanze/distribution) | Armada |
|---|---|
| `/storage/.config/autostart/GPcal.sh` (value store) | `/etc/armada/input-calibration.json`, the file Armada already reads |
| `rsinput-cal-apply` | `/usr/libexec/armada/apply-input-calibration` (Armada's own; same `axis_*`/`trigger_*` + `update_params` ABI) |
| boot autostart | `armada-input-calibration.service`, already enabled by the image, runs `Before=inputplumber.service` |
| udev `module add rsinput` rule | `/etc/udev/rules.d/98-odin3-stick-cal.rules` → `odin3-stick-cal.service` (reapply, then restart InputPlumber only if it was already running) |
| sleep.d reapply + InputPlumber restart | not needed: Armada keeps `rsinput` loaded across suspend (kernel patches 0508/1005/1007), so module parameters survive |
| `rsinput-guard` (dead-MCU recovery) | not ported: it targets ROCKNIX's checksum-mismatch probe failures, which Armada's frame-reassembly patch 0515 addresses. It does not affect drift. |

The driver math is the same on both systems: raw + center, then deadzone,
then the declared min/max. That holds in Armada's patched `rsinput.c` with
patches 0031, 1300, 1301 and 0515. The Odin 3 device-tree node has no
`invert-*` property on either system. Values measured on ROCKNIX therefore
mean the same thing on Armada.

On Armada, the defaults without this fix are ±1408 with **no deadzone**:
Armada's Odin 3 DT sets no `axis-deadzone`. Armada's MCU init also reports
analog changes at 1-count resolution (commit `475b776`), where ROCKNIX used a
40-count threshold. Without a deadzone, rest-position noise reaches games.

## Caveats

- **Do not run Armada's Decky calibration ("Move both sticks in full
  circles") after installing.** It overwrites
  `/etc/armada/input-calibration.json`. A circular sweep also records
  diagonal peaks as axis maxima, which a straight push never reaches: this is
  the same trap as ROCKNIX's GPcal. If you used it, run `sudo sh
  odin3-stick-fix.sh apply`.
- The values were measured on one specific unit, after an Android
  recalibration. If your unit differs, edit the JSON block in
  `write_config()`. Keep each axis symmetric.
- Restarting InputPlumber shows one controller disconnect/reconnect. This
  only happens on `install`/`apply` or after a module reload.

## Test

```sh
git clone --depth 1 https://github.com/virtudude/armada /tmp/armada
sh tests/run.sh /tmp/armada                        # CLI, against Armada's real applier
python3 decky/odin3-stick-fix/tests/test_backend.py  # plugin backend, fake sysfs
cd decky/odin3-stick-fix && npm test               # editor model
```

The test runs Armada's real `apply-input-calibration` against a fake sysfs.
It checks the live values, the InputPlumber restart, the backup/restore, the
udev rule and the unit. None of these replace a test on the device. The plugin UI only runs inside
Steam, so it has only been type-checked and built here.
