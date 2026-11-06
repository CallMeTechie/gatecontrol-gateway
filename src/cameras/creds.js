'use strict';

// Zugänge der Kameras (docs/cameras.md §2): vom Server über
// GET /api/v1/gateway/cameras/credentials, im Speicher und verschlüsselt in
// /state/cameras-cred.bin (0600, AES-256-GCM, Schlüssel per HKDF aus dem
// Gateway-Token) – damit ein Neustart ohne Server weiterläuft. Nie im Log.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const http = require('node:http');
const https = require('node:https');
const { ID_RE } = require('./config');

const FILE = 'cameras-cred.bin';
const MAX_USER = 64;
const MAX_PASS = 128;
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function keyOf(apiToken) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(apiToken || ''), 'utf8'), Buffer.from('gatecontrol-cameras', 'utf8'), Buffer.from('cameras-cred-v1', 'utf8'), 32));
}

/** Server-Antwort prüfen → { rev, cameras: Map(id → { user, password }) } */
function parse(data) {
  const out = new Map();
  const c = data && typeof data === 'object' && data.cameras && typeof data.cameras === 'object' ? data.cameras : {};
  for (const [id, v] of Object.entries(c).slice(0, 64)) {
    if (!ID_RE.test(id) || !v || typeof v !== 'object') continue;
    const user = typeof v.user === 'string' ? v.user.slice(0, MAX_USER) : '';
    const password = typeof v.password === 'string' ? v.password.slice(0, MAX_PASS) : '';
    if (/[\r\n\0]/.test(user + password)) continue;
    out.set(id, { user, password });
  }
  return { rev: data && typeof data.rev === 'string' && /^[0-9a-f]{8,64}$/.test(data.rev) ? data.rev : null, cameras: out };
}

class CredStore {
  constructor({ serverUrl, apiToken, stateDir = null, fetcher = null }) {
    Object.assign(this, { serverUrl, apiToken, stateDir });
    this.key = keyOf(apiToken);
    this.rev = null;
    this.map = new Map();
    this.fetcher = fetcher || (async () => {
      const r = await axios.get(`${this.serverUrl}/api/v1/gateway/cameras/credentials`, {
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
      const j = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
      const p = parse(j);
      this.rev = p.rev;
      this.map = p.cameras;
    } catch { /* fehlt oder anderes Token: neu vom Server */ }
  }

  _save() {
    const f = this._file();
    if (!f) return;
    try {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
      const plain = Buffer.from(JSON.stringify({ rev: this.rev, cameras: Object.fromEntries(this.map) }), 'utf8');
      const enc = Buffer.concat([c.update(plain), c.final()]);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch { /* best effort: dann nur im Speicher */ }
  }

  /** Neu holen, wenn `rev` (aus dem Config-Pull) sich geändert hat. → true, wenn frisch. */
  async sync(rev) {
    if (rev && rev === this.rev && this.map.size) return false;
    const p = parse(await this.fetcher());
    this.rev = p.rev || rev || null;
    this.map = p.cameras;
    this._save();
    return true;
  }

  get(id) { return this.map.get(id) || null; }

  clear() {
    this.map = new Map();
    this.rev = null;
    const f = this._file();
    if (f) try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
  }
}

module.exports = { CredStore, parse, keyOf, FILE };
