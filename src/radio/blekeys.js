'use strict';

// Schlüssel verschlüsselter Bluetooth-Sensoren (docs/radio.md „Verschlüsselte Sensoren“):
// vom Server über GET /api/v1/gateway/radio/ble/keys, nur wenn sich der Stand
// `features.radio.bleKeys` im Config-Pull geändert hat – nie im Config-Pull selbst.
// Im Speicher und verschlüsselt in /state/radio-ble-keys.bin (0600, AES-256-GCM,
// Schlüssel per HKDF aus dem Gateway-Token, wie bei den Kamera-Zugängen), damit
// ein Neustart ohne Server weiterläuft. Nie im Log.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const axios = require('axios');

const FILE = 'radio-ble-keys.bin';
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function keyOf(apiToken) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(apiToken || ''), 'utf8'), Buffer.from('gatecontrol-radio', 'utf8'), Buffer.from('ble-keys-v1', 'utf8'), 32));
}

/** Server-Antwort prüfen → { rev, keys: Map(MAC → hex) } (höchstens 64). */
function parse(data) {
  const out = new Map();
  const k = data && typeof data === 'object' && data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys) ? data.keys : {};
  for (const [mac, v] of Object.entries(k).slice(0, 64)) {
    const m = String(mac).toUpperCase();
    const hex = typeof v === 'string' ? v.toLowerCase() : '';
    if (MAC_RE.test(m) && KEY_RE.test(hex)) out.set(m, hex);
  }
  return { rev: data && typeof data.rev === 'string' && /^[0-9a-f]{8,64}$/.test(data.rev) ? data.rev : null, keys: out };
}

class BleKeyStore {
  constructor({ serverUrl = null, apiToken = null, stateDir = null, fetcher = null } = {}) {
    Object.assign(this, { serverUrl, apiToken, stateDir });
    this.key = keyOf(apiToken);
    this.rev = null;
    this.map = new Map();
    this.busy = null;
    this.fetcher = fetcher || (async () => {
      if (!this.serverUrl) throw new Error('no server');
      const r = await axios.get(`${this.serverUrl}/api/v1/gateway/radio/ble/keys`, {
        headers: { Authorization: `Bearer ${this.apiToken}` }, timeout: 15_000, httpAgent, httpsAgent, maxRedirects: 0, maxContentLength: 64 * 1024,
      });
      return r.data;
    });
    this._load();
  }

  _file() { return this.stateDir ? path.join(this.stateDir, FILE) : null; }

  _load() {
    const f = this._file();
    if (!f) return;
    try {
      const b = fs.readFileSync(f);
      if (b.length < 29) return;
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      const p = parse(JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')));
      this.rev = p.rev;
      this.map = p.keys;
    } catch { /* fehlt oder anderes Token: neu vom Server */ }
  }

  _save() {
    const f = this._file();
    if (!f) return;
    try {
      if (!this.map.size) { fs.rmSync(f, { force: true }); return; }
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
      const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify({ rev: this.rev, keys: Object.fromEntries(this.map) }), 'utf8')), c.final()]);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch { /* best effort: dann nur im Speicher */ }
  }

  /** Stand aus dem Config-Pull: null = keine Schlüssel; sonst neu holen, wenn er sich geändert hat. → Promise<boolean> frisch */
  sync(rev) {
    if (!rev) {
      const had = this.map.size > 0;
      this.map = new Map();
      this.rev = null;
      if (had) this._save();
      return Promise.resolve(had);
    }
    if (rev === this.rev) return Promise.resolve(false);
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const p = parse(await this.fetcher());
      this.rev = p.rev || rev;
      this.map = p.keys;
      this._save();
      return true;
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  get(mac) { return this.map.get(String(mac || '').toUpperCase()) || null; }
  has(mac) { return this.map.has(String(mac || '').toUpperCase()); }
  get size() { return this.map.size; }
}

module.exports = { BleKeyStore, parse, keyOf, FILE };
