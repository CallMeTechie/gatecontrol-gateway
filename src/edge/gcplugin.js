'use strict';

// Leser für das .gcplugin-Paketformat des Servers (gatecontrol
// src/services/plugins/package.js, docs/plugins.md "Package format"):
//
//   gzip( "GCPLUGIN" 0x00 0x01 | entry* | u16 0 )
//   entry = u16 pathLength | path (UTF-8) | u32 size | bytes
//
// Gleiche Prüfungen wie der Server: Pfade (relativ, Segmente
// [A-Za-z0-9._-], keine ./../versteckten Segmente, ≤ 200 Zeichen, ≤ 12
// Ebenen, keine Duplikate – auch nicht nur in Groß/Klein –, keine
// Datei/Ordner-Kollision), Größe vor und nach gunzip, Dateizahl, keine Daten
// hinter dem Ende. Das Gateway prüft selbst, statt dem Server zu glauben.

const zlib = require('node:zlib');
const { LIMITS } = require('./constants');

const MAGIC = Buffer.from([0x47, 0x43, 0x50, 0x4c, 0x55, 0x47, 0x49, 0x4e, 0x00, 0x01]);
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

class PackageError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function checkPath(p) {
  if (typeof p !== 'string' || !p || p.length > LIMITS.pathLength) throw new PackageError('bad_path', 'invalid path');
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) throw new PackageError('bad_path', 'invalid path: ' + p);
  const segs = p.split('/');
  if (segs.length > LIMITS.pathDepth) throw new PackageError('bad_path', 'path too deep: ' + p);
  for (const s of segs) {
    if (s === '.' || s === '..' || !SEGMENT_RE.test(s)) throw new PackageError('bad_path', 'invalid path: ' + p);
  }
  return p;
}

/** Paket bauen (nur für Tests und Werkzeuge). */
function encode(files) {
  const list = (files instanceof Map ? [...files] : files)
    .map(([p, d]) => [checkPath(p), Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')]);
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts = [MAGIC];
  for (const [p, d] of list) {
    const name = Buffer.from(p, 'utf8');
    const h = Buffer.alloc(2);
    h.writeUInt16BE(name.length);
    const s = Buffer.alloc(4);
    s.writeUInt32BE(d.length);
    parts.push(h, name, s, d);
  }
  parts.push(Buffer.alloc(2));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** Paket in den Speicher lesen. Berührt nie das Dateisystem. */
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.byteLength < 20) throw new PackageError('not_a_package', 'not a .gcplugin file');
  if (buf.byteLength > LIMITS.packageBytes) throw new PackageError('too_large', 'package too large');
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new PackageError('not_a_package', 'not a .gcplugin file');
  let raw;
  try {
    raw = zlib.gunzipSync(buf, { maxOutputLength: LIMITS.unpackedBytes + 64 * 1024 + LIMITS.fileCount * (LIMITS.pathLength + 6) });
  } catch (e) {
    if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) throw new PackageError('too_large', 'package too large when unpacked');
    throw new PackageError('corrupt', 'package is damaged');
  }
  if (raw.length < MAGIC.length + 2 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new PackageError('not_a_package', 'not a .gcplugin file');
  const files = new Map();
  const seen = new Set();
  let off = MAGIC.length;
  let total = 0;
  for (;;) {
    if (off + 2 > raw.length) throw new PackageError('corrupt', 'package is damaged');
    const nameLen = raw.readUInt16BE(off);
    off += 2;
    if (nameLen === 0) break;
    if (nameLen > LIMITS.pathLength || off + nameLen + 4 > raw.length) throw new PackageError('corrupt', 'package is damaged');
    const name = raw.toString('utf8', off, off + nameLen);
    off += nameLen;
    checkPath(name);
    const size = raw.readUInt32BE(off);
    off += 4;
    if (off + size > raw.length) throw new PackageError('corrupt', 'package is damaged');
    total += size;
    if (total > LIMITS.unpackedBytes) throw new PackageError('too_large', 'package too large when unpacked');
    if (seen.has(name.toLowerCase())) throw new PackageError('duplicate', 'duplicate path: ' + name);
    seen.add(name.toLowerCase());
    files.set(name, Buffer.from(raw.subarray(off, off + size)));
    off += size;
    if (files.size > LIMITS.fileCount) throw new PackageError('too_many_files', 'too many files');
  }
  if (off !== raw.length) throw new PackageError('corrupt', 'trailing data after the package end');
  for (const name of files.keys()) {
    const segs = name.split('/');
    for (let i = 1; i < segs.length; i++) {
      if (seen.has(segs.slice(0, i).join('/').toLowerCase())) throw new PackageError('bad_path', 'file and folder of the same name: ' + name);
    }
  }
  return files;
}

module.exports = { encode, decode, checkPath, PackageError, MAGIC };
