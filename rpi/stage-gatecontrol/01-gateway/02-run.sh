#!/bin/bash -e
# Raspberry-Pi-spezifisch: UART für RaspBee II freigeben, serielle Konsole
# abschalten. Alles bleibt auf der Boot-Partition editierbar.

CONFIG="${ROOTFS_DIR}/boot/firmware/config.txt"
CMDLINE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"

if ! grep -q 'GateControl Gateway' "${CONFIG}"; then
	cat >>"${CONFIG}" <<'TXT'

# --- GateControl Gateway: UART für RaspBee II (Zigbee auf der GPIO-Leiste) + Bluetooth ---
# Pi 3/3B+/4/Zero 2 W: Bluetooth auf den Mini-UART legen (miniuart-bt), damit
# /dev/ttyAMA0 (PL011) an GPIO 14/15 frei für den RaspBee ist und Bluetooth
# trotzdem läuft (GateControl hört damit Bluetooth-Sensoren passiv mit, docs/radio.md).
# Der Mini-UART braucht einen festen Kerntakt (core_freq = core_freq_min).
# Ohne Bluetooth: miniuart-bt durch disable-bt ersetzen.
[pi3]
core_freq=250
core_freq_min=250
dtoverlay=miniuart-bt,krnbt=on
[pi02]
core_freq=250
core_freq_min=250
dtoverlay=miniuart-bt,krnbt=on
[pi4]
core_freq=500
core_freq_min=500
dtoverlay=miniuart-bt,krnbt=on
[pi5]
# Pi 5: GPIO 14/15 = UART0 → /dev/ttyAMA0 (Bluetooth hat einen eigenen UART)
dtparam=uart0=on
[all]
enable_uart=1
TXT
fi

# Keine Login-Konsole auf dem UART: dort spricht das Zigbee-Modul.
sed -i -e 's/console=serial0,[0-9]* //' -e 's/console=ttyAMA0,[0-9]* //' "${CMDLINE}"
if grep -q 'console=serial0\|console=ttyAMA0' "${CMDLINE}"; then
	echo "serielle Konsole noch in cmdline.txt" >&2
	exit 1
fi

on_chroot <<CHROOT
# Bluetooth bindet der Kernel selbst an (krnbt=on); das ältere hciattach von
# pi-bluetooth würde sonst um den UART streiten bzw. beim Start scheitern.
if systemctl list-unit-files hciuart.service >/dev/null 2>&1; then
	systemctl disable hciuart.service || true
fi
systemctl mask serial-getty@ttyAMA0.service
CHROOT
