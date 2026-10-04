#!/bin/sh
# Offline test against Armada's real applier, on a fake root.
# usage: tests/run.sh /path/to/armada-checkout   (github.com/virtudude/armada)
set -eu

ARMADA="${1:?usage: $0 /path/to/armada-checkout}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "${T}"' EXIT

P="${T}/sys/module/rsinput/parameters"
mkdir -p "${P}" "${T}/usr/libexec/armada" "${T}/usr/lib/armada/devices" "${T}/etc/armada"
cp "${ARMADA}/system_files/usr/lib/armada/devices/ayn-odin-3.conf" "${T}/usr/lib/armada/devices/"
# Armada's applier with its absolute paths moved under the fake root.
sed -e "s|Path(\"/etc/|Path(\"${T}/etc/|" -e "s|Path(\"/sys/|Path(\"${T}/sys/|" \
  "${ARMADA}/system_files/usr/libexec/armada/apply-input-calibration" \
  > "${T}/usr/libexec/armada/apply-input-calibration"
chmod +x "${T}/usr/libexec/armada/apply-input-calibration"

# Driver defaults on Armada (rsinput.c: +/-0x580, deadzone 0).
for a in leftx lefty rightx righty; do
  echo -1408 > "${P}/axis_${a}_min"; echo 1408 > "${P}/axis_${a}_max"
  for s in center deadzone antideadzone; do echo 0 > "${P}/axis_${a}_${s}"; done
done
for t in left right; do
  echo 1552 > "${P}/trigger_${t}_max"
  echo 0 > "${P}/trigger_${t}_deadzone"; echo 0 > "${P}/trigger_${t}_antideadzone"
done
echo 0 > "${P}/update_params"
echo '{"backend": "rsinput", "axis_leftx_max": 1301}' > "${T}/etc/armada/input-calibration.json"

LOG="${T}/calls"
export ROOT="${T}" SYSTEMCTL="echo systemctl" UDEVADM="echo udevadm"

fail() { echo "FAIL: $*"; exit 1; }
want() { [ "$(cat "${P}/$1")" = "$2" ] || fail "$1 = $(cat "${P}/$1"), want $2"; }

sh "${HERE}/odin3-stick-fix.sh" install > "${LOG}"
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "${T}/etc/armada/input-calibration.json"
want axis_leftx_min -700;  want axis_leftx_max 700
want axis_lefty_min -835;  want axis_lefty_max 835
want axis_rightx_min -910; want axis_rightx_max 910
want axis_righty_min -825; want axis_righty_max 825
for a in leftx lefty rightx righty; do want "axis_${a}_deadzone" 70; want "axis_${a}_center" 0; done
want trigger_left_max 1552; want update_params 1
grep -q 'systemctl restart inputplumber.service' "${LOG}" || fail "no InputPlumber restart"
grep -q '"axis_leftx_max": 1301' "${T}/etc/armada/input-calibration.json.before-odin3-stick-fix" || fail "no backup"
grep -q 'KERNEL=="rsinput"' "${T}/etc/udev/rules.d/98-odin3-stick-cal.rules" || fail "no udev rule"
grep -q '^ExecStart=/usr/libexec/armada/apply-input-calibration$' "${T}/etc/systemd/system/odin3-stick-cal.service" || fail "bad unit"

# A module reload resets params; apply restores them.
echo 1408 > "${P}/axis_leftx_max"; echo 0 > "${P}/update_params"
sh "${HERE}/odin3-stick-fix.sh" apply > "${LOG}"
want axis_leftx_max 700; want update_params 1

sh "${HERE}/odin3-stick-fix.sh" status | grep -q 'axis_lefty_min *-835 *-835' || fail "status"

sh "${HERE}/odin3-stick-fix.sh" uninstall > "${LOG}"
[ ! -e "${T}/etc/udev/rules.d/98-odin3-stick-cal.rules" ] || fail "rule left behind"
grep -q '"axis_leftx_max": 1301' "${T}/etc/armada/input-calibration.json" || fail "backup not restored"

echo "OK"
