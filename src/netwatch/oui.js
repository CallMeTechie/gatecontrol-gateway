'use strict';

// Hersteller zu einer MAC-Adresse aus der eingecheckten IEEE-Liste (oui.txt,
// erzeugt mit scripts/update-oui.js). Sparsam für den Pi: die Datei bleibt
// ein Buffer (≈ 1 MB, außerhalb des JS-Heaps), dazu ein Uint32Array mit den
// Zeilenanfängen (≈ 160 kB); gesucht wird binär auf den ersten 6 Zeichen.
// Geladen wird erst beim ersten Aufruf.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILE = path.join(__dirname, 'oui.txt');

function makeOuiLookup(file = DEFAULT_FILE) {
  let buf = null;
  let starts = null;
  let failed = false;

  function load() {
    if (buf || failed) return;
    try {
      buf = fs.readFileSync(file);
    } catch (_e) {
      failed = true;
      return;
    }
    const tmp = [];
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(10, pos);
      const end = nl === -1 ? buf.length : nl;
      // Datenzeile: 6 Hex-Zeichen + TAB; Kommentare (#) und Leerzeilen überspringen
      if (end - pos > 7 && buf[pos] !== 35 && buf[pos + 6] === 9) tmp.push(pos);
      pos = end + 1;
    }
    starts = Uint32Array.from(tmp);
  }

  /** "aa:bb:cc:…" → Herstellername oder null. */
  function lookup(mac) {
    const hex = String(mac || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toUpperCase();
    if (hex.length !== 6) return null;
    load();
    if (!starts || starts.length === 0) return null;
    const key = Buffer.from(hex, 'ascii');
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const s = starts[mid];
      const cmp = buf.compare(key, 0, 6, s, s + 6); // >0: Zeile > key
      if (cmp === 0) {
        let end = buf.indexOf(10, s);
        if (end === -1) end = buf.length;
        return buf.toString('utf8', s + 7, end).trim() || null;
      }
      if (cmp > 0) hi = mid - 1; else lo = mid + 1;
    }
    return null;
  }

  return { lookup, size: () => { load(); return starts ? starts.length : 0; } };
}

module.exports = { makeOuiLookup };
