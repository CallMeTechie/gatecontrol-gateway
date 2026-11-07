'use strict';

// Thread über einen OpenThread Border Router (docs/radio.md „Thread“).
//
// Der Dienst otbr (openthread/otbr, gepinnt) startet zuerst nur einen kleinen
// Wächter. Soll Thread laufen und ist ein Stick mit RCP-Firmware zugeteilt,
// schreibt das Gateway /gc-radio/thread.env (DEVICE, DEV = major:minor, BAUD,
// INFRA = LAN-Schnittstelle); der Wächter legt genau diesen Geräteknoten an und
// startet den Border Router (REST nur an 127.0.0.1:8081, Weboberfläche
// 127.0.0.1:8089). Zustand in /gc-radio/otbr.state.
//
// Über die REST-Schnittstelle liest das Gateway Rolle, Netzname, Kanal, PAN-ID
// und Ext-PAN-ID (nie den Netzschlüssel in die Telemetrie), bildet ein neues
// Netz („Netz anlegen“), tritt einem vorhandenen bei (Datensatz als TLV-Hex)
// und gibt den aktiven Datensatz auf Anfrage einmal heraus (für Matter-Controller).

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { clean } = require('./detect');
const logger = require('../logger');

const ALIVE_S = 60;
const START_GRACE_MS = 4 * 60_000;
const STATE_RE = /^(idle|wait|running|exit) ([A-Za-z0-9-]{1,16}) ([0-9]{1,12})\s*$/;
const ROLES = ['disabled', 'detached', 'child', 'router', 'leader'];
const IF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,14}$/;
const TLV_RE = /^[0-9a-fA-F]{20,508}$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{1,16}$/;
const MAX_BODY = 64 * 1024;

function readText(file, max = 4096) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}
function writeAtomic(file, text, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}
function err(code, message) { return Object.assign(new Error(message || code), { code }); }

/** Ein Feld eines JSON-Objekts, gleich ob „networkName“ (neu) oder „NetworkName“ (ältere OTBR). */
function pick(o, key) {
  if (!o || typeof o !== 'object') return undefined;
  if (key in o) return o[key];
  const k = Object.keys(o).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : o[k];
}

function request({ host, port, method, path: p, body, contentType, accept, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' && contentType === 'text/plain' ? body : JSON.stringify(body));
    const req = http.request({
      host, port, method, path: p, timeout: timeoutMs,
      headers: { Accept: accept || 'application/json', ...(data ? { 'Content-Type': contentType || 'application/json', 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(err('bad_response', 'response too large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => reject(err('unreachable', e.message)));
    });
    req.on('timeout', () => req.destroy(err('unreachable', 'timeout')));
    req.on('error', (e) => reject(e && e.code === 'bad_response' ? e : err('unreachable', e.message)));
    req.end(data || undefined);
  });
}

/** REST-Client für den Border Router auf demselben Host (beide im Host-Netz). */
function createOtbrClient({ host = '127.0.0.1', port = 8081, timeoutMs = 5000, send = request } = {}) {
  const json = async (method, p, body) => {
    const r = await send({ host, port, method, path: p, body, timeoutMs });
    if (r.status === 204) return null;
    if (r.status < 200 || r.status >= 300) throw err('http_' + r.status);
    if (!r.text) return null;
    try { return JSON.parse(r.text); } catch { throw err('bad_response', 'no JSON'); }
  };
  return {
    role: async () => json('GET', '/node/state'),
    routers: async () => json('GET', '/node/num-of-router'),
    dataset: async () => json('GET', '/node/dataset/active'),
    async datasetTlv() {
      const r = await send({ host, port, method: 'GET', path: '/node/dataset/active', accept: 'text/plain', timeoutMs });
      if (r.status === 204) return null;
      if (r.status !== 200) throw err('http_' + r.status);
      const hex = String(r.text || '').trim().replace(/^"|"$/g, '');
      if (!TLV_RE.test(hex)) throw err('bad_response', 'no dataset');
      return hex.toLowerCase();
    },
    setState: async (s) => json('PUT', '/node/state', s),
    setDataset: async (d) => json('PUT', '/node/dataset/active', d),
    async setDatasetTlv(hex) {
      const r = await send({ host, port, method: 'PUT', path: '/node/dataset/active', body: hex, contentType: 'text/plain', timeoutMs });
      if (r.status < 200 || r.status >= 300) throw err('http_' + r.status);
      return true;
    },
  };
}

/** Netzdaten aus dem aktiven Datensatz – ohne Netzschlüssel und PSKc. */
function networkOf(ds) {
  if (!ds || typeof ds !== 'object') return null;
  const name = pick(ds, 'networkName');
  const ext = pick(ds, 'extPanId');
  const pan = pick(ds, 'panId');
  const ch = pick(ds, 'channel');
  return {
    name: typeof name === 'string' ? clean(name, 16) || null : null,
    extPanId: typeof ext === 'string' && /^[0-9a-fA-F]{16}$/.test(ext) ? ext.toLowerCase() : null,
    panId: Number.isInteger(pan) && pan >= 0 && pan <= 0xffff ? pan : null,
    channel: Number.isInteger(ch) && ch >= 11 && ch <= 26 ? ch : null,
  };
}

class ThreadBorderRouter {
  constructor({ ctlDir = '/gc-radio', client = createOtbrClient(), now = Date.now, procRoot = '/proc', askHost = null }) {
    Object.assign(this, { ctlDir, client, now, procRoot, askHost });
    this.wanted = false;
    this.stick = null;
    this.infra = null;
    this.wantSince = 0;
    this.reachable = false;
    this.role = null;
    this.network = null;
    this.routers = null;
    this.lastError = null;
  }

  /** { want, stick, infra } aus radio.js; busy = der passende Stick dient schon Zigbee;
   *  manual = von Hand für Thread festgelegt (dann auch ein Stick, den die Erkennung nicht als Thread-fähig kennt);
   *  missing = der von Hand gewählte Stick fehlt. */
  apply({ want, stick, infra, busy = false, manual = false, missing = false }) {
    this.wanted = want === true;
    this.busy = busy === true;
    this.missing = missing === true;
    this.stick = stick && stick.tty && stick.dev && (stick.thread || manual === true) ? stick : null;
    this.infra = typeof infra === 'string' && IF_RE.test(infra) ? infra : null;
    if (this.wanted && !this.wantSince) this.wantSince = this.now();
    if (!this.wanted) { this.wantSince = 0; this.reachable = false; this.role = null; this.network = null; }
    this._writeControl(this.wanted && this.stick && this.infra ? this.stick : null);
  }

  _ctlUsable() {
    try { fs.accessSync(this.ctlDir, fs.constants.W_OK); return fs.statSync(this.ctlDir).isDirectory(); } catch { return false; }
  }

  _writeControl(dev) {
    if (!this._ctlUsable()) return;
    const file = path.join(this.ctlDir, 'thread.env');
    try {
      if (!dev) { fs.rmSync(file, { force: true }); return; }
      const text = `DEVICE=${dev.tty}\nDEV=${dev.dev}\nBAUD=${dev.threadBaud || 460800}\nINFRA=${this.infra}\n`;
      if (readText(file) === text) return;
      writeAtomic(file, text);
      logger.info({ device: dev.tty, model: dev.model, infra: this.infra }, 'radio: thread border router switched on');
    } catch (e) { logger.warn({ err: e.message }, 'radio: thread.env not written'); }
  }

  watcher() {
    if (!this._ctlUsable()) return null;
    const m = STATE_RE.exec(readText(path.join(this.ctlDir, 'otbr.state'), 256) || '');
    if (!m) return { state: null, tty: null, alive: false };
    const at = Number(m[3]);
    return { state: m[1], tty: m[2] === '-' ? null : m[2], alive: Number.isFinite(at) && Math.abs(this.now() / 1000 - at) <= ALIVE_S };
  }

  service() {
    const w = this.watcher();
    if (!w) return 'missing';
    return w.alive ? 'managed' : 'absent';
  }

  /** IPv6-Weiterleitung am Host (das Thread-Netz ins Heimnetz): true | false | null (nicht lesbar). */
  forwarding() {
    const t = readText(path.join(this.procRoot, 'sys', 'net', 'ipv6', 'conf', 'all', 'forwarding'), 16);
    if (t == null) return null;
    return t.trim() === '1';
  }

  /** Einmal fragen (alle 60 s). Wirft nie. */
  async tick() {
    if (!this.wanted) return;
    try {
      const role = await this.client.role();
      this.reachable = true;
      this.role = ROLES.includes(role) ? role : null;
    } catch (e) {
      this.reachable = false;
      this.role = null;
      return;
    }
    try {
      this.network = networkOf(await this.client.dataset());
      const n = await this.client.routers().catch(() => null);
      this.routers = Number.isInteger(n) && n >= 0 && n < 100 ? n : null;
      this.lastError = null;
    } catch (e) {
      this.lastError = { at: this.now(), code: clean(String(e.code || 'error'), 32), message: clean(String(e.message || e), 160) };
    }
  }

  /** „Netz anlegen“: neuer Datensatz (Rest zufällig) und einschalten. */
  async form(name) {
    if (!this.reachable) return 'not_running';
    if (this.network && this.role && this.role !== 'disabled') return 'has_network';
    const n = typeof name === 'string' && NAME_RE.test(name.trim()) ? name.trim() : 'GateControl';
    await this.client.setState('disable').catch(() => null);
    await this.client.setDataset({ networkName: n });
    await this.client.setState('enable');
    logger.info('radio: thread network formed');
    await this.tick();
    return 'accepted';
  }

  /** „Vorhandenem Netz beitreten“: Datensatz (TLV-Hex) eines anderen Border Routers. Nie ins Log. */
  async join(tlv) {
    if (typeof tlv !== 'string' || !TLV_RE.test(tlv.trim())) return 'invalid';
    if (!this.reachable) return 'not_running';
    await this.client.setState('disable').catch(() => null);
    await this.client.setDatasetTlv(tlv.trim().toLowerCase());
    await this.client.setState('enable');
    logger.info('radio: thread dataset taken over');
    await this.tick();
    return 'accepted';
  }

  /** Aktiver Datensatz als TLV-Hex (für Matter-Controller) – nur auf Anfrage, nie in Telemetrie oder Log. */
  async dataset() {
    if (!this.reachable) return { outcome: 'not_running' };
    const hex = await this.client.datasetTlv();
    return hex ? { outcome: 'ok', tlv: hex } : { outcome: 'no_network' };
  }

  state() {
    if (!this.wanted) return 'off';
    if (!this.stick) return this.missing ? 'stick_missing' : (this.busy ? 'stick_busy' : 'no_stick');
    if (!this.infra) return 'no_lan';
    if (this.reachable) {
      if (this.role === 'leader' || this.role === 'router' || this.role === 'child') return 'running';
      if (!this.network) return 'no_network';
      return this.role === 'detached' ? 'detached' : 'no_network';
    }
    const svc = this.service();
    if (svc === 'missing') return 'service_missing';
    if (svc === 'absent') {
      if (this.askHost && this.askHost('otbr')) return 'starting';
      return this.now() - this.wantSince < START_GRACE_MS ? 'starting' : 'service_missing';
    }
    const w = this.watcher();
    if (w && (w.state === 'exit' || w.state === 'wait')) return 'error';
    return this.now() - this.wantSince < START_GRACE_MS ? 'starting' : 'error';
  }

  telemetry() {
    const state = this.state();
    let error = this.lastError;
    if (state === 'error' && !error) {
      const w = this.watcher();
      error = { at: this.now(), code: w && w.state === 'wait' ? 'otbr_device' : (w && w.state === 'exit' ? 'otbr_exit' : 'otbr_unreachable'), message: '' };
    }
    return {
      want: this.wanted,
      service: this.service(),
      state,
      role: this.role,
      model: this.stick ? this.stick.model : null,
      device: this.stick ? this.stick.tty : null,
      infra: this.infra,
      network: this.reachable ? this.network : null,
      routers: this.reachable ? this.routers : null,
      forwarding: this.wanted ? this.forwarding() : null,
      error: state === 'running' || state === 'off' ? null : error,
    };
  }
}

module.exports = { ThreadBorderRouter, createOtbrClient, networkOf, pick, TLV_RE };
