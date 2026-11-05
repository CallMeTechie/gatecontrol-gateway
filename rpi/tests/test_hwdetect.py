"""Tests für rpi/rootfs/usr/local/sbin/gatecontrol-hwdetect.

Ein Pseudo-Terminal spielt das Funkmodul: es beantwortet den VERSION-Request
des deCONZ-Serial-Protokolls (oder schweigt, wie ein freier UART).

    python3 -m unittest discover -s rpi/tests -p 'test_*.py'
"""

import importlib.machinery
import importlib.util
import os
import pty
import threading
import tty
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "rootfs", "usr", "local", "sbin", "gatecontrol-hwdetect")

_loader = importlib.machinery.SourceFileLoader("gc_hwdetect", SCRIPT)
_spec = importlib.util.spec_from_loader("gc_hwdetect", _loader)
hw = importlib.util.module_from_spec(_spec)
_loader.exec_module(hw)


def version_response(seq, version):
    body = bytes([hw.CMD_VERSION, seq, 0x00, 0x09, 0x00]) + version.to_bytes(4, "little")
    crc = hw._crc(body)
    frame = body + bytes([crc & 0xFF, crc >> 8])
    out = bytearray([hw.SLIP_END])
    for b in frame:
        if b == hw.SLIP_END:
            out += bytes([hw.SLIP_ESC, hw.SLIP_ESC_END])
        elif b == hw.SLIP_ESC:
            out += bytes([hw.SLIP_ESC, hw.SLIP_ESC_ESC])
        else:
            out.append(b)
    out.append(hw.SLIP_END)
    return bytes(out)


class FakeModule:
    """Antwortet auf einen VERSION-Request (version=None: bleibt stumm)."""

    def __init__(self, version, noise=b""):
        self.master, slave = pty.openpty()
        tty.setraw(slave)
        self.device = os.ttyname(slave)
        self._slave = slave
        self.version = version
        self.noise = noise
        self.requests = []
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        buf = bytearray()
        while True:
            try:
                chunk = os.read(self.master, 64)
            except OSError:
                return
            buf += chunk
            frames = list(hw.slip_frames(buf))
            if frames:
                buf.clear()
            for frame in frames:
                self.requests.append(frame)
                if self.version is not None and frame[0] == hw.CMD_VERSION:
                    os.write(self.master, self.noise + version_response(frame[1], self.version))

    def close(self):
        os.close(self.master)
        os.close(self._slave)


class ProtocolTest(unittest.TestCase):
    def test_request_frame(self):
        req = hw.build_version_request(seq=1)
        self.assertEqual(req[0], hw.SLIP_END)
        self.assertEqual(req[-1], hw.SLIP_END)
        frame = next(hw.slip_frames(req))
        self.assertEqual(frame[:5], bytes([0x0D, 0x01, 0x00, 0x09, 0x00]))
        self.assertEqual(hw._crc(frame[:-2]), frame[-2] | (frame[-1] << 8))

    def test_parse_valid_and_escaped(self):
        # 0x26C0DB07: enthält END und ESC → SLIP-Escaping wird geprüft
        ver = 0x26C0DB07
        frame = next(hw.slip_frames(version_response(3, ver)))
        self.assertEqual(hw.parse_version_response(frame), ver)

    def test_parse_rejects_bad_crc_and_other_commands(self):
        frame = bytearray(next(hw.slip_frames(version_response(1, 0x26780700))))
        frame[-1] ^= 0xFF
        self.assertIsNone(hw.parse_version_response(bytes(frame)))
        self.assertIsNone(hw.parse_version_response(bytes([0x0E, 1, 0, 7, 0, 0x22, 0, 0, 0])))

    def test_platform_names(self):
        self.assertEqual(hw.platform_name(0x26780700), "raspbee2-conbee2")
        self.assertEqual(hw.platform_name(0x26400500), "raspbee-conbee-1")
        self.assertEqual(hw.platform_name(0x26720900), "conbee3")


class ProbeTest(unittest.TestCase):
    def test_raspbee_answers(self):
        mod = FakeModule(0x26780700, noise=b"\x00\xc0\x0e\x01\x00")
        try:
            self.assertEqual(hw.probe_deconz(mod.device, bauds=(38400,), timeout=1.0), 0x26780700)
        finally:
            mod.close()

    def test_silent_uart(self):
        mod = FakeModule(None)
        try:
            self.assertIsNone(hw.probe_deconz(mod.device, bauds=(38400,), timeout=0.3))
            self.assertGreaterEqual(len(mod.requests), 1)
        finally:
            mod.close()

    def test_missing_device(self):
        self.assertIsNone(hw.probe_deconz("/dev/does-not-exist", bauds=(38400,), timeout=0.1))


class DetectTest(unittest.TestCase):
    def setUp(self):
        self._usb = hw.usb_candidates
        hw.usb_candidates = lambda: []

    def tearDown(self):
        hw.usb_candidates = self._usb

    def test_off(self):
        r = hw.detect_zigbee({"ZIGBEE": "off"})
        self.assertFalse(r["enabled"])
        self.assertIsNone(r["device"])

    def test_forced_device_detected(self):
        mod = FakeModule(0x26780700)
        try:
            r = hw.detect_zigbee({"ZIGBEE": "auto", "ZIGBEE_DEVICE": mod.device})
        finally:
            mod.close()
        self.assertTrue(r["detected"])
        self.assertTrue(r["enabled"])
        self.assertEqual(r["type"], "raspbee2-conbee2")
        self.assertEqual(r["firmware"], "0x26780700")

    def test_on_without_answer_still_enabled(self):
        mod = FakeModule(None)
        try:
            r = hw.detect_zigbee({"ZIGBEE": "on", "ZIGBEE_DEVICE": mod.device})
        finally:
            mod.close()
        self.assertFalse(r["detected"])
        self.assertTrue(r["enabled"])
        self.assertEqual(r["type"], "forced")

    def test_invalid_forced_path_ignored(self):
        r = hw.detect_zigbee({"ZIGBEE": "on", "ZIGBEE_DEVICE": "/dev/x;rm -rf /"})
        self.assertNotIn(";", r["device"] or "")

    def test_settings_parser(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8-sig") as fh:
            fh.write('# Kommentar\r\nzigbee = "off"\r\nHOSTNAME=x\r\n')
        try:
            self.assertEqual(hw.read_settings(fh.name), {"ZIGBEE": "off", "HOSTNAME": "x"})
        finally:
            os.unlink(fh.name)

    def test_hardware_profile_shape(self):
        p = hw.hardware_profile({"kind": "zigbee", "device": "/dev/ttyAMA0", "type": "raspbee2-conbee2",
                                 "firmware": "0x26780700", "detected": True, "enabled": True, "mode": "auto"})
        self.assertEqual(p["schema"], 1)
        self.assertEqual(p["source"], "rpi-image")
        self.assertEqual(len(p["radios"]), 1)
        self.assertIsInstance(p["cpu_cores"], int)

        self.assertIsInstance(p["disks"], list)

    def test_disks(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            sysb = os.path.join(d, "sys")
            for dev, rem in (("sda", "0"), ("sdb", "1"), ("mmcblk0", "1")):
                os.makedirs(os.path.join(sysb, dev))
                with open(os.path.join(sysb, dev, "removable"), "w", encoding="ascii") as fh:
                    fh.write(rem + "\n")
            usb = os.path.join(d, "devices", "usb1", "sdc")
            os.makedirs(usb)
            os.symlink(usb, os.path.join(sysb, "sdc"))
            mnt = os.path.join(d, "mnt usb")
            os.makedirs(mnt)
            mounts = os.path.join(d, "mounts")
            esc = mnt.replace(" ", "\\040")
            with open(mounts, "w", encoding="utf-8") as fh:
                fh.write("/dev/mmcblk0p2 / ext4 rw 0 0\n"
                         "proc /proc proc rw 0 0\n"
                         "/dev/mmcblk0p1 /boot/firmware vfat rw 0 0\n"
                         f"/dev/sdb1 {esc} exfat rw 0 0\n"
                         f"/dev/sda1 {d} ext4 rw 0 0\n"
                         f"/dev/sdc1 {d}/devices ext4 rw 0 0\n"
                         "tmpfs /tmp tmpfs rw 0 0\n")
            got = {x["mount"]: x["removable"] for x in hw.disks(mounts, sysb)}
            self.assertEqual(got, {"/": False, mnt: True, d: False, d + "/devices": True})
            self.assertTrue(all(x["sizeBytes"] > 0 for x in hw.disks(mounts, sysb)))
        self.assertEqual(hw._base_device("/dev/nvme0n1p1"), "nvme0n1")


if __name__ == "__main__":
    unittest.main()
