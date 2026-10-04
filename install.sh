#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Installs the "Odin 3 Stick Fix" Decky plugin on Armada OS, plus the hook
# that re-applies the stick calibration when rsinput is reloaded. Does not
# change the calibration itself: pick a preset in the plugin.
#
# Over SSH on the Odin 3:
#   curl -fsSL https://raw.githubusercontent.com/aanze/fix-o3-drift/claude/busy-bardeen-htwnbi/install.sh | sudo sh
# Uninstall (keeps /etc/armada/input-calibration.json as it is):
#   curl -fsSL https://raw.githubusercontent.com/aanze/fix-o3-drift/claude/busy-bardeen-htwnbi/install.sh | sudo sh -s -- --uninstall

set -eu

REPO="aanze/fix-o3-drift"
REF="${REF:-claude/busy-bardeen-htwnbi}"
PLUGIN="odin3-stick-fix"

die() { echo "Erreur : $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "lancer avec sudo (… | sudo sh)."

# Decky runs from the session user's home (armada on Armada OS).
USER_NAME="${DECKY_USER:-${SUDO_USER:-armada}}"
[ "${USER_NAME}" != "root" ] || USER_NAME=armada
USER_HOME="$(getent passwd "${USER_NAME}" | cut -d: -f6)"
[ -n "${USER_HOME}" ] || die "utilisateur ${USER_NAME} introuvable (DECKY_USER=… pour le préciser)."
DEST="${USER_HOME}/homebrew/plugins/${PLUGIN}"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "${DEST}"
  rm -f /etc/systemd/system/odin3-stick-cal.service /etc/udev/rules.d/98-odin3-stick-cal.rules
  systemctl daemon-reload
  udevadm control --reload 2>/dev/null || true
  systemctl restart plugin_loader.service 2>/dev/null || true
  echo "Plugin et hook supprimés. /etc/armada/input-calibration.json est inchangé."
  exit 0
fi

[ -d "${USER_HOME}/homebrew/plugins" ] || die "Decky Loader introuvable dans ${USER_HOME}/homebrew."
[ -x /usr/libexec/armada/apply-input-calibration ] || die "ce système ne ressemble pas à Armada OS."

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Téléchargement de ${REPO}@${REF}…"
curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}" | tar -xz -C "${TMP}" --strip-components=1
SRC="${TMP}/decky/${PLUGIN}"
[ -f "${SRC}/dist/index.js" ] || die "archive incomplète (dist/index.js manquant)."

rm -rf "${DEST}"
mkdir -p "${DEST}/dist"
# Plain cp (no -a): files take the home directory's SELinux label, not /tmp's.
cp -R "${SRC}/plugin.json" "${SRC}/package.json" "${SRC}/main.py" "${SRC}/py_modules" "${DEST}/"
cp "${SRC}/dist/index.js" "${DEST}/dist/"
cp "${TMP}/odin3-stick-fix.sh" "${DEST}/"
chown -R "${USER_NAME}:${USER_NAME}" "${DEST}"
command -v restorecon >/dev/null 2>&1 && restorecon -R "${DEST}" 2>/dev/null || true

sh "${TMP}/odin3-stick-fix.sh" hook

systemctl restart plugin_loader.service
echo "Installé : ${DEST}"
echo "Ouvrez le menu Decky (…) > Odin 3 Stick Fix, puis appliquez le preset « aanze Odin 3 (fix ROCKNIX) »."
