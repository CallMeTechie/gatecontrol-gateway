'use strict';

// gc.store je Plugin (Vertrag Abschnitt 5): ein JSON-Objekt ≤ 1 MB in einer
// Datei im eigenen Ordner des Plugins (/state-edge/data/<id>/store.json).
// Der Edge-Host liest und schreibt die Datei – der Plugin-Prozess selbst hat
// keine Schreibrechte im Dateisystem.

const fs = require('node:fs');
const path = require('node:path');
const { LIMITS, assertId } = require('./constants');

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

class StoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class PluginStore {
  constructor(dataDir, id, { maxBytes = LIMITS.storeBytes } = {}) {
    this.dir = path.join(dataDir, assertId(id));
    this.file = path.join(this.dir, 'store.json');
    this.maxBytes = maxBytes;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const obj = JSON.parse(raw);
      this.data = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }

  static key(k) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) throw new StoreError('bad_key', 'store key must match [A-Za-z0-9._:-]{1,128}');
    return k;
  }

  get(k) {
    const d = this.load();
    return Object.prototype.hasOwnProperty.call(d, PluginStore.key(k)) ? d[k] : null;
  }

  set(k, value) {
    PluginStore.key(k);
    if (value === undefined) return this.delete(k);
    const next = { ...this.load(), [k]: value };
    this.write(next);
  }

  delete(k) {
    PluginStore.key(k);
    const d = this.load();
    if (!Object.prototype.hasOwnProperty.call(d, k)) return;
    const next = { ...d };
    delete next[k];
    this.write(next);
  }

  write(next) {
    const body = JSON.stringify(next);
    if (Buffer.byteLength(body, 'utf8') > this.maxBytes) throw new StoreError('too_large', `store is limited to ${this.maxBytes} bytes`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.data = next;
  }
}

module.exports = { PluginStore, StoreError };
