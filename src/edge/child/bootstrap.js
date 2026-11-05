'use strict';

// Startdatei eines Edge-Plugin-Prozesses (docs/edge.md "Isolation").
//
// Gestartet vom Edge-Host (src/edge/pluginProcess.js) mit child_process.fork
// und Nodes Permission-Model: --permission (Node 20: --experimental-
// permission), --allow-fs-read = diese Datei + der Code-Ordner des Plugins,
// KEIN --allow-fs-write, keine Kindprozesse, Worker, Addons, Inspector oder
// WASI; --max-old-space-size = memoryMb; leere Umgebung.
//
// Was das Permission-Model nicht abdeckt, wird hier vor dem Plugin-Code in
// JavaScript geschlossen (wie am Server, gatecontrol
// src/services/plugins/child/bootstrap.js): Signale an andere Prozesse,
// process.binding & Co., eine Sperrliste eingebauter Module und alle
// verbindenden Netzfunktionen (net, tls, dgram, http, https, http2, fetch,
// WebSocket). Netzwerk gibt es nur über gc.lan.* / gc.mqtt.* – der Edge-Host
// führt es aus und prüft dort Fähigkeiten und LAN-Grenzen. Außen liegt
// zusätzlich die Netzgrenze des Gateway-Containers (Owner-Match auf die UID).
//
// Muss ohne Abhängigkeiten auskommen: nur diese Datei ist für den Prozess lesbar.

const Module = require('node:module');
const { Duplex } = require('node:stream');

const DENIED_MODULES = new Set(['child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises', 'repl',
  'wasi', 'sqlite', 'trace_events', 'v8', 'dns', 'dns/promises']);

function denied(what) {
  return function deniedApi() {
    const e = new Error(`${what} is not available to edge plugins (docs/edge.md)`);
    e.code = 'denied';
    throw e;
  };
}

function bare(name) { return String(name).replace(/^node:/, ''); }

function lockdown() {
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const tls = require('node:tls');
  const dgram = require('node:dgram');
  const http2 = require('node:http2');
  for (const [obj, names, label] of [
    [net, ['connect', 'createConnection', 'createServer'], 'net'],
    [net.Socket.prototype, ['connect'], 'net.Socket'],
    [net.Server.prototype, ['listen'], 'net.Server'],
    [tls, ['connect', 'createServer'], 'tls'],
    [dgram, ['createSocket'], 'dgram'],
    [dgram.Socket.prototype, ['bind', 'send', 'connect'], 'dgram.Socket'],
    [http, ['request', 'get', 'createServer'], 'http'],
    [https, ['request', 'get', 'createServer'], 'https'],
    [http2, ['connect', 'createServer', 'createSecureServer'], 'http2'],
  ]) {
    for (const n of names) {
      try { Object.defineProperty(obj, n, { value: denied(`${label}.${n}`), writable: false, configurable: false }); } catch { /* weiter */ }
    }
  }
  for (const g of ['fetch', 'WebSocket', 'EventSource']) {
    try { Object.defineProperty(globalThis, g, { value: denied(g), writable: false, configurable: false }); } catch { /* weiter */ }
  }

  const self = process.pid;
  const origKill = process.kill.bind(process);
  const lock = (name, value) => {
    try { Object.defineProperty(process, name, { value, writable: false, configurable: false }); } catch { /* weiter */ }
  };
  lock('kill', function kill(pid, sig) {
    if (Number(pid) !== self) throw Object.assign(new Error('signals to other processes are not available to edge plugins'), { code: 'denied' });
    return origKill(pid, sig);
  });
  for (const n of ['_kill', '_debugProcess', '_debugEnd', 'binding', '_linkedBinding', 'dlopen', 'execve',
    'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups', '_startProfilerIdleNotifier', '_stopProfilerIdleNotifier']) {
    if (n in process) lock(n, denied('process.' + n));
  }

  const origGet = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule.bind(process) : null;
  if (origGet) {
    lock('getBuiltinModule', function getBuiltinModule(id) {
      if (DENIED_MODULES.has(bare(id))) denied(bare(id))();
      return origGet(id);
    });
  }
  const origLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (typeof request === 'string' && DENIED_MODULES.has(bare(request))) denied(bare(request))();
    return origLoad.call(this, request, parent, isMain);
  };
  Object.defineProperty(Module, '_load', { writable: false, configurable: false });
  if (typeof Module.registerHooks === 'function') {
    try {
      Module.registerHooks({
        resolve(specifier, context, nextResolve) {
          if (DENIED_MODULES.has(bare(specifier)) && (specifier.startsWith('node:') || Module.isBuiltin(specifier))) denied(bare(specifier))();
          return nextResolve(specifier, context);
        },
      });
    } catch { /* ältere Node-Versionen: Module._load deckt require() ab */ }
  }
  try { Module.syncBuiltinESMExports(); } catch { /* best effort */ }
}

// ─── IPC ────────────────────────────────────────

let seq = 0;
const pending = new Map();
const HOST_TIMEOUT_MS = 40000;

function send(msg) {
  try { process.send(msg); } catch { /* Host weg */ }
}

function hostCall(api, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`gc call ${api} timed out`), { code: 'timeout' })); }, HOST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    send({ t: 'host', id, api, args: args === undefined ? {} : args });
  });
}

// Zusatzfelder, die der Edge-Host an einen Fehler hängen darf (hostResult.data)
const ERROR_DATA_FIELDS = ['sha256', 'expectedSha256', 'certificate'];

/** Fehler eines gc.*-Aufrufs: code + Zusatzfelder des Edge-Hosts (z. B. e.sha256 bei tls_pin_mismatch). */
function hostError(msg) {
  const err = Object.assign(new Error(msg.error || 'gc call failed'), { code: msg.code || 'edge_error' });
  const data = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data) ? msg.data : null;
  if (data) for (const k of ERROR_DATA_FIELDS) if (Object.prototype.hasOwnProperty.call(data, k)) err[k] = data[k];
  return err;
}

function fmt(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, 4000);
}

function toB64(data) {
  if (Buffer.isBuffer(data)) return data.toString('base64');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  return Buffer.from(String(data), 'utf8').toString('base64');
}

// ─── Vom Host gehaltene Ressourcen ──────────────

const udpSockets = new Map();   // handle → { onMessage, handle object }
const tcpSockets = new Map();   // id → EdgeSocket
const browses = new Map();      // id → onFound
const mqttSubs = new Map();     // id → fn

class EdgeSocket extends Duplex {
  constructor(id, info) {
    super();
    this.id = id;
    this.remoteAddress = info.remoteAddress;
    this.remotePort = info.remotePort;
  }
  _write(chunk, _enc, cb) {
    hostCall('tcp.write', { id: this.id, b64: Buffer.from(chunk).toString('base64') }).then(() => cb(), (e) => cb(e));
  }
  _final(cb) { hostCall('tcp.end', { id: this.id }).then(() => cb(), () => cb()); }
  _read() { /* Daten kommen als IPC-Nachrichten */ }
  _destroy(err, cb) {
    if (tcpSockets.has(this.id)) { tcpSockets.delete(this.id); hostCall('tcp.destroy', { id: this.id }).catch(() => null); }
    cb(err);
  }
}

function onHostEvent(m) {
  switch (m.t) {
    case 'udp': {
      const s = udpSockets.get(m.id);
      if (s && typeof s.onMessage === 'function') {
        try { s.onMessage(Buffer.from(String(m.b64 || ''), 'base64'), { address: m.address, port: m.port }); } catch (e) { logError('udp handler: ', e); }
      }
      return;
    }
    case 'sock': {
      const s = tcpSockets.get(m.id);
      if (!s) return;
      if (m.ev === 'data') s.push(Buffer.from(String(m.b64 || ''), 'base64'));
      else if (m.ev === 'end') s.push(null);
      else if (m.ev === 'error') { tcpSockets.delete(m.id); s.destroy(Object.assign(new Error(m.error || 'socket error'), { code: 'net_error' })); }
      else if (m.ev === 'close') { tcpSockets.delete(m.id); s.push(null); s.destroy(); }
      return;
    }
    case 'mdns': {
      const fn = browses.get(m.id);
      if (fn) { try { fn(m.service); } catch (e) { logError('mdns handler: ', e); } }
      return;
    }
    case 'mqtt': {
      const fn = mqttSubs.get(m.id);
      if (fn) { try { fn(m.topic, Buffer.from(String(m.b64 || ''), 'base64'), { retain: !!m.retain, qos: m.qos | 0 }); } catch (e) { logError('mqtt handler: ', e); } }
      return;
    }
    default:
  }
}

function logError(prefix, e) {
  send({ t: 'log', level: 'error', line: prefix + String((e && (e.stack || e.message)) || e).slice(0, 1800) });
}

// ─── gc ─────────────────────────────────────────

const handlers = new Map();
const configListeners = [];
let currentConfig = null;

function makeGc(info) {
  const log = (level) => (...a) => send({ t: 'log', level, line: fmt(a) });
  const udp = Object.freeze({
    /** Port binden (Fähigkeit udp.ports); opts.multicast = Gruppe beitreten (udp.multicast). */
    bind: async (port, opts, onMessage) => {
      if (typeof opts === 'function') { onMessage = opts; opts = {}; }
      const r = await hostCall('udp.bind', { port, multicast: opts && opts.multicast ? [].concat(opts.multicast) : [] });
      const handle = Object.freeze({
        port: r.port,
        send: (host, p, buf) => hostCall('udp.send', { id: r.id, host, port: p, b64: toB64(buf) }),
        close: () => { udpSockets.delete(r.id); return hostCall('udp.close', { id: r.id }).catch(() => null); },
      });
      udpSockets.set(r.id, { onMessage, handle });
      return handle;
    },
    /** Einzelnes Datagramm von einem flüchtigen Port. */
    send: (host, port, buf) => hostCall('udp.send', { host, port, b64: toB64(buf) }),
  });
  const mdns = Object.freeze({
    browse: async (service, onFound) => {
      const r = await hostCall('mdns.browse', { service });
      browses.set(r.id, onFound);
      return Object.freeze({ stop: () => { browses.delete(r.id); return hostCall('mdns.stop', { id: r.id }).catch(() => null); } });
    },
  });
  const tcp = Object.freeze({
    connect: async (host, port) => {
      const r = await hostCall('tcp.connect', { host, port });
      const s = new EdgeSocket(r.id, r);
      tcpSockets.set(r.id, s);
      return s;
    },
  });
  const httpApi = Object.freeze({
    request: async (opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      const body = o.body === undefined || o.body === null ? null
        : (Buffer.isBuffer(o.body) || o.body instanceof Uint8Array || typeof o.body === 'string') ? toB64(o.body) : toB64(JSON.stringify(o.body));
      const r = await hostCall('http.request', { method: o.method || 'GET', url: o.url, headers: o.headers || {}, b64: body, timeoutMs: o.timeoutMs,
        pinSha256: typeof o.pinSha256 === 'string' ? o.pinSha256 : null,
        // gibt es nicht mehr – nur weiterreichen, damit der Edge-Host es ablehnt (denied) statt es still zu ignorieren
        ...(o.insecure !== undefined && o.insecure !== null && o.insecure !== false ? { insecure: true } : {}) });
      const buf = Buffer.from(String(r.b64 || ''), 'base64');
      return Object.freeze({ status: r.status, headers: r.headers || {}, body: buf, text: () => buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
    },
  });
  /** Leaf-Zertifikat eines LAN-Geräts (nur TLS-Handshake): {sha256, subject, issuer, validTo, selfSigned}. */
  const tlsFingerprint = (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    return hostCall('tls.fingerprint', { host: o.host, port: o.port === undefined ? 443 : o.port, timeoutMs: o.timeoutMs });
  };
  return Object.freeze({
    id: info.id,
    version: info.version,
    handle: (method, fn) => {
      if (typeof method !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(method)) throw new Error('gc.handle: invalid method name');
      if (typeof fn !== 'function') throw new Error('gc.handle: handler must be a function');
      handlers.set(method, fn);
    },
    emit: (name, data) => {
      if (typeof name !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(name)) throw new Error('gc.emit: invalid event name');
      send({ t: 'event', name, data: data === undefined ? null : data });
    },
    config: () => currentConfig,
    onConfig: (fn) => { if (typeof fn === 'function') configListeners.push(fn); },
    store: Object.freeze({
      get: (key) => hostCall('store.get', { key }),
      set: (key, value) => hostCall('store.set', { key, value }),
      delete: (key) => hostCall('store.delete', { key }),
    }),
    log: Object.freeze({ info: log('info'), warn: log('warn'), error: log('error') }),
    lan: Object.freeze({ udp, mdns, tcp, http: httpApi, tlsFingerprint }),
    mqtt: Object.freeze({
      subscribe: async (topic, fn) => {
        const r = await hostCall('mqtt.subscribe', { topic });
        mqttSubs.set(r.id, fn);
        return Object.freeze({ unsubscribe: () => { mqttSubs.delete(r.id); return hostCall('mqtt.unsubscribe', { id: r.id }).catch(() => null); } });
      },
      publish: (topic, payload, opts) => hostCall('mqtt.publish', { topic, b64: toB64(payload === undefined || payload === null ? '' : payload),
        retain: !!(opts && opts.retain), qos: opts && opts.qos === 1 ? 1 : 0 }),
    }),
    serial: Object.freeze({
      open: (name, opts) => hostCall('serial.open', { name, baudRate: opts && opts.baudRate }),
    }),
  });
}

let plugin = null;
let gc = null;

function safeValue(v) {
  try { return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch { return null; }
}

async function handleCall(method, params) {
  const fn = handlers.get(method);
  if (!fn) throw Object.assign(new Error(`unknown method ${String(method).slice(0, 64)}`), { code: 'unknown_method' });
  return fn(params, gc);
}

function applyConfig(data) {
  currentConfig = data === undefined ? null : data;
  for (const fn of configListeners) {
    try { const r = fn(currentConfig, gc); if (r && typeof r.catch === 'function') r.catch((e) => logError('onConfig: ', e)); } catch (e) { logError('onConfig: ', e); }
  }
}

async function init(info) {
  lockdown();
  currentConfig = info.config === undefined ? null : info.config;
  gc = makeGc(info);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    // eslint-disable-next-line no-console
    console[level] = (...a) => send({ t: 'log', level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', line: fmt(a) });
  }
  let mod = require(info.entry);
  if (mod && mod.__esModule && mod.default) mod = mod.default;
  if (typeof mod === 'function') mod = await mod(gc);
  plugin = mod && typeof mod === 'object' ? mod : {};
  if (typeof plugin.start === 'function') await plugin.start(gc);
  send({ t: 'ready' });
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'init':
      init(msg.plugin).catch((e) => {
        send({ t: 'fatal', error: String((e && (e.stack || e.message)) || e).slice(0, 2000) });
        setTimeout(() => process.exit(1), 50);
      });
      return;
    case 'hostResult': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(hostError(msg));
      return;
    }
    case 'call':
      Promise.resolve()
        .then(() => handleCall(msg.method, msg.params))
        .then((v) => send({ t: 'result', id: msg.id, ok: true, value: safeValue(v) }),
          (e) => send({ t: 'result', id: msg.id, ok: false, code: (e && typeof e.code === 'string' && e.code.length <= 32) ? e.code : 'edge_error',
            error: String((e && e.message) || e).slice(0, 500) }));
      return;
    case 'configure':
      applyConfig(msg.data);
      return;
    case 'ping':
      send({ t: 'pong', id: msg.id });
      return;
    case 'stop':
      Promise.resolve()
        .then(() => (plugin && typeof plugin.stop === 'function' ? plugin.stop(gc) : null))
        .catch(() => {})
        .then(() => process.exit(0));
      return;
    default:
      onHostEvent(msg);
  }
});

process.on('uncaughtException', (e) => {
  logError('uncaught: ', e);
  setTimeout(() => process.exit(1), 20);
});
process.on('unhandledRejection', (e) => logError('unhandled rejection: ', e));
process.on('disconnect', () => process.exit(0));
