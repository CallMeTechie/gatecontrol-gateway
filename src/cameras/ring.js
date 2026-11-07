'use strict';

// Der HLS-Ring einer Kamera im tmpfs (/gc-cam/media/<id>/, geschrieben von
// ffmpeg im Dienst kameras): Liste lesen, Dateien sicher öffnen (nur diese
// Namen, keine Links, Größengrenzen).

const fs = require('node:fs');
const path = require('node:path');

const FILE_RE = /^(init\.mp4|s[0-9]{1,9}\.m4s|index\.m3u8|snap\.jpg)$/;
const SEG_RE = /^s[0-9]{1,9}\.m4s$/;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_LIST = 64 * 1024;

/** index.m3u8 → { target, sequence, segments: [{ seq, name, duration, at }] } */
function parsePlaylist(text) {
  const out = { target: 2, sequence: 0, segments: [] };
  let dur = null;
  let at = null;
  let seq = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    let m;
    if ((m = /^#EXT-X-TARGETDURATION:(\d+)/.exec(l))) out.target = Number(m[1]);
    else if ((m = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(l))) { out.sequence = Number(m[1]); seq = out.sequence; }
    else if ((m = /^#EXTINF:([0-9.]+)/.exec(l))) dur = Number(m[1]);
    else if ((m = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/.exec(l))) { const t = Date.parse(m[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); at = Number.isFinite(t) ? t : null; }
    else if (!l.startsWith('#')) {
      if (SEG_RE.test(l) && Number.isFinite(dur)) out.segments.push({ seq, name: l, duration: dur, at });
      seq++;
      dur = null;
      at = null;
    }
  }
  return out;
}

class Ring {
  constructor(dir) { this.dir = dir; }

  file(name) {
    if (!FILE_RE.test(name)) return null;
    return path.join(this.dir, name);
  }

  /** Datei lesen (null: fehlt, zu groß, kein normales File). */
  read(name, max = MAX_FILE) {
    const p = this.file(name);
    if (!p) return null;
    let fd;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > max) return null;
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      return off === st.size ? buf : buf.subarray(0, off);
    } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
  }

  mtime(name) {
    const p = this.file(name);
    try { return p ? fs.statSync(p).mtimeMs : null; } catch { return null; }
  }

  playlist() {
    const b = this.read('index.m3u8', MAX_LIST);
    return b ? parsePlaylist(b.toString('utf8')) : null;
  }
}

module.exports = { Ring, parsePlaylist, FILE_RE, SEG_RE };
