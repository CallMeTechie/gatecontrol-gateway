#!/bin/bash -e
# Raspberry-Pi-spezifisch: UART für RaspBee II freigeben, serielle Konsole
# abschalten. Alles bleibt auf der Boot-Partition editierbar.

CONFIG="${ROOTFS_DIR}/boot/firmware/config.txt"
CMDLINE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"

if ! grep -q 'GateControl Gateway' "${CONFIG}"; then
	cat >>"${CONFIG}" <<'TXT'

# --- GateControl Gateway: UART für RaspBee II (Zigbee auf der GPIO-Leiste) ---
# Pi 3/3B+/4/Zero 2 W: Bluetooth vom PL011-UART lösen, damit /dev/ttyAMA0
# an GPIO 14/15 frei ist. Wer Bluetooth braucht (und keinen RaspBee nutzt),
# ersetzt "disable-bt" durch "miniuart-bt" (Pi 3: zusätzlich core_freq=250).
[all]
enable_uart=1
dtoverlay=disable-bt
[pi5]
# Pi 5: GPIO 14/15 = UART0 → /dev/ttyAMA0 (Bluetooth hängt hier nicht dran)
dtparam=uart0=on
[all]
TXT
fi

# Keine Login-Konsole auf dem UART: dort spricht das Zigbee-Modul.
sed -i -e 's/console=serial0,[0-9]* //' -e 's/console=ttyAMA0,[0-9]* //' "${CMDLINE}"
if grep -q 'console=serial0\|console=ttyAMA0' "${CMDLINE}"; then
	echo "serielle Konsole noch in cmdline.txt" >&2
	exit 1
fi

on_chroot <<CHROOT
# Älteres pi-bluetooth würde sonst das UART belegen bzw. beim Start scheitern.
if systemctl list-unit-files hciuart.service >/dev/null 2>&1; then
	systemctl disable hciuart.service || true
fi
systemctl mask serial-getty@ttyAMA0.service
CHROOT
