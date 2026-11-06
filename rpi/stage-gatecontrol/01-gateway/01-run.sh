#!/bin/bash -e
# GateControl-Gateway-Dateien ins Image kopieren und Dienste aktivieren.

# shellcheck source-path=SCRIPTDIR source=../../versions.env
. "${GC_REPO_DIR}/rpi/versions.env"
SRC="${GC_REPO_DIR}/rpi/rootfs"
GW="${ROOTFS_DIR}/opt/gatecontrol-gateway"

# Dateien 1:1 übernehmen (Eigentümer root; Rechte aus dem Repo).
rsync -rlptD --chown=root:root --exclude __pycache__ "${SRC}/" "${ROOTFS_DIR}/"

# deCONZ- und Ollama-Image (Tag + Digest) in die Compose-Datei eintragen.
sed -i -e "s|@DECONZ_IMAGE@|${DECONZ_IMAGE}|" -e "s|@OLLAMA_IMAGE@|${OLLAMA_IMAGE}|" "${GW}/docker-compose.yml"
if grep -q '@[A-Z_]*@' "${GW}/docker-compose.yml"; then
	echo "Platzhalter in docker-compose.yml nicht ersetzt" >&2
	exit 1
fi

# Auto-Update: dasselbe update.sh wie auf dem NAS (deploy/update.sh).
install -m 0755 "${GC_REPO_DIR}/deploy/update.sh" "${GW}/update.sh"

install -d -m 0700 "${GW}/config"
install -d -m 0755 "${GW}/gateway-state" "${GW}/deconz"
install -d -m 0755 "${ROOTFS_DIR}/etc/gatecontrol"
printf '%s\n' "${GC_IMAGE_VERSION}" >"${ROOTFS_DIR}/etc/gatecontrol/image-release"

on_chroot <<CHROOT
systemctl enable gatecontrol-settings.service gatecontrol-hwdetect.service gatecontrol-gateway.service \
	gatecontrol-gateway-update.path gatecontrol-gateway-update.timer gatecontrol-radio.path gatecontrol-ai.path \
	unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer
CHROOT
