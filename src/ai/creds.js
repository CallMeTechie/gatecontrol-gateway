'use strict';

// API-Schlüssel des KI-Servers im LAN (docs/local-ai.md §1): nie im
// Config-Pull – dort steht nur `lan.keyRev`. Ändert sich keyRev, holt das
// Gateway den Schlüssel über GET /api/v1/gateway/ai/credentials (nur das
// Gateway, das die lokale KI weiterleitet, bekommt ihn). Im Speicher und
// verschlüsselt in /state/ai-cred.bin (0600, AES-256-GCM, Schlüssel per
// HKDF aus dem Gateway-Token), damit ein Neustart ohne Server weiterläuft.
// Nie im Log, nie in der Telemetrie.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const { validKey } = require('./config');

const FILE = 'ai-cred.bin';
const REV_RE = /^[0-9a-f]{8,64}$/;
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function keyOf(apiToken) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(apiToken || ''), 'utf8'), Buffer.from('gatecontrol-ai', 'utf8'), Buffer.from('ai-cred-v1', 'utf8'), 32));
}

/** Server-Antwort prüfen → { rev, key } (key null, wenn keiner da oder ungültig). */
function parse(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    rev: typeof d.rev === 'string' && REV_RE.test(d.rev) ? d.rev : null,
    key: validKey(d.key) ? d.key : null,
  };
}

class AiKeyStore {
  constructor({ serverUrl = null, apiToken = '', stateDir = null, fetcher = null } = {}) {
    Object.assign(this, { serverUrl, apiToken, stateDir });
    this.cipherKey = keyOf(apiToken);
    this.rev = null;
    this.value = null;
    this.fetcher = fetcher || (async () => {
      if (!this.serverUrl) throw Object.assign(new Error('no server'), { code: 'no_server' });
      const r = await axios.get(`${this.serverUrl}/api/v1/gateway/ai/credentials`, {
        headers: { Authorization: `Bearer ${this.apiToken}` }, timeout: 15_000, httpAgent, httpsAgent, maxRedirects: 0, maxContentLength: 8 * 1024,
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
      if (b.length < 29 || b.length > 4096) return;
      const d = crypto.createDecipheriv('aes-256-gcm', this.cipherKey, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      const p = parse(JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')));
      this.rev = p.rev;
      this.value = p.key;
    } catch { /* fehlt oder anderes Token: neu vom Server */ }
  }

  _save() {
    const f = this._file();
    if (!f) return;
    try {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', this.cipherKey, iv);
      const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify({ rev: this.rev, key: this.value }), 'utf8')), c.final()]);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch { /* best effort: dann nur im Speicher */ }
  }

  /** Mit keyRev aus dem Config-Pull abgleichen: null → vergessen; neu → holen. → true, wenn frisch geholt. */
  async sync(rev) {
    if (!rev) { this.clear(); return false; }
    if (rev === this.rev && this.value) return false;
    const p = parse(await this.fetcher());
    this.rev = p.rev || rev;
    this.value = p.key;
    if (this.value) this._save(); else this._wipe();
    return true;
  }

  get() { return this.value; }

  _wipe() {
    const f = this._file();
    if (f) try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
  }

  clear() {
    this.rev = null;
    this.value = null;
    this._wipe();
  }
}

module.exports = { AiKeyStore, parse, keyOf, FILE };
