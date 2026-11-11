'use strict';

// Edge-Host-Seite des Gateway-Sockets (docs/edge.md "Gateway-Socket"): der
// Edge-Container hat kein Netz (network_mode: none) – jede gc.lan.*-,
// gc.mqtt.*- und mDNS-Anfrage eines Edge-Teils geht als RPC an den
// Gateway-Container, der sie prüft (Plugin im Sollzustand, Fähigkeiten,
// LAN-Grenzen) und ausführt (bridge.js). Ereignisse (UDP-Datagramme,
// TCP-Daten, mDNS-Funde, MQTT-Nachrichten) kommen als `push` zurück.
//
// Transport: WebSocket über den Unix-Socket (ws+unix://…/gw.sock:/edge/rpc),
// Subprotokoll gc-edge-rpc.v1, JSON-Textframes ≤ 8 MB.

const EventEmitter = require('node:events');
const WebSocket = require('ws');
const { RPC_PATH, RPC_PROTOCOL, RPC_MAX_BYTES, TIMING } = require('./constants');
const { unixWsUrl, backoffDelay } = require('./channel');

const PUSH_TYPES = new Set(['udp', 'sock', 'mdns', 'mqtt']);

function rpcError(err) {
  const e = new Error(err && typeof err.message === 'string' ? err.message.slice(0, 300) : 'gateway error');
  e.code = err && typeof err.code === 'string' && err.code.length <= 32 ? err.code : 'edge_error';
  if (err && err.data && typeof err.data === 'object') e.data = err.data;
  return e;
}

class GatewayRpc extends EventEmitter {
  constructor({ socketPath, logger, WebSocketImpl = WebSocket, timing = {} } = {}) {
    super();
    this.socketPath = socketPath;
    this.logger = logger || { info() {}, warn() {}, debug() {} };
    this.WS = WebSocketImpl;
    this.timing = { ...TIMING, ...timing };
    this.ws = null;
    this.connected = false;
    this.stopped = true;
    this.attempt = 0;
    this.retryTimer = null;
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.nextId = 0;
    this.info = null; // { mqtt: { available, tlsCert }, mqttStatus }
    this.sessions = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.ws) { try { this.ws.terminate(); } catch { /* zu */ } }
    this.ws = null;
    this.connected = false;
    this.failAll('not_available', 'edge host stopping');
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new this.WS(unixWsUrl(this.socketPath, RPC_PATH), RPC_PROTOCOL, { maxPayload: RPC_MAX_BYTES, perMessageDeflate: false, handshakeTimeout: 10000 });
    } catch (e) {
      this.logger.debug({ err: e.message }, 'edge: gateway socket not usable');
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (ws.protocol !== RPC_PROTOCOL) { try { ws.close(1002, 'subprotocol'); } catch { /* zu */ } return; }
      this.attempt = 0;
      this.connected = true;
      this.sessions++;
      this.logger.info('edge: connected to the gateway socket');
      this.emit('open', this.sessions);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      if (m && typeof m === 'object') this.onMessage(m);
    });
    ws.on('error', (e) => this.logger.debug({ err: e.message }, 'edge: gateway socket error'));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.connected;
      this.connected = false;
      this.failAll('not_available', 'connection to the gateway lost');
      if (was) { this.logger.warn('edge: gateway socket closed'); this.emit('close'); }
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt++, { min: this.timing.rpcReconnectMinMs, max: this.timing.rpcReconnectMaxMs });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  onMessage(m) {
    switch (m.t) {
      case 'result': {
        const p = Number.isInteger(m.id) ? this.pending.get(m.id) : undefined;
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok === true) p.resolve(m.result === undefined ? null : m.result);
        else p.reject(rpcError(m.error));
        return;
      }
      case 'push':
        if (typeof m.plugin === 'string' && m.msg && typeof m.msg === 'object' && PUSH_TYPES.has(m.msg.t)) this.emit('push', m.plugin, m.msg);
        return;
      case 'info':
        this.info = { mqtt: { available: !!(m.mqtt && m.mqtt.available === true), tlsCert: !!(m.mqtt && m.mqtt.tlsCert === true) },
          mqttStatus: m.mqttStatus && typeof m.mqttStatus === 'object' ? m.mqttStatus : null };
        this.emit('info', this.info);
        return;
      default:
    }
  }

  failAll(code, message) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(rpcError({ code, message })); }
    this.pending.clear();
  }

  send(msg) {
    if (!this.ws || !this.connected || this.ws.readyState !== 1) return false;
    const text = JSON.stringify(msg);
    if (Buffer.byteLength(text, 'utf8') > RPC_MAX_BYTES) return false;
    try { this.ws.send(text); return true; } catch { return false; }
  }

  /** Aufruf am Gateway; `caps` = wirksame Fähigkeiten (das Gateway engt sie auf die Genehmigung ein). */
  call(plugin, api, args, caps) {
    if (!this.connected) return Promise.reject(rpcError({ code: 'not_available', message: 'the gateway socket is not connected' }));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(rpcError({ code: 'timeout', message: `${api} timed out at the gateway` })); }, this.timing.rpcCallTimeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ t: 'call', id, plugin, api, args: args === undefined ? null : args, caps: caps || {} })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(rpcError({ code: 'too_large', message: 'request larger than the gateway socket allows' }));
      }
    });
  }

  /** Alle Sockets, Suchen und Abos eines Edge-Teils am Gateway schließen. */
  closePlugin(plugin) { this.send({ t: 'close', plugin }); }
}

const NET_APIS = ['udp.bind', 'udp.send', 'udp.close', 'tcp.connect', 'tcp.write', 'tcp.end', 'tcp.destroy',
  'http.request', 'tls.fingerprint', 'mdns.browse', 'mdns.stop', 'serial.open'];

/** gc.lan.* eines Edge-Teils – ausgeführt vom Gateway (gleiche Schnittstelle wie PluginNet). */
class RemoteNet {
  constructor({ pluginId, rpc, caps }) {
    this.pluginId = pluginId;
    this.rpc = rpc;
    this.caps = caps;
    this.table = Object.fromEntries(NET_APIS.map((api) => [api, (args) => this.rpc.call(this.pluginId, api, args, this.caps())]));
  }

  apis() { return this.table; }

  closeAll() { this.rpc.closePlugin(this.pluginId); }
}

/** gc.mqtt.* im isolierten Modus: Broker-Dateien und internes Konto liegen beim Gateway. */
class RemoteMqtt {
  constructor({ rpc }) {
    this.rpc = rpc;
    this.onChange = () => {};
    rpc.on('info', () => this.onChange());
  }

  available() { return !!(this.rpc.info && this.rpc.info.mqtt.available); }

  /** Erzeugt das Gateway das Zertifikat für den TLS-Listener selbst? (ältere Gateway-Container: nein) */
  tlsCert() { return !!(this.rpc.info && this.rpc.info.mqtt.tlsCert); }

  apply() { /* den Sollzustand liest das Gateway selbst mit (Relay) */ }

  refresh() {}

  pluginCall(plugin, getCaps, api, args) { return this.rpc.call(plugin, api, args, getCaps()); }

  dropPlugin() { /* RemoteNet.closeAll() räumt am Gateway auch die Abos auf */ }

  status() {
    const s = this.rpc.info && this.rpc.info.mqttStatus;
    return s || { running: false, clients: 0, accounts: [] };
  }

  async stop() {}
}

module.exports = { GatewayRpc, RemoteNet, RemoteMqtt, NET_APIS, PUSH_TYPES };
