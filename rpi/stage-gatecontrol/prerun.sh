#!/bin/bash -e
# pi-gen: diese Stufe baut auf dem Root-Dateisystem von stage2 (Lite) auf.
if [ ! -d "${ROOTFS_DIR}" ]; then
	copy_previous
fi
