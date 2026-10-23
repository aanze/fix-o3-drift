#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Installs the "Odin 3 Stick Fix" Decky plugin on Armada OS, plus the hook
# that re-applies the stick calibration when rsinput is reloaded. Does not
# change the calibration itself: pick a preset in the plugin.
#
# The repository is private: pass a GitHub token with read access to its
# contents. Over SSH on the Odin 3 (the token is read without echo and stays
# out of the shell history and the process list):
#   (umask 077; read -rsp 'Token GitHub : ' T && echo && printf 'Authorization: Bearer %s\n' "$T" > /tmp/gh-h) && curl -fsSL -H @/tmp/gh-h -H 'Accept: application/vnd.github.raw+json' https://api.github.com/repos/aanze/fix-o3-drift/contents/install.sh?ref=main | sudo env GITHUB_TOKEN_FILE=/tmp/gh-h sh; rm -f /tmp/gh-h
# Uninstall (keeps /etc/armada/input-calibration.json as it is; no token needed):
#   sudo sh ~/homebrew/plugins/odin3-stick-fix/install.sh --uninstall

set -eu

REPO="aanze/fix-o3-drift"
REF="${REF:-main}"
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
# GITHUB_TOKEN_FILE holds an "Authorization: Bearer <token>" header line,
# GITHUB_TOKEN the bare token. Without either, only a public repo works.
HEADER="${TMP}/auth-header"
if [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
  [ -r "${GITHUB_TOKEN_FILE}" ] || die "${GITHUB_TOKEN_FILE} illisible."
  cp "${GITHUB_TOKEN_FILE}" "${HEADER}"
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  printf 'Authorization: Bearer %s\n' "${GITHUB_TOKEN}" > "${HEADER}"
fi
if [ -f "${HEADER}" ]; then
  chmod 600 "${HEADER}"
  # The API answers with a redirect to a short-lived codeload URL; curl does
  # not forward the Authorization header to that other host.
  curl -fsSL -H "@${HEADER}" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/tarball/${REF}" > "${TMP}/repo.tgz" \
    || die "téléchargement refusé : vérifiez le token (accès en lecture à ${REPO})."
else
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}" > "${TMP}/repo.tgz" \
    || die "téléchargement refusé : ${REPO} est privé, passez un token (voir l'en-tête de ce script)."
fi
mkdir "${TMP}/src"
tar -xzf "${TMP}/repo.tgz" -C "${TMP}/src" --strip-components=1
SRC="${TMP}/src/decky/${PLUGIN}"
[ -f "${SRC}/dist/index.js" ] || die "archive incomplète (dist/index.js manquant)."

rm -rf "${DEST}"
mkdir -p "${DEST}/dist"
# Plain cp (no -a): files take the home directory's SELinux label, not /tmp's.
cp -R "${SRC}/plugin.json" "${SRC}/package.json" "${SRC}/main.py" "${SRC}/py_modules" "${DEST}/"
cp "${SRC}/dist/index.js" "${DEST}/dist/"
cp "${TMP}/src/odin3-stick-fix.sh" "${TMP}/src/install.sh" "${DEST}/"
chown -R "${USER_NAME}:${USER_NAME}" "${DEST}"
command -v restorecon >/dev/null 2>&1 && restorecon -R "${DEST}" 2>/dev/null || true

sh "${TMP}/src/odin3-stick-fix.sh" hook

systemctl restart plugin_loader.service
echo "Installé : ${DEST}"
echo "Ouvrez le menu Decky (…) > Odin 3 Stick Fix, puis appliquez le preset « aanze Odin 3 (fix ROCKNIX) »."
