#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# AYN Odin 3 stick calibration fix for Armada OS.
#
# Port of the ROCKNIX/DUCKTALE stick calibration fix (aanze/distribution:
# quirks/devices/AYN Odin 3/bin/rsinput-cal-default + rsinput-cal-apply +
# 052-stick-calibration + the "Fix Sticks" tool) onto Armada's own plumbing:
#
#   ROCKNIX                                 Armada
#   /storage/.config/autostart/GPcal.sh  -> /etc/armada/input-calibration.json
#   rsinput-cal-apply                    -> /usr/libexec/armada/apply-input-calibration
#   boot autostart                       -> armada-input-calibration.service
#                                           (shipped + enabled by the image)
#   udev module-add rule -> cal-apply    -> udev module-add rule -> odin3-stick-cal.service
#   "Fix Sticks" tool                    -> odin3-stick-fix.sh apply
#
# Usage (as root, from SSH or a desktop-mode terminal):
#   odin3-stick-fix.sh install     write the values, install the reapply hook,
#                                  apply now and restart InputPlumber
#   odin3-stick-fix.sh apply       re-write the values and apply now (the
#                                  equivalent of the ROCKNIX "Fix Sticks" tool)
#   odin3-stick-fix.sh status      show stored vs live values
#   odin3-stick-fix.sh uninstall   remove the hook, restore the previous
#                                  calibration file (takes effect at reboot)
#   odin3-stick-fix.sh hook        install the reapply hook only (values untouched)
#   odin3-stick-fix.sh unhook      remove the reapply hook only

set -eu

# Overridable for tests only.
ROOT="${ROOT:-}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
UDEVADM="${UDEVADM:-udevadm}"

CONFIG="${ROOT}/etc/armada/input-calibration.json"
BACKUP="${CONFIG}.before-odin3-stick-fix"
UNIT_NAME="odin3-stick-cal.service"
UNIT="${ROOT}/etc/systemd/system/${UNIT_NAME}"
RULE="${ROOT}/etc/udev/rules.d/98-odin3-stick-cal.rules"
PARAMS="${ROOT}/sys/module/rsinput/parameters"
APPLIER="${ROOT}/usr/libexec/armada/apply-input-calibration"
DEVICE_CONF="${ROOT}/usr/lib/armada/devices/ayn-odin-3.conf"

# Values: round-3 sustained-cardinal measurement (2026-07-20, on the
# aanze unit), raw reach LX -725..+953  LY -870..+992  RX -948..+994
# RY -990..+1017, declared SYMMETRIC around 0 below the WEAKEST side of
# each axis:
#  - consumers (InputPlumber/SDL/Steam) put the center at (min+max)/2, so an
#    asymmetric range shifts the rest position off-center;
#  - the left-stick sensor drifts between sessions (-839 on 07/18 vs -725 on
#    07/20); the margin guarantees full deflection every session.
#  - RY 825: the down stop settles over ~1 s, 825 sits under the weakest
#    instantaneous contact observed.
# Deadzone 70 on every axis. Armada's Odin 3 driver defaults are +/-1408
# with NO deadzone (no axis-deadzone in its device tree), and its MCU init
# reports 1-count analog changes, so rest-position noise reaches games
# unfiltered without it.
write_config() {
  mkdir -p "$(dirname "${CONFIG}")"
  tmp="${CONFIG}.tmp.$$"
  cat > "${tmp}" <<'EOF'
{
  "axis_leftx_antideadzone": 0,
  "axis_leftx_center": 0,
  "axis_leftx_deadzone": 70,
  "axis_leftx_max": 700,
  "axis_leftx_min": -700,
  "axis_lefty_antideadzone": 0,
  "axis_lefty_center": 0,
  "axis_lefty_deadzone": 70,
  "axis_lefty_max": 835,
  "axis_lefty_min": -835,
  "axis_rightx_antideadzone": 0,
  "axis_rightx_center": 0,
  "axis_rightx_deadzone": 70,
  "axis_rightx_max": 910,
  "axis_rightx_min": -910,
  "axis_righty_antideadzone": 0,
  "axis_righty_center": 0,
  "axis_righty_deadzone": 70,
  "axis_righty_max": 825,
  "axis_righty_min": -825,
  "backend": "rsinput",
  "trigger_left_antideadzone": 0,
  "trigger_left_deadzone": 0,
  "trigger_left_max": 1552,
  "trigger_right_antideadzone": 0,
  "trigger_right_deadzone": 0,
  "trigger_right_max": 1552
}
EOF
  chmod 0644 "${tmp}"
  mv -f "${tmp}" "${CONFIG}"
}

# Module parameters reset to driver defaults on every rsinput load. Armada
# keeps rsinput loaded across suspend (in-kernel PM), so this only matters
# for a manual modprobe cycle, but then InputPlumber can attach against the
# default absinfo before the values land and normalize against it forever
# (the ROCKNIX "calibration reset itself" root cause). So: re-apply on every
# module add, and restart InputPlumber once if it was already running. At
# boot it is not running yet - armada-input-calibration.service already
# applies the file Before=inputplumber.service.
# Only stock binaries are executed (no script under /var or /usr/local), so
# the hook does not depend on SELinux labels.
write_hook() {
  mkdir -p "$(dirname "${UNIT}")" "$(dirname "${RULE}")"
  cat > "${UNIT}" <<'EOF'
[Unit]
Description=Re-apply AYN Odin 3 stick calibration after an rsinput reload
After=armada-input-calibration.service
ConditionPathExists=/etc/armada/input-calibration.json

[Service]
Type=oneshot
ExecStart=/usr/libexec/armada/apply-input-calibration
ExecStartPost=/bin/sh -c 'if systemctl -q is-active inputplumber.service; then systemctl restart inputplumber.service; fi'
EOF
  cat > "${RULE}" <<EOF
ACTION=="add", SUBSYSTEM=="module", KERNEL=="rsinput", RUN+="/usr/bin/systemctl --no-block start ${UNIT_NAME}"
EOF
  chmod 0644 "${UNIT}" "${RULE}"
}

# Live apply through Armada's own applier (same parameter ABI as ROCKNIX:
# axis_*/trigger_* + update_params), then ONE InputPlumber restart so it
# re-reads the new absinfo - exactly what "Fix Sticks" did on ROCKNIX.
apply_now() {
  if [ ! -d "${PARAMS}" ]; then
    echo "rsinput is not loaded: the values are stored and will apply at next boot." >&2
    return 0
  fi
  "${APPLIER}"
  ${SYSTEMCTL} restart inputplumber.service
}

check_device() {
  [ "$(id -u)" -eq 0 ] || [ -n "${ROOT}" ] || { echo "Run as root (sudo)." >&2; exit 1; }
  if [ ! -x "${APPLIER}" ]; then
    echo "${APPLIER} not found: this does not look like Armada OS." >&2
    exit 1
  fi
  if [ ! -f "${DEVICE_CONF}" ] || ! grep -q '^ARMADA_DEVICE_ID=ayn-odin-3$' "${DEVICE_CONF}"; then
    echo "Warning: could not confirm this is an AYN Odin 3; the values were measured on one." >&2
  fi
}

cmd_install() {
  check_device
  if [ -f "${CONFIG}" ] && [ ! -f "${BACKUP}" ]; then
    cp -p "${CONFIG}" "${BACKUP}"
    echo "Previous calibration saved to ${BACKUP}"
  fi
  write_config
  write_hook
  ${SYSTEMCTL} daemon-reload
  ${UDEVADM} control --reload 2>/dev/null || true
  apply_now
  echo "Installed. Stick calibration: LX ±700  LY ±835  RX ±910  RY ±825  deadzone 70"
}

cmd_apply() {
  check_device
  write_config
  apply_now
  echo "Stick calibration restored: LX ±700  LY ±835  RX ±910  RY ±825  deadzone 70"
}

cmd_uninstall() {
  [ "$(id -u)" -eq 0 ] || [ -n "${ROOT}" ] || { echo "Run as root (sudo)." >&2; exit 1; }
  rm -f "${UNIT}" "${RULE}"
  if [ -f "${BACKUP}" ]; then
    mv -f "${BACKUP}" "${CONFIG}"
    echo "Previous calibration restored."
  else
    rm -f "${CONFIG}"
    echo "Calibration file removed (Armada driver defaults)."
  fi
  ${SYSTEMCTL} daemon-reload
  ${UDEVADM} control --reload 2>/dev/null || true
  echo "Reboot to put the live driver values back."
}

cmd_hook() {
  check_device
  write_hook
  ${SYSTEMCTL} daemon-reload
  ${UDEVADM} control --reload 2>/dev/null || true
  echo "Reapply hook installed."
}

cmd_unhook() {
  [ "$(id -u)" -eq 0 ] || [ -n "${ROOT}" ] || { echo "Run as root (sudo)." >&2; exit 1; }
  rm -f "${UNIT}" "${RULE}"
  ${SYSTEMCTL} daemon-reload
  ${UDEVADM} control --reload 2>/dev/null || true
  echo "Reapply hook removed."
}

cmd_status() {
  printf '%-28s %10s %10s\n' parameter stored live
  for p in axis_leftx_min axis_leftx_max axis_leftx_center axis_leftx_deadzone \
           axis_lefty_min axis_lefty_max axis_lefty_center axis_lefty_deadzone \
           axis_rightx_min axis_rightx_max axis_rightx_center axis_rightx_deadzone \
           axis_righty_min axis_righty_max axis_righty_center axis_righty_deadzone; do
    s=$(sed -n "s/^ *\"${p}\": *\(-\{0,1\}[0-9]*\).*/\1/p" "${CONFIG}" 2>/dev/null)
    l=$(cat "${PARAMS}/${p}" 2>/dev/null || true)
    printf '%-28s %10s %10s\n' "${p}" "${s:--}" "${l:--}"
  done
  [ -f "${RULE}" ] && echo "reapply hook: installed" || echo "reapply hook: not installed"
}

case "${1:-}" in
  install)   cmd_install ;;
  apply)     cmd_apply ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  hook)      cmd_hook ;;
  unhook)    cmd_unhook ;;
  *)
    echo "usage: $0 install|apply|status|uninstall|hook|unhook" >&2
    exit 2
    ;;
esac
