'use strict';

// Zertifikat der VPN-Namen (docs/vpn-cert.md): Hat der Admin in GateControl
// „Zertifikat und Schlüssel an Geräte weitergeben“ eingeschaltet und dieses
// Gateway angehakt, steht im Config-Pull `features.vpn_cert`
// { wildcard, fingerprint, not_after }. Das Gateway holt dann Zertifikat und
// privaten Schlüssel über den Tunnel (GET /api/v1/gateway/vpn-cert an
// server.<zone> auf der VPN-Adresse des Servers, Quelle die eigene
// Tunnel-Adresse) und legt beide im State-Verzeichnis ab:
//
//   <stateDir>/vpn-cert/            0700
//     fullchain.pem                 0600  Zertifikat + Zwischenzertifikate
//     privkey.pem                   0600  privater Schlüssel
//     vpn-cert.json                 0600  { wildcard, fingerprint, not_after, fetched_at }
//
// Neuer Fingerabdruck in der Konfiguration → neu holen. Fehlt `vpn_cert`
// (Weitergabe aus, Gateway nicht mehr erlaubt, Zertifikat aus) → Dateien weg.
// Der Schlüssel steht nie im Log, nie im Status und nie im Heartbeat.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const CERT_FILE = 'fullchain.pem';
const KEY_FILE = 'privkey.pem';
const META_FILE = 'vpn-cert.json';
const FILES = [CERT_FILE, KEY_FILE, META_FILE];
const API_PATH = '/api/v1/gateway/vpn-cert';
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 15_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
const ZONE_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** `features.vpn_cert` prüfen → { wildcard, zone, fingerprint, notAfter } oder null. */
function parseSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wildcard = typeof raw.wildcard === 'string' ? raw.wildcard.trim().toLowerCase() : '';
  const fingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint.trim().toLowerCase() : '';
  if (!wildcard.startsWith('*.') || !ZONE_RE.test(wildcard.slice(2)) || !HEX64.test(fingerprint)) return null;
  const notAfter = typeof raw.not_after === 'string' && !Number.isNaN(Date.parse(raw.not_after)) ? new Date(raw.not_after).toISOString() : null;
  return { wildcard, zone: wildcard.slice(2), fingerprint, notAfter };
}

/** SHA-256 über das DER des ersten Zertifikats (hex, klein) – wie der Server. */
function fingerprintOf(x509) {
  return crypto.createHash('sha256').update(x509.raw).digest('hex');
}

/**
 * Antwort des Servers prüfen → { certPem, keyPem, fingerprint, notAfter } oder Fehler mit `code`.
 * `want`: parseSummary() der Konfiguration.
 */
function verifyMaterial(body, want, now = Date.now()) {
  const fail = (code) => Object.assign(new Error(code), { code });
  if (!body || body.ok !== true || typeof body.cert_pem !== 'string' || typeof body.key_pem !== 'string') throw fail('bad_response');
  let x509;
  let key;
  try {
    x509 = new crypto.X509Certificate(body.cert_pem);
    key = crypto.createPrivateKey(body.key_pem);
  } catch { throw fail('bad_response'); }
  const fingerprint = fingerprintOf(x509);
  if (fingerprint !== want.fingerprint) throw fail('fingerprint_mismatch');
  if (typeof body.fingerprint === 'string' && body.fingerprint.toLowerCase() !== fingerprint) throw fail('fingerprint_mismatch');
  if (!x509.checkPrivateKey(key)) throw fail('key_mismatch');
  const names = String(x509.subjectAltName || '').split(',').map((s) => s.trim().toLowerCase());
  if (!names.includes(`dns:${want.wildcard}`)) throw fail('wrong_name');
  const notAfter = new Date(x509.validTo);
  if (!(notAfter.getTime() > now)) throw fail('expired');
  return { certPem: body.cert_pem, keyPem: body.key_pem, fingerprint, notAfter: notAfter.toISOString() };
}

/**
 * Abruf über den Tunnel: TLS zu `serverIp:port` mit SNI/Host `server.<zone>`
 * (das Wildcard-Zertifikat des Servers, volle Prüfung), Quelle `localAddress`.
 * → { status, body } (body: JSON oder null)
 */
function fetchOverTunnel({ serverIp, port = 443, zone, apiToken, localAddress, ca, timeoutMs = TIMEOUT_MS }) {
  const host = `server.${zone}`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: serverIp,
      port,
      servername: host,
      path: API_PATH,
      method: 'GET',
      headers: { Host: host, Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
      ...(localAddress ? { localAddress } : {}),
      ...(ca ? { ca } : {}),
      agent: false,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(Object.assign(new Error('response too large'), { code: 'too_large' })); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        resolve({ status: res.statusCode, body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    req.on('error', reject);
    req.end();
  });
}

/** Datei atomar schreiben: temporär im selben Ordner, fsync, rename. */
function writeAtomic(file, data, mode = 0o600) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* zu */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* weg */ }
    throw err;
  }
}

class VpnCertManager {
  /**
   * @param {object} o
   * @param {string} o.dir           Ablage (Gateway: <stateDir>/vpn-cert)
   * @param {string} o.apiToken      Token des Gateways (wie Config-Pull)
   * @param {string} [o.tunnelIp]    eigene Tunnel-Adresse (Quelle des Abrufs)
   * @param {string} [o.serverIp]    VPN-Adresse des Servers, wenn der Config-Pull keine nennt
   * @param {number} [o.port]        Port des Servers im Tunnel (443)
   * @param {string|Buffer} [o.ca]   eigene CA (nur Tests)
   * @param {Function} [o.fetch]     Abruf ersetzen (Tests): (opts) → { status, body }
   */
  constructor({ dir, apiToken, tunnelIp = null, serverIp = '10.8.0.1', port = 443, ca = null, logger = null, fetch = fetchOverTunnel,
    now = Date.now, retryMinMs = RETRY_MIN_MS, retryMaxMs = RETRY_MAX_MS, onChange = () => {} } = {}) {
    this.dir = dir;
    this.apiToken = apiToken;
    this.tunnelIp = tunnelIp;
    this.defaultServerIp = serverIp;
    this.port = port;
    this.ca = ca;
    this.logger = logger;
    this.fetchFn = fetch;
    this.now = now;
    this.retryMinMs = retryMinMs;
    this.retryMaxMs = retryMaxMs;
    this.onChange = onChange;
    this.want = null;            // parseSummary() der letzten Konfiguration
    this.serverIp = serverIp;
    this.have = null;            // { wildcard, fingerprint, notAfter, fetchedAt } der Dateien
    this.state = 'off';          // off | fetching | ok | error
    this.error = null;           // Code des letzten Fehlers
    this.lastAttemptAt = null;
    this.nextRetryAt = null;
    this.failures = 0;
    this.timer = null;
    this.running = null;         // laufender Abruf (Promise)
    this.stopped = false;
    this._restore();
  }

  /** Stand der Dateien nach einem Neustart (bis der erste Config-Pull etwas anderes sagt). */
  _restore() {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.dir, META_FILE), 'utf8'));
      const x509 = new crypto.X509Certificate(fs.readFileSync(path.join(this.dir, CERT_FILE), 'utf8'));
      if (!fs.existsSync(path.join(this.dir, KEY_FILE))) return;
      const fingerprint = fingerprintOf(x509);
      if (meta.fingerprint !== fingerprint) return;
      this.have = { wildcard: meta.wildcard, fingerprint, notAfter: new Date(x509.validTo).toISOString(), fetchedAt: Number(meta.fetched_at) || null };
      this.state = 'ok';
    } catch { /* nichts da */ }
  }

  /**
   * Config-Pull: `features.vpn_cert` (oder undefined) und die VPN-Adresse des
   * Servers (`features.internal_dns.server`, sonst die Vorgabe).
   */
  apply(raw, { serverIp } = {}) {
    if (this.stopped) return;
    this.serverIp = typeof serverIp === 'string' && IPV4.test(serverIp) ? serverIp : this.defaultServerIp;
    const want = parseSummary(raw);
    if (!want) {
      if (raw !== undefined && raw !== null) this.logger?.warn('vpn cert: summary in config not usable, ignored');
      this.want = null;
      this._clearTimer();
      this.failures = 0;
      this.nextRetryAt = null;
      this.error = null;
      if (this.have || this.state !== 'off') this.remove('not_shared');
      return;
    }
    const changed = !this.want || this.want.fingerprint !== want.fingerprint;
    this.want = want;
    if (this.have && this.have.fingerprint === want.fingerprint) {
      this._clearTimer();
      this.failures = 0;
      this.nextRetryAt = null;
      if (this.state !== 'ok' || this.error) { this.state = 'ok'; this.error = null; this._changed(); }
      return;
    }
    if (changed) { this.failures = 0; this._clearTimer(); this.nextRetryAt = null; }
    if (!this.timer && !this.running) this._kick();
  }

  _kick() {
    this.running = this.fetchNow().finally(() => {
      this.running = null;
      // Während des Abrufs kam ein anderer Fingerabdruck: gleich den neuen holen
      if (!this.stopped && !this.timer && this.want && (!this.have || this.have.fingerprint !== this.want.fingerprint) && this.state !== 'error') this._kick();
    });
  }

  /** Einmal abrufen (mit Wiederholung bei Fehler). → true bei Erfolg */
  async fetchNow() {
    const want = this.want;
    if (!want || this.stopped) return false;
    this.state = 'fetching';
    this.lastAttemptAt = this.now();
    this._changed();
    try {
      const r = await this.fetchFn({ serverIp: this.serverIp, port: this.port, zone: want.zone, apiToken: this.apiToken, localAddress: this.tunnelIp, ca: this.ca });
      if (r.status !== 200) {
        const code = r.body && typeof r.body.error === 'string' && /^[a-z_]{1,40}$/.test(r.body.error) ? r.body.error : `http_${r.status}`;
        throw Object.assign(new Error(code), { code });
      }
      const m = verifyMaterial(r.body, want, this.now());
      // Konfiguration hat sich währenddessen geändert: nicht mehr gewollt
      if (this.stopped || !this.want || this.want.fingerprint !== want.fingerprint) return false;
      this._write(m, want);
      this.failures = 0;
      this.error = null;
      this.nextRetryAt = null;
      this.state = 'ok';
      this.logger?.info({ wildcard: want.wildcard, fingerprint: m.fingerprint, not_after: m.notAfter }, 'vpn cert: certificate and key stored');
      this._changed();
      return true;
    } catch (err) {
      const code = err && typeof err.code === 'string' && /^[A-Za-z_0-9]{1,40}$/.test(err.code) ? err.code : 'fetch_failed';
      if (!this.want || this.want.fingerprint !== want.fingerprint) return false;
      this.failures += 1;
      this.error = code;
      // Ein vorhandenes (älteres) Zertifikat bleibt bis zum Erfolg liegen
      this.state = 'error';
      const delay = Math.min(this.retryMaxMs, this.retryMinMs * 2 ** Math.min(this.failures - 1, 16));
      this.nextRetryAt = this.now() + delay;
      this.logger?.warn({ error: code, attempt: this.failures, retry_in_s: Math.round(delay / 1000) }, 'vpn cert: fetch failed');
      this._clearTimer();
      if (!this.stopped) {
        this.timer = setTimeout(() => { this.timer = null; if (!this.running) this._kick(); }, delay);
        this.timer.unref?.();
      }
      this._changed();
      return false;
    }
  }

  _write(m, want) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    const fetchedAt = this.now();
    writeAtomic(path.join(this.dir, KEY_FILE), m.keyPem, 0o600);
    writeAtomic(path.join(this.dir, CERT_FILE), m.certPem, 0o600);
    writeAtomic(path.join(this.dir, META_FILE), JSON.stringify({ wildcard: want.wildcard, fingerprint: m.fingerprint, not_after: m.notAfter, fetched_at: fetchedAt }, null, 2) + '\n', 0o600);
    this.have = { wildcard: want.wildcard, fingerprint: m.fingerprint, notAfter: m.notAfter, fetchedAt };
  }

  /** Zertifikat und Schlüssel löschen (Weitergabe aus / nicht mehr erlaubt). */
  remove(reason = 'not_shared') {
    let removed = true;
    for (const f of FILES) {
      try { fs.rmSync(path.join(this.dir, f), { force: true }); } catch (err) { removed = false; this.logger?.warn({ err: err.message, file: f }, 'vpn cert: file not removed'); }
    }
    try {
      for (const f of fs.readdirSync(this.dir)) if (f.startsWith('.') && f.endsWith('.tmp')) fs.rmSync(path.join(this.dir, f), { force: true });
      fs.rmdirSync(this.dir);
    } catch { /* Ordner fehlt oder enthält Fremdes */ }
    const had = !!this.have;
    this.have = null;
    this.state = 'off';
    if (had && removed) this.logger?.info({ reason }, 'vpn cert: certificate and key removed');
    this._changed();
  }

  _clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  _changed() { try { this.onChange(); } catch { /* Zuhörer */ } }

  stop() { this.stopped = true; this._clearTimer(); }

  /** Pfade der Dateien (nur, wenn sie da sind). */
  files() {
    return this.have ? { dir: this.dir, cert: path.join(this.dir, CERT_FILE), key: path.join(this.dir, KEY_FILE) } : null;
  }

  /** Für die Statusseite: nie der Schlüssel. null = Weitergabe aus und nichts gespeichert. */
  status() {
    if (this.state === 'off' && !this.want) return null;
    const cur = this.have;
    return {
      state: this.state,
      wildcard: (cur && cur.wildcard) || (this.want && this.want.wildcard) || null,
      fingerprint: cur ? cur.fingerprint : null,
      notAfter: cur ? cur.notAfter : null,
      fetchedAt: cur ? cur.fetchedAt : null,
      lastAttemptAt: this.lastAttemptAt,
      error: this.error,
      nextRetryAt: this.nextRetryAt,
    };
  }

  /** Heartbeat: nur Fingerabdruck und Ablauf des gespeicherten Zertifikats. */
  telemetry() {
    return this.have ? { fingerprint: this.have.fingerprint, not_after: this.have.notAfter } : null;
  }
}

module.exports = { VpnCertManager, parseSummary, verifyMaterial, fetchOverTunnel, writeAtomic, fingerprintOf, CERT_FILE, KEY_FILE, META_FILE };
