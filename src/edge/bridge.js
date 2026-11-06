'use strict';

// Gateway-Socket (docs/edge.md "Gateway-Socket") – läuft im Gateway-Container.
// Der Edge-Container (neue Compose-Datei: network_mode: none) hat kein Netz;
// alles, was er nach außen braucht, macht der Gateway-Container stellvertretend
// über den Unix-Socket /run/gc-edge/gw.sock (tmpfs-Volume edge-run, Datei
// 0660, Gruppe 61001 über das setgid-Bit – nur der Edge-Benutzer kommt dran,
// löschen oder ersetzen kann er sie nicht, das Volume ist bei ihm read-only):
//
//   GET /api/v1/gateway/edge/ws          Relay zum Server (Subprotokoll gc-edge.v1):
//                                        das Gateway verbindet sich mit SEINEM Token,
//                                        reicht Textframes durch und liest den
//                                        Sollzustand (`state`) mit.
//   GET /api/v1/gateway/edge/packages/…  Paket vom Server (nur id/version aus dem
//                                        mitgelesenen Sollzustand).
//   GET /edge/rpc                        RPC (gc-edge-rpc.v1): gc.lan.*, mDNS und
//                                        gc.mqtt.* der Edge-Teile – geprüft HIER:
//                                        Plugin im Sollzustand und eingeschaltet,
//                                        Fähigkeiten höchstens die genehmigten,
//                                        Ziele nur im privaten LAN (lanGuard: nie
//                                        Tunnel, nie Server, kein DNS).
//
// Ein kompromittierter Edge-Container erreicht damit nichts außer genehmigten
// LAN-Zielen und dem Edge-Kanal des eigenen Gateways; das Token sieht er nie.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');
const { PROTOCOL, LIMITS, TIMING, SOCKET_NAME, RPC_PATH, RPC_PROTOCOL, RPC_MAX_BYTES, PACKAGES_PATH, ID_RE, VERSION_RE } = require('./constants');
const { wsUrl, pinnedLookup, WS_PATH } = require('./channel');
const { parseState } = require('./protocol');
const { validateCaps, intersectCaps } = require('./manifest');
const { PluginNet, NetError } = require('./netProxy');
const { NET_APIS, PUSH_TYPES } = require('./remote');
const packages = require('./packages');

const MQTT_APIS = new Set(['mqtt.subscribe', 'mqtt.unsubscribe', 'mqtt.publish']);
const NET_API_SET = new Set(NET_APIS);
const MAX_CONNECTIONS = 8;
const MAX_INFLIGHT = 128; // gleichzeitige RPC-Aufrufe insgesamt (der Edge-Host begrenzt je Plugin auf 64)
const PUSH_BUFFER_MAX = 16 * 1024 * 1024; // darüber werden Ereignisse verworfen (Edge liest nicht)
const SENDABLE_CLOSE = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]);
const MQTT_OFF = { enabled: false, tls: false, accounts: [], pluginTopics: {} };
const PACKAGE_RE = new RegExp(`^${PACKAGES_PATH.replace(/\//g, '\\/')}\\/([^/?]+)\\/([^/?]+)$`);

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function validId(id) { return typeof id === 'string' && id.length >= 2 && id.length <= 64 && ID_RE.test(id); }
function closeCode(c) { return (Number.isInteger(c) && c >= 3000 && c <= 4999) || SENDABLE_CLOSE.has(c) ? c : 1011; }

function errorOf(e) {
  const out = {
    code: (e && typeof e.code === 'string' && e.code.length <= 32) ? e.code : 'edge_error',
    message: String((e && e.message) || e).slice(0, 300),
  };
  if (e && isObj(e.data)) out.data = e.data;
  return out;
}

/** HTTP-Antwort auf einen Upgrade-Socket schreiben und schließen. */
function refuse(socket, status) {
  const text = http.STATUS_CODES[status] || 'Error';
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* zu */ }
}

class EdgeBridge {
  /**
   * @param {object} o
   * @param {string} o.runDir                 Ordner des Sockets (edge-run)
   * @param {() => ({serverUrl, apiToken, serverAddrs}|null)} o.upstream  Server-Zugang des Gateways
   * @param {object} o.guard                  makeLanGuard() mit Tunnel- und Server-Adressen
   * @param {object} [o.mdns]                 MdnsService (gemeinsam für alle Edge-Teile)
   * @param {object} [o.mqtt]                 MqttManager (nur mit Volume edge-mqtt-conf)
   */
  constructor({ runDir, upstream, guard, mdns = null, mqtt = null, logger, WebSocketImpl = WebSocket, timing = {}, download = packages.download } = {}) {
    this.runDir = runDir;
    this.socketPath = path.join(runDir, SOCKET_NAME);
    this.upstream = upstream;
    this.guard = guard;
    this.mdns = mdns;
    this.mqtt = mqtt;
    this.logger = logger || { info() {}, warn() {}, debug() {}, error() {} };
    this.WS = WebSocketImpl;
    this.timing = { ...TIMING, ...timing };
    this.download = download;
    this.server = null;
    this.relay = null;   // { local, upstream, timer, lastSeen }
    this.rpc = null;     // WebSocket des Edge-Hosts
    this.desired = null; // mitgelesener Sollzustand (parseState)
    this.plugins = new Map(); // id → { caps, net }
    this.inflight = 0;
    if (this.mqtt) this.mqtt.onChange = () => this.sendInfo();
    const handleProtocols = (want) => (protocols) => (protocols.has(want) ? want : false);
    this.wssRelay = new WebSocket.Server({ noServer: true, clientTracking: false, maxPayload: LIMITS.frameBytes, perMessageDeflate: false, handleProtocols: handleProtocols(PROTOCOL) });
    this.wssRpc = new WebSocket.Server({ noServer: true, clientTracking: false, maxPayload: RPC_MAX_BYTES, perMessageDeflate: false, handleProtocols: handleProtocols(RPC_PROTOCOL) });
  }

  // ─── Lebenszyklus ─────────────────────────────

  async start() {
    if (this.server) return;
    try { fs.unlinkSync(this.socketPath); } catch { /* keiner da */ }
    const server = http.createServer((req, res) => this.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* zu */ } });
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = 10000;
    server.requestTimeout = 120000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => { server.off('error', reject); resolve(); });
    });
    // 0660: Besitzer root (Gateway), Gruppe 61001 (setgid-Ordner) – sonst niemand
    fs.chmodSync(this.socketPath, 0o660);
    this.server = server;
    this.logger.info({ socket: this.socketPath }, 'edge: gateway socket listening');
  }

  async stop() {
    this.closeRelay(1001, 'gateway stopping');
    if (this.rpc) { try { this.rpc.terminate(); } catch { /* zu */ } this.rpc = null; }
    this.closeAllPlugins();
    if (this.mqtt) await this.mqtt.stop();
    if (this.mdns) this.mdns.close();
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => s.close(() => r()));
    try { fs.unlinkSync(this.socketPath); } catch { /* weg */ }
  }

  /** Alle 30 s (EdgeLink): Broker-Dateien bei geänderten LAN-Adressen nachziehen. */
  tick() {
    if (this.mqtt) { try { this.mqtt.refresh(); } catch (e) { this.logger.warn({ err: e.message }, 'edge: mqtt refresh failed'); } }
  }

  // ─── HTTP: Pakete ─────────────────────────────

  onRequest(req, res) {
    const m = req.method === 'GET' ? PACKAGE_RE.exec(req.url || '') : null;
    if (!m) { res.writeHead(404, { 'content-length': 0 }); res.end(); return; }
    let id;
    let version;
    try { id = decodeURIComponent(m[1]); version = decodeURIComponent(m[2]); } catch { id = null; }
    const known = validId(id) && typeof version === 'string' && VERSION_RE.test(version) && this.desired
      && this.desired.plugins.some((p) => p.id === id && p.version === version);
    const up = known ? this.upstream() : null;
    if (!up) { res.writeHead(known ? 503 : 404, { 'content-length': 0 }); res.end(); return; }
    this.download(up, id, version).then((buf) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length });
      res.end(buf);
    }, (e) => {
      const status = e && e.code === 'not_found' ? 404 : 502;
      this.logger.debug({ plugin: id, version, err: e && e.message }, 'edge: package download for the edge container failed');
      res.writeHead(status, { 'content-length': 0 });
      res.end();
    });
  }

  // ─── Upgrade ──────────────────────────────────

  onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const url = (req.url || '').split('?')[0];
    if (req.method !== 'GET') { refuse(socket, 405); return; }
    if (url === WS_PATH) { this.relayUpgrade(req, socket, head); return; }
    if (url === RPC_PATH) { this.wssRpc.handleUpgrade(req, socket, head, (ws) => this.bindRpc(ws)); return; }
    refuse(socket, 404);
  }

  // ─── Relay zum Server ─────────────────────────

  relayUpgrade(req, socket, head) {
    const want = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    if (!want.includes(PROTOCOL)) { refuse(socket, 400); return; }
    const up = this.upstream();
    if (!up || !up.serverUrl || !up.apiToken) { refuse(socket, 503); return; }
    let url;
    try { url = wsUrl(up.serverUrl); } catch { refuse(socket, 503); return; }
    const opts = {
      headers: { Authorization: `Bearer ${up.apiToken}` },
      maxPayload: LIMITS.frameBytes,
      handshakeTimeout: 15000,
      perMessageDeflate: false,
      followRedirects: false,
    };
    if (Array.isArray(up.serverAddrs) && up.serverAddrs.length) opts.lookup = pinnedLookup(() => up.serverAddrs);
    let upstream;
    try { upstream = new this.WS(url, PROTOCOL, opts); } catch { refuse(socket, 502); return; }
    let settled = false;
    const fail = (status) => {
      if (settled) return;
      settled = true;
      refuse(socket, status);
      try { upstream.terminate(); } catch { /* zu */ }
    };
    upstream.on('unexpected-response', (_r, res) => {
      const c = res.statusCode;
      try { res.resume(); } catch { /* egal */ }
      fail(c >= 400 && c <= 599 ? c : 502);
    });
    upstream.on('error', (e) => { this.logger.debug({ err: e.message }, 'edge relay: server not reachable'); fail(502); });
    socket.once('close', () => { if (!settled) { settled = true; try { upstream.terminate(); } catch { /* zu */ } } });
    upstream.on('open', () => {
      if (settled) { try { upstream.terminate(); } catch { /* zu */ } return; }
      if (upstream.protocol !== PROTOCOL) { fail(501); return; } // Server ohne gc-edge.v1 → Edge bleibt still
      settled = true;
      this.wssRelay.handleUpgrade(req, socket, head, (local) => this.bindRelay(local, upstream));
    });
  }

  bindRelay(local, upstream) {
    this.closeRelay(4000, 'replaced');
    const pair = { local, upstream, lastSeen: Date.now(), timer: null };
    this.relay = pair;
    const alive = () => { pair.lastSeen = Date.now(); };
    upstream.on('message', (data, isBinary) => {
      alive();
      if (isBinary) return;
      const text = data.toString('utf8');
      this.observe(text);
      if (local.readyState === 1) local.send(text);
    });
    upstream.on('ping', alive);
    upstream.on('pong', alive);
    local.on('message', (data, isBinary) => {
      if (isBinary || upstream.readyState !== 1) return;
      upstream.send(data.toString('utf8'));
    });
    local.on('error', () => {});
    upstream.on('close', (code, reason) => {
      clearInterval(pair.timer);
      if (local.readyState <= 1) { try { local.close(closeCode(code), String(reason || '').slice(0, 120)); } catch { /* zu */ } }
      if (this.relay === pair) this.relay = null;
    });
    local.on('close', () => {
      clearInterval(pair.timer);
      if (upstream.readyState <= 1) { try { upstream.close(1000, 'edge host closed'); } catch { /* zu */ } }
      if (this.relay === pair) this.relay = null;
    });
    // Lebenszeichen zum Server (der Ping des Edge-Hosts endet hier am Gateway)
    pair.timer = setInterval(() => {
      if (Date.now() - pair.lastSeen > this.timing.pongTimeoutMs) {
        this.logger.warn('edge relay: no answer from the server — closing');
        try { upstream.terminate(); } catch { /* zu */ }
        try { local.terminate(); } catch { /* zu */ }
        return;
      }
      try { upstream.ping(); } catch { /* schließt gerade */ }
    }, this.timing.pingMs);
    if (pair.timer.unref) pair.timer.unref();
    this.logger.info('edge relay: edge channel connected through the gateway');
  }

  closeRelay(code, reason) {
    const p = this.relay;
    if (!p) return;
    this.relay = null;
    clearInterval(p.timer);
    try { p.local.close(code, reason); } catch { /* zu */ }
    try { p.upstream.terminate(); } catch { /* zu */ }
  }

  /** Server → Edge mitlesen: nur `state` (gleiche Prüfung wie im Edge-Host). */
  observe(text) {
    if (text.indexOf('"state"') < 0) return;
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || m.t !== 'state') return;
    let st;
    try { st = parseState(m); } catch (e) { this.logger.debug({ err: e.message }, 'edge relay: invalid state not taken over'); return; }
    this.setDesired(st);
  }

  setDesired(st) {
    this.desired = st;
    for (const id of [...this.plugins.keys()]) if (!this.wanted(id)) this.closePlugin(id, true);
    // Broker nur mit Volume edge-mqtt-conf (neue Compose-Datei); sonst verwaltet ihn der Edge-Host selbst
    if (this.mqtt && this.mqtt.available()) {
      this.mqtt.apply(st.edgeEnabled ? st.mqtt : MQTT_OFF).catch((e) => this.logger.warn({ err: e.message }, 'edge: mqtt apply failed'));
    }
  }

  /** Eintrag des Sollzustands, wenn der Edge-Teil laufen darf – sonst null. */
  wanted(id) {
    const st = this.desired;
    if (!st || !st.edgeEnabled) return null;
    const p = st.plugins.find((x) => x.id === id);
    return p && p.enabled && !p.capsError ? p : null;
  }

  // ─── RPC ──────────────────────────────────────

  bindRpc(ws) {
    if (this.rpc) {
      const old = this.rpc;
      this.rpc = null;
      try { old.close(4000, 'replaced'); } catch { /* zu */ }
      this.closeAllPlugins();
    }
    this.rpc = ws;
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      if (isObj(m)) this.onRpc(ws, m);
    });
    ws.on('close', () => {
      if (this.rpc !== ws) return;
      this.rpc = null;
      this.closeAllPlugins();
    });
    this.sendInfo();
  }

  rpcSend(ws, msg) {
    if (!ws || ws.readyState !== 1) return false;
    const text = JSON.stringify(msg);
    if (Buffer.byteLength(text, 'utf8') > RPC_MAX_BYTES) return false;
    try { ws.send(text); return true; } catch { return false; }
  }

  sendInfo() {
    this.rpcSend(this.rpc, {
      t: 'info',
      mqtt: { available: !!(this.mqtt && this.mqtt.available()) },
      mqttStatus: this.mqtt ? this.mqtt.status() : null,
    });
  }

  onRpc(ws, m) {
    if (m.t === 'close') { if (validId(m.plugin)) this.closePlugin(m.plugin); return; }
    if (m.t !== 'call' || !Number.isInteger(m.id)) return;
    const reply = (o) => {
      if (!this.rpcSend(ws, { t: 'result', id: m.id, ...o }) && o.ok) {
        this.rpcSend(ws, { t: 'result', id: m.id, ok: false, error: { code: 'too_large', message: 'result larger than the gateway socket allows' } });
      }
    };
    if (this.inflight >= MAX_INFLIGHT) { reply({ ok: false, error: { code: 'busy', message: 'too many calls at the gateway' } }); return; }
    this.inflight++;
    let p;
    try { p = this.handleCall(m); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(
      (result) => reply({ ok: true, result: result === undefined ? null : result }),
      (e) => reply({ ok: false, error: errorOf(e) }),
    ).finally(() => { this.inflight--; });
  }

  /** Ein Aufruf eines Edge-Teils: hier wird geprüft, nicht im Edge-Container. */
  handleCall(m) {
    if (!validId(m.plugin)) throw new NetError('bad_request', 'invalid plugin id');
    const api = m.api;
    if (typeof api !== 'string' || (!NET_API_SET.has(api) && !MQTT_APIS.has(api))) throw new NetError('unknown_api', `unknown gc api ${String(api).slice(0, 40)}`);
    const p = this.wanted(m.plugin);
    if (!p) throw new NetError('not_enabled', 'edge part not enabled on this gateway');
    let claimed;
    try { claimed = validateCaps(m.caps, 'caps'); } catch (e) { throw new NetError('bad_request', e.message); }
    const e = this.entry(m.plugin);
    // höchstens, was der Server genehmigt hat – der Edge kann nur einengen
    e.caps = intersectCaps(claimed, p.caps);
    const args = isObj(m.args) ? m.args : {};
    if (MQTT_APIS.has(api)) {
      if (!this.mqtt || !this.mqtt.available()) throw new NetError('not_available', 'MQTT is not available on this gateway');
      return this.mqtt.pluginCall(m.plugin, () => e.caps, api, args, e.toChild);
    }
    return e.net.apis()[api](args);
  }

  entry(id) {
    let e = this.plugins.get(id);
    if (!e) {
      e = { caps: {}, net: null, toChild: null };
      e.toChild = (msg) => this.push(id, msg);
      e.net = new PluginNet({ pluginId: id, caps: () => e.caps, guard: this.guard, mdns: this.mdns, logger: this.logger, toChild: e.toChild });
      this.plugins.set(id, e);
    }
    return e;
  }

  push(plugin, msg) {
    const ws = this.rpc;
    if (!ws || !msg || !PUSH_TYPES.has(msg.t)) return;
    if (ws.bufferedAmount > PUSH_BUFFER_MAX) { this.logger.debug({ plugin }, 'edge: push dropped (edge host not reading)'); return; }
    this.rpcSend(ws, { t: 'push', plugin, msg });
  }

  closePlugin(id, forget = false) {
    const e = this.plugins.get(id);
    if (e) { try { e.net.closeAll(); } catch (err) { this.logger.debug({ err: err.message }, 'edge: close failed'); } }
    if (this.mqtt) this.mqtt.dropPlugin(id);
    if (forget || e) this.plugins.delete(id);
  }

  closeAllPlugins() {
    for (const id of [...this.plugins.keys()]) this.closePlugin(id, true);
  }

  /** Für die Telemetrie: Socket da, Kanal und RPC verbunden. */
  status() {
    return { listening: !!this.server, relay: !!this.relay, rpc: !!this.rpc };
  }
}

module.exports = { EdgeBridge, MQTT_APIS, closeCode };
