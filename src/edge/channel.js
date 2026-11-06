'use strict';

// Kanal zum Server (Vertrag Abschnitt 1): WebSocket gc-edge.v1, JSON-
// Textframes ≤ 64 KB, Ping alle 20 s (Abbruch nach 60 s ohne Lebenszeichen),
// Wiederverbindung mit Backoff 1 s … 60 s (mit Zufallsanteil).
//
// Der Edge-Host verbindet sich nicht selbst mit dem Server, sondern über den
// Gateway-Socket (credentials() → { socketPath }): ws+unix://…/gw.sock:
// /api/v1/gateway/edge/ws. Das Gateway baut die Verbindung zum Server mit
// seinem Token auf und reicht die Frames durch (bridge.js) – der Edge-
// Container braucht dafür weder Netz noch Token. Lehnt der Server ab, meldet
// das Gateway dieselbe HTTP-Statuszeile, die Backoff-Regeln bleiben gleich.
// Der direkte Weg (serverUrl + apiToken, gepinnte Adressen) bleibt für das
// Relay des Gateways und die Tests erhalten.

const EventEmitter = require('node:events');
const WebSocket = require('ws');
const { PROTOCOL, LIMITS, TIMING } = require('./constants');

const WS_PATH = '/api/v1/gateway/edge/ws';

function wsUrl(serverUrl) {
  const u = new URL(serverUrl);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('serverUrl must be http(s)');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/+$/, '') + WS_PATH;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/** ws+unix-URL für einen Pfad am Unix-Socket des Gateways (ws: ws+unix:///abs/sock:/pfad). */
function unixWsUrl(socketPath, reqPath) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) throw new Error('socketPath must be absolute');
  return `ws+unix://${socketPath}:${reqPath}`;
}

/** lookup() für net/tls, das nur die vom Gateway gelieferten Adressen kennt. */
function pinnedLookup(getAddrs) {
  return (hostname, opts, cb) => {
    const list = (getAddrs() || []).filter(Boolean);
    if (!list.length) {
      const e = Object.assign(new Error(`no pinned address for ${hostname}`), { code: 'ENOTFOUND' });
      return process.nextTick(cb, e);
    }
    const all = list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    if (opts && opts.all) return process.nextTick(cb, null, all);
    return process.nextTick(cb, null, all[0].address, all[0].family);
  };
}

function backoffDelay(attempt, { min = TIMING.reconnectMinMs, max = TIMING.reconnectMaxMs, random = Math.random } = {}) {
  const base = Math.min(max, min * Math.pow(2, Math.max(0, attempt)));
  // ±20 % Zufall, damit nicht alle Gateways nach einem Server-Neustart gleichzeitig kommen
  return Math.max(min, Math.min(max, Math.round(base * (0.8 + 0.4 * random()))));
}

class EdgeChannel extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => {serverUrl:string, apiToken:string, serverAddrs?:string[]}} o.credentials
   * @param {object} [o.logger]
   * @param {Function} [o.WebSocketImpl]
   */
  constructor({ credentials, logger, WebSocketImpl = WebSocket, timing = {}, random = Math.random }) {
    super();
    this.credentials = credentials;
    this.logger = logger || { info() {}, warn() {}, debug() {} };
    this.WS = WebSocketImpl;
    this.timing = { ...TIMING, ...timing };
    this.random = random;
    this.ws = null;
    this.attempt = 0;
    this.stopped = true;
    this.retryTimer = null;
    this.pingTimer = null;
    this.lastSeen = 0;
    this.connected = false;
    this.lastError = null;
    this.unsupported = false;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearPing();
    if (this.ws) {
      try { this.ws.close(1000, 'stopping'); } catch { /* closed */ }
      try { this.ws.terminate(); } catch { /* closed */ }
    }
    this.ws = null;
    this.connected = false;
  }

  /** Verbindung sofort neu aufbauen (z. B. neue Zugangsdaten). */
  reconnect() {
    if (this.stopped) return;
    if (this.ws) { try { this.ws.terminate(); } catch { /* closed */ } }
    else { clearTimeout(this.retryTimer); this.connect(); }
  }

  connect() {
    if (this.stopped) return;
    let creds;
    try {
      creds = this.credentials();
      if (!creds || (!creds.socketPath && (!creds.serverUrl || !creds.apiToken))) throw new Error('no credentials');
    } catch (e) {
      this.lastError = e.message;
      this.scheduleRetry(this.timing.reconnectMaxMs);
      return;
    }
    let url;
    const opts = {
      maxPayload: LIMITS.frameBytes,
      handshakeTimeout: 15000,
      perMessageDeflate: false,
      followRedirects: false,
    };
    if (creds.socketPath) {
      url = unixWsUrl(creds.socketPath, WS_PATH);
    } else {
      try { url = wsUrl(creds.serverUrl); } catch (e) { this.lastError = e.message; this.scheduleRetry(this.timing.reconnectMaxMs); return; }
      opts.headers = { Authorization: `Bearer ${creds.apiToken}` };
      if (Array.isArray(creds.serverAddrs) && creds.serverAddrs.length) opts.lookup = pinnedLookup(() => creds.serverAddrs);
    }
    let ws;
    try {
      ws = new this.WS(url, PROTOCOL, opts);
    } catch (e) {
      this.lastError = e.message;
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    let retryIn = null;
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode;
      if (code === 404 || code === 426 || code === 501) {
        // älterer Server ohne Edge-Endpunkt: alles bleibt aus, selten nachfragen
        if (!this.unsupported) this.logger.info({ status: code }, 'edge: server has no edge endpoint — staying idle');
        this.unsupported = true;
        retryIn = this.timing.unsupportedRetryMs;
      } else if (code === 401 || code === 403) {
        this.logger.warn({ status: code }, 'edge: server rejected the gateway token');
        retryIn = this.timing.authRetryMs;
      }
      this.lastError = `http_${code}`;
      try { res.resume(); } catch { /* ignore */ }
      try { ws.terminate(); } catch { /* closed */ }
    });
    ws.on('open', () => {
      if (ws.protocol !== PROTOCOL) {
        this.lastError = 'wrong_subprotocol';
        this.logger.warn({ protocol: ws.protocol }, 'edge: server answered without the gc-edge.v1 subprotocol');
        retryIn = this.timing.unsupportedRetryMs;
        try { ws.close(1002, 'subprotocol'); } catch { /* closed */ }
        return;
      }
      this.attempt = 0;
      this.unsupported = false;
      this.connected = true;
      this.lastError = null;
      this.lastSeen = Date.now();
      this.startPing(ws);
      this.logger.info('edge: connected to the server');
      this.emit('open');
    });
    ws.on('message', (data, isBinary) => {
      this.lastSeen = Date.now();
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { this.logger.debug('edge: invalid JSON frame ignored'); return; }
      if (msg && typeof msg === 'object' && typeof msg.t === 'string') this.emit('message', msg);
    });
    ws.on('pong', () => { this.lastSeen = Date.now(); });
    ws.on('ping', () => { this.lastSeen = Date.now(); });
    ws.on('error', (e) => {
      if (retryIn === null) this.lastError = e.code || e.message; // HTTP-Ablehnung bleibt der Grund
      this.logger.debug({ err: e.message }, 'edge: channel error');
    });
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPing();
      const was = this.connected;
      this.connected = false;
      if (was) { this.logger.info({ code }, 'edge: disconnected'); this.emit('close'); }
      this.scheduleRetry(retryIn);
    });
  }

  scheduleRetry(fixed = null) {
    if (this.stopped) return;
    const delay = fixed || backoffDelay(this.attempt++, { min: this.timing.reconnectMinMs, max: this.timing.reconnectMaxMs, random: this.random });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
    if (this.retryTimer.unref) this.retryTimer.unref();
    this.emit('retry', delay);
  }

  startPing(ws) {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastSeen > this.timing.pongTimeoutMs) {
        this.logger.warn('edge: no answer from the server — reconnecting');
        try { ws.terminate(); } catch { /* closed */ }
        return;
      }
      try { ws.ping(); } catch { /* closing */ }
    }, this.timing.pingMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  clearPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /**
   * Nachricht senden. Liefert false, wenn nicht verbunden oder der Frame
   * größer als 64 KB wäre (dann wird nichts gesendet).
   */
  send(msg) {
    if (!this.ws || !this.connected || this.ws.readyState !== 1) return false;
    const text = JSON.stringify(msg);
    if (Buffer.byteLength(text, 'utf8') > LIMITS.frameBytes) {
      this.logger.warn({ t: msg && msg.t }, 'edge: frame larger than 64 KB not sent');
      return false;
    }
    try { this.ws.send(text); return true; } catch { return false; }
  }
}

module.exports = { EdgeChannel, wsUrl, unixWsUrl, pinnedLookup, backoffDelay, WS_PATH };
