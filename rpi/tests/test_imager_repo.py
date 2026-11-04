"""Tests für rpi/make-imager-repo.py (Repository-Datei für den Raspberry Pi Imager)."""

import hashlib
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("mkrepo", os.path.join(HERE, "..", "make-imager-repo.py"))
mkrepo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mkrepo)


class ImagerRepoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.image = os.path.join(d, "x.img.xz")
        with open(self.image, "wb") as fh:
            fh.write(b"compressed")
        self.extract = os.path.join(d, "x.img.extract")
        with open(self.extract, "w", encoding="ascii") as fh:
            fh.write("extract_size=3078619136\nextract_sha256=" + "ab" * 32 + "\n")
        self.out = os.path.join(d, "repo.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_document(self):
        mkrepo.main(["--version", "1.17.0", "--image", self.image, "--extract", self.extract,
                     "--url", "https://github.com/x/y/releases/download/v1.17.0/x.img.xz",
                     "--release-date", "2026-11-04", "--out", self.out])
        with open(self.out, encoding="utf-8") as fh:
            doc = json.load(fh)
        entry = doc["os_list"][0]
        self.assertEqual(entry["init_format"], "cloudinit-rpi")  # Imager-Anpassung (Benutzer/WLAN/SSH)
        self.assertEqual(entry["extract_size"], 3078619136)
        self.assertEqual(entry["image_download_size"], len(b"compressed"))
        self.assertEqual(entry["image_download_sha256"], hashlib.sha256(b"compressed").hexdigest())
        self.assertIn("pi3-64bit", entry["devices"])
        self.assertTrue(any("pi3-64bit" in d["tags"] for d in doc["imager"]["devices"]))
        for key in ("name", "description", "icon", "url", "extract_sha256", "release_date"):
            self.assertIn(key, entry)

    def test_rejects_http_and_bad_date(self):
        with self.assertRaises(ValueError):
            mkrepo.build("1", self.image, self.extract, "http://x/y.img.xz", "2026-11-04")
        with self.assertRaises(ValueError):
            mkrepo.build("1", self.image, self.extract, "https://x/y.img.xz", "04.11.2026")


if __name__ == "__main__":
    unittest.main()
