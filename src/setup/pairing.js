'use strict';

// Einrichtungscode einlösen (docs/setup-page.md): POST https://<server>/api/v1/gateway/pair
// mit { code } → { envContent }. TLS wird normal geprüft, Weiterleitungen
// werden nicht verfolgt, und von der Antwort verlässt nichts dieses Modul
// außer geprüften Feldern. Der Code wird nie protokolliert.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { parseConfig } = require('../config');

const PAIR_PATH = '/api/v1/gateway/pair';
const PAIR_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TLS_ERROR_RE = /^(CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|ERR_TLS_|HOSTNAME_MISMATCH)/;

class PairError extends Error {
  /** @param {'code_rejected'|'server_unreachable'|'server_tls'|'server_not_gatecontrol'|'server_busy'|'server_error'|'bad_response'} code */
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail || null; // nur fürs Protokoll, nie für die Seite
  }
}

function post({ host, port, body, tls = {}, timeoutMs = PAIR_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      host, port, method: 'POST', path: PAIR_PATH, agent: false, timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Accept: 'application/json' },
      ...tls,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(); reject(new PairError('bad_response', 'response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => reject(new PairError('server_unreachable', err.code || err.message)));
    });
    req.on('timeout', () => { req.destroy(); reject(new PairError('server_unreachable', 'timeout')); });
    req.on('error', (err) => {
      if (err instanceof PairError) return reject(err);
      const code = String(err.code || '');
      reject(new PairError(TLS_ERROR_RE.test(code) || /certificate|altname/i.test(err.message || '') ? 'server_tls' : 'server_unreachable', code || err.message));
    });
    req.end(payload);
  });
}

function parseJson(text) {
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

/** Name des Gateways aus der Kommentarzeile `# Peer: <Name> (ID: 7)` – nur druckbare Zeichen, gekürzt. */
function peerNameFromEnv(envContent) {
  const m = /^#\s*Peer:\s*(.+?)\s*\(ID:\s*\d+\)\s*$/m.exec(String(envContent || ''));
  if (!m) return null;
  // eslint-disable-next-line no-control-regex
  const name = m[1].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return name || null;
}

/**
 * Code beim Server einlösen.
 * @param {{ server: { host: string, port: number }, code: string, tls?: object }} p  `tls` nur für Tests (eigene CA)
 * @returns {Promise<{ envContent: string, config: object, name: string|null }>}
 */
async function redeem({ server, code, tls, timeoutMs }) {
  const res = await post({ host: server.host, port: server.port, body: { code }, tls, timeoutMs });
  const json = parseJson(res.text);
  if (res.status === 200 && json && json.ok === true && typeof json.envContent === 'string') {
    let config;
    try { config = parseConfig(json.envContent); } catch { throw new PairError('bad_response', 'envContent failed validation'); }
    return { envContent: json.envContent, config, name: peerNameFromEnv(json.envContent) };
  }
  if (res.status === 400 && json && json.error === 'invalid_or_expired') throw new PairError('code_rejected');
  if (res.status === 429) throw new PairError('server_busy');
  if (res.status >= 500) throw new PairError('server_error', `status ${res.status}`);
  // 200 ohne envContent, 3xx, 404, HTML: unter dieser Adresse antwortet kein GateControl
  throw new PairError('server_not_gatecontrol', `status ${res.status}`);
}

/** gateway.env atomar schreiben: temporäre Datei (0600) im selben Ordner, fsync, umbenennen. */
function writeEnvAtomic(envPath, content) {
  const dir = path.dirname(envPath);
  const tmp = path.join(dir, `.gateway.env.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, envPath);
    fs.chmodSync(envPath, 0o600);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* schon zu */ } }
    try { fs.unlinkSync(tmp); } catch { /* nie angelegt */ }
    throw err;
  }
  try { const d = fs.openSync(dir, 'r'); fs.fsyncSync(d); fs.closeSync(d); } catch { /* nicht jedes Dateisystem */ }
}

module.exports = { redeem, writeEnvAtomic, peerNameFromEnv, PairError, PAIR_PATH };
