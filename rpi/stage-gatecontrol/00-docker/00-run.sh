#!/bin/bash -e
# Docker-Apt-Repository einrichten. Der Signaturschlüssel liegt im Repo und
# wird gegen SHA-256 und Fingerprint aus rpi/versions.env geprüft.

# shellcheck source-path=SCRIPTDIR source=../../versions.env
. "${GC_REPO_DIR}/rpi/versions.env"

KEY=files/docker.asc
echo "${DOCKER_GPG_SHA256}  ${KEY}" | sha256sum -c -
GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
FPR="$(gpg --batch --show-keys --with-colons "${KEY}" | awk -F: '/^fpr:/ {print $10; exit}')"
rm -rf "${GNUPGHOME}"
if [ "${FPR}" != "${DOCKER_GPG_FINGERPRINT}" ]; then
	echo "Docker-Schlüssel: Fingerprint ${FPR} != ${DOCKER_GPG_FINGERPRINT}" >&2
	exit 1
fi

install -D -m 0644 "${KEY}" "${ROOTFS_DIR}/etc/apt/keyrings/docker.asc"
cat >"${ROOTFS_DIR}/etc/apt/sources.list.d/docker.sources" <<SRC
Types: deb
URIs: ${DOCKER_APT_URL}
Suites: ${RELEASE}
Components: stable
Architectures: arm64
Signed-By: /etc/apt/keyrings/docker.asc
SRC

on_chroot <<CHROOT
apt-get -o Acquire::Retries=3 update
CHROOT
