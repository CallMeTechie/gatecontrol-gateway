'use strict';

// Telemetrie `storage` (Vertrag Phase 3b §3): eingehängte Datenträger
// [{ mount, fs, sizeBytes, freeBytes, removable }]. Der Container sieht nur
// seine eigenen Einhängungen (z. B. das /cache-Volume); was der Host darüber
// hinaus hat, liefert auf dem Pi-Image gatecontrol-hwdetect beim Start in
// /state/hardware.json (`disks`; hier mit origin 'host').

const fs = require('node:fs');
const path = require('node:path');

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'f2fs', 'zfs', 'hfsplus', 'apfs']);
const SKIP_PREFIX = ['/proc', '/sys', '/dev', '/run', '/etc', '/boot', '/var/lib/docker', '/tmp'];
const MAX = 16;

/** Feld aus mountinfo entschlüsseln (\040 = Leerzeichen …). */
function unescape(s) {
  return s.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));
}

/** /proc/self/mountinfo → [{ mount, fs, source }] (nur echte Dateisysteme auf Blockgeräten). */
function parseMountinfo(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep === -1) continue;
    const left = line.slice(0, sep).split(' ');
    const right = line.slice(sep + 3).split(' ');
    if (left.length < 5 || right.length < 2) continue;
    const mount = unescape(left[4]);
    const fsType = right[0];
    const source = unescape(right[1]);
    if (!REAL_FS.has(fsType) || !source.startsWith('/dev/')) continue;
    if (SKIP_PREFIX.some((p) => mount === p || mount.startsWith(`${p}/`))) continue;
    if (seen.has(mount)) continue;
    seen.add(mount);
    out.push({ mount, fs: fsType, source });
  }
  return out;
}

/** /dev/sda1 → sda, /dev/mmcblk0p2 → mmcblk0, /dev/nvme0n1p1 → nvme0n1 */
function baseDevice(source) {
  const n = path.basename(source);
  let m = /^(mmcblk\d+|nvme\d+n\d+)(p\d+)?$/.exec(n);
  if (m) return m[1];
  m = /^([a-z]+)\d*$/.exec(n);
  return m ? m[1] : null;
}

function isRemovable(source, { readFile = fs.readFileSync, realpath = fs.realpathSync } = {}) {
  const dev = baseDevice(source);
  if (!dev || dev.startsWith('mmcblk')) return false; // SD-Karte = Systemträger
  try { if (String(readFile(`/sys/class/block/${dev}/removable`, 'utf8')).trim() === '1') return true; } catch (_e) { /* unbekannt */ }
  try { return realpath(`/sys/class/block/${dev}`).includes('/usb'); } catch (_e) { return false; }
}

function containerStorage({ readFile = fs.readFileSync, statfs = fs.statfsSync, stat = fs.statSync, realpath = fs.realpathSync } = {}) {
  let text;
  try { text = readFile('/proc/self/mountinfo', 'utf8'); } catch (_e) { return []; }
  const out = [];
  for (const m of parseMountinfo(text)) {
    try {
      if (!stat(m.mount).isDirectory()) continue;
      const st = statfs(m.mount);
      out.push({
        mount: m.mount, fs: m.fs, sizeBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize,
        removable: isRemovable(m.source, { readFile, realpath }), origin: 'container',
      });
    } catch (_e) { /* nicht lesbar */ }
    if (out.length >= MAX) break;
  }
  return out;
}

/** Host-Angaben (hardware.json `disks`) säubern. */
function hostStorage(host) {
  if (!host || !Array.isArray(host.disks)) return [];
  const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  return host.disks.slice(0, MAX).filter((s) => s && typeof s.mount === 'string' && s.mount.startsWith('/') && s.mount.length <= 256)
    .map((s) => ({
      mount: s.mount, fs: typeof s.fs === 'string' ? s.fs.slice(0, 16) : null,
      sizeBytes: num(s.sizeBytes), freeBytes: num(s.freeBytes), removable: s.removable === true, origin: 'host',
    }));
}

function collectStorage({ host = null, ...io } = {}) {
  return [...containerStorage(io), ...hostStorage(host)].slice(0, MAX * 2);
}

module.exports = { collectStorage, parseMountinfo, baseDevice, isRemovable, hostStorage, containerStorage };
