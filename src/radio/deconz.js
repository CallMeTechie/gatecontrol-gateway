'use strict';

// Kleiner REST-Client für deCONZ auf demselben Host (127.0.0.1:8090, beide
// Container im Host-Netz). Nur das, was das Gateway braucht: erreichbar?,
// eigener API-Schlüssel, Status (Kanal, Firmware, Geräte), Anlernen
// (permitjoin) und Entsperren für das Smart-Home-Plugin (unlock).
// Wirft Fehler mit `code`: unreachable | unauthorized | link_button | bad_response | http_<n>.

const http = require('node:http');

const MAX_BODY = 2 * 1024 * 1024;
const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;
// Werkseinstellung von deCONZ (Benutzer „delight“) – gilt, bis jemand in Phoscon ein Passwort setzt
const DEFAULT_AUTH = 'Basic ' + Buffer.from('delight:delight').toString('base64');

function err(code, message) { return Object.assign(new Error(message || code), { code }); }

function request({ host, port, method, path, body, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host, port, method, path, timeout: timeoutMs,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...(headers || {}) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(err('bad_response', 'response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { json = undefined; }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', (e) => reject(err('unreachable', e.message)));
    });
    req.on('timeout', () => req.destroy(err('unreachable', 'timeout')));
    req.on('error', (e) => reject(e && e.code === 'bad_response' ? e : err('unreachable', e.message)));
    req.end(data || undefined);
  });
}

/** deCONZ-Fehlerliste [{ error: { type, description } }] → Fehler (type 1 = Schlüssel ungültig, 101 = Link-Knopf). */
function deconzError(json) {
  const e = Array.isArray(json) ? json.find((x) => x && x.error) : null;
  if (!e) return null;
  const type = Number(e.error.type);
  if (type === 1) return err('unauthorized', 'api key not accepted');
  if (type === 101) return err('link_button', 'link button not pressed');
  return err('deconz_' + (Number.isInteger(type) ? type : 'error'), String(e.error.description || '').slice(0, 120));
}

function createDeconzClient({ host = '127.0.0.1', port = 8090, timeoutMs = 5000, send = request } = {}) {
  async function call(method, path, body, headers) {
    const r = await send({ host, port, method, path, body, headers, timeoutMs });
    if (r.json === undefined) throw err('bad_response', 'no JSON');
    const de = deconzError(r.json);
    if (de) throw de;
    if (r.status === 403 || r.status === 401) throw err('unauthorized', 'http ' + r.status);
    if (r.status < 200 || r.status >= 300) throw err('http_' + r.status);
    return r.json;
  }
  const keyPath = (key, p) => {
    if (!KEY_RE.test(String(key || ''))) throw err('unauthorized', 'no api key');
    return `/api/${key}${p}`;
  };

  return {
    /** Schlüsselfreie Kurzinfo (name, swversion, bridgeid …) – auch der Test „läuft deCONZ?“. */
    probe: () => call('GET', '/api/config'),
    /** Neuer Schlüssel: zuerst mit der Werkseinstellung, dann ohne (falls entsperrt). */
    async createKey(devicetype = 'GateControl-Gateway') {
      let last = null;
      for (const headers of [{ Authorization: DEFAULT_AUTH }, {}]) {
        try {
          const out = await call('POST', '/api', { devicetype }, headers);
          const ok = Array.isArray(out) ? out.find((x) => x && x.success && KEY_RE.test(String(x.success.username || ''))) : null;
          if (ok) return ok.success.username;
          last = err('bad_response', 'no key in answer');
        } catch (e) {
          if (e.code === 'unreachable') throw e;
          last = e;
        }
      }
      throw last && (last.code === 'link_button' || last.code === 'unauthorized') ? err('key_needed', 'deCONZ refuses a new api key') : last;
    },
    config: async (key) => call('GET', keyPath(key, '/config')),
    lights: async (key) => call('GET', keyPath(key, '/lights')),
    sensors: async (key) => call('GET', keyPath(key, '/sensors')),
    permitJoin: async (key, seconds) => call('PUT', keyPath(key, '/config'), { permitjoin: seconds }),
    unlock: async (key, seconds) => call('PUT', keyPath(key, '/config'), { unlock: seconds }),
  };
}

module.exports = { createDeconzClient, deconzError, KEY_RE, DEFAULT_AUTH };
