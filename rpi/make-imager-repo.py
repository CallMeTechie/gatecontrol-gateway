#!/usr/bin/env python3
"""Erzeugt die Repository-Datei für den Raspberry Pi Imager.

Ein "eigenes Image" (Datei) lässt sich im Raspberry Pi Imager 2.x NICHT
anpassen (Benutzer, WLAN, SSH) – das geht nur für Images aus einer
Repository-Liste mit init_format "cloudinit-rpi". Deshalb hängt jedes
Release zusätzlich gatecontrol-rpi-imager.json an; im Imager unter
"App-Optionen → Content Repository → Use custom URL" eingetragen, erscheint
das Gateway-Image mit allen Imager-Einstellungen.

    make-imager-repo.py --version 1.17.0 --image X.img.xz --extract X.img.extract \
        --url https://github.com/…/X.img.xz --release-date 2026-11-04 --out gatecontrol-rpi-imager.json
"""

import argparse
import hashlib
import json
import os
import re
import sys

ICON = "https://downloads.raspberrypi.com/imager/icons/RPi_4.png"
DEVICES = [
    {"name": "Raspberry Pi 5", "tags": ["pi5-64bit"], "icon": "https://downloads.raspberrypi.com/imager/icons/RPi_5.png",
     "description": "Raspberry Pi 5, 500 / 500+ und Compute Module 5", "matching_type": "exclusive", "capabilities": []},
    {"name": "Raspberry Pi 4", "tags": ["pi4-64bit"], "icon": "https://downloads.raspberrypi.com/imager/icons/RPi_4.png",
     "description": "Raspberry Pi 4 Model B, 400 und Compute Module 4 / 4S", "matching_type": "inclusive", "capabilities": []},
    {"name": "Raspberry Pi 3", "tags": ["pi3-64bit"], "default": True, "icon": "https://downloads.raspberrypi.com/imager/icons/RPi_3.png",
     "description": "Raspberry Pi 3 Model A+ / B / B+ und Compute Module 3 / 3+", "matching_type": "inclusive", "capabilities": []},
    {"name": "Raspberry Pi Zero 2 W", "tags": ["pi3-64bit"], "icon": "https://downloads.raspberrypi.com/imager/icons/RPi_Zero_2_W.png",
     "description": "Raspberry Pi Zero 2 W", "matching_type": "inclusive", "capabilities": []},
]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_extract(path):
    vals = {}
    with open(path, encoding="ascii") as fh:
        for line in fh:
            if "=" in line:
                k, v = line.strip().split("=", 1)
                vals[k] = v
    size, digest = int(vals["extract_size"]), vals["extract_sha256"]
    if size <= 0 or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("ungültige extract-Werte")
    return size, digest


def build(version, image, extract, url, release_date):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", release_date):
        raise ValueError("release_date muss YYYY-MM-DD sein")
    if not url.startswith("https://"):
        raise ValueError("url muss https sein")
    size, digest = read_extract(extract)
    entry = {
        "name": f"GateControl Gateway {version}",
        "description": "Raspberry Pi OS Lite (64 bit) mit GateControl Home Gateway und optional deCONZ für RaspBee II / ConBee",
        "icon": ICON,
        "website": "https://github.com/CallMeTechie/gatecontrol-gateway/blob/main/docs/deployment/raspberry-pi.md",
        "url": url,
        "extract_size": size,
        "extract_sha256": digest,
        "image_download_size": os.path.getsize(image),
        "image_download_sha256": sha256_file(image),
        "release_date": release_date,
        "init_format": "cloudinit-rpi",
        "devices": ["pi5-64bit", "pi4-64bit", "pi3-64bit"],
        "capabilities": [],
    }
    return {"imager": {"devices": DEVICES}, "os_list": [entry]}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--extract", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--release-date", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    doc = build(a.version, a.image, a.extract, a.url, a.release_date)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
