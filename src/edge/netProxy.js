'use strict';

// Netzwerk der Edge-Teile, ausgeführt im Edge-Host (Vertrag Abschnitt 5).
// Der Plugin-Prozess selbst hat keine Netzfunktionen (Sperre im Bootstrap);
// jede gc.lan.*-Anfrage kommt über IPC hierher und wird gegen die wirksamen
// Fähigkeiten und die LAN-Grenzen geprüft – zentral an einer Stelle.

const dgram = require('node:dgram');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const { LIMITS } = require('./constants');
const { DeniedError, checkPort } = require('./lanGuard');

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization']);
const TCP_CONNECT_TIMEOUT_MS = 10000;

class NetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function decodeB64(b64, max) {
  if (b64 === null || b64 === undefined) return Buffer.alloc(0);
  if (typeof b64 !== 'string') throw new NetError('bad_request', 'payload must be base64');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > max) throw new NetError('too_large', `payload larger than ${max} bytes`);
  return buf;
}

/** IPv4-Adressen der LAN-Schnittstellen (für Multicast-Beitritte). */
function lanInterfaceAddrs(guard) {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && guard.allowed(a.address)) out.push(a.address);
  }
  return out;
}

class PluginNet {
  /**
   * @param {object} o
   * @param {string} o.pluginId
   * @param {() => object} o.caps   wirksame Fähigkeiten
   * @param {object} o.guard        makeLanGuard()
   * @param {(msg:object)=>void} o.toChild
   * @param {object} [o.mdns]       MdnsService
   */
  constructor({ pluginId, caps, guard, toChild, mdns, logger }) {
    this.pluginId = pluginId;
    this.caps = caps;
    this.guard = guard;
    this.toChild = toChild;
    this.mdns = mdns;
    this.logger = logger || { debug() {}, warn() {} };
    this.udp = new Map();
    this.tcp = new Map();
    this.browses = new Map();
    this.ephemeral = null;
    this.nextId = 0;
  }

  apis() {
    return {
      'udp.bind': (a) => this.udpBind(a),
      'udp.send': (a) => this.udpSend(a),
      'udp.close': (a) => this.udpClose(a),
      'tcp.connect': (a) => this.tcpConnect(a),
      'tcp.write': (a) => this.tcpWrite(a),
      'tcp.end': (a) => this.tcpEnd(a),
      'tcp.destroy': (a) => this.tcpDestroy(a),
      'http.request': (a) => this.httpRequest(a),
      'mdns.browse': (a) => this.mdnsBrowse(a),
      'mdns.stop': (a) => this.mdnsStop(a),
      'serial.open': (a) => this.serialOpen(a),
    };
  }

  need(cond, what) {
    if (!cond) throw new DeniedError(`capability ${what} not approved for this plugin`);
  }

  // ─── UDP ───────────────────────────────────────

  async udpBind({ port, multicast = [] }) {
    const c = this.caps().udp;
    this.need(c && Number.isInteger(port) && c.ports.includes(port), `udp port ${port}`);
    const groups = Array.isArray(multicast) ? multicast : [];
    for (const g of groups) this.need(c.multicast.includes(g), `udp multicast ${g}`);
    if (this.udp.size >= LIMITS.udpSocketsPerPlugin) throw new NetError('busy', 'too many UDP sockets');
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: groups.length > 0 });
    const id = ++this.nextId;
    await new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(port, () => { sock.off('error', reject); resolve(); });
    }).catch((e) => { try { sock.close(); } catch { /* zu */ } throw new NetError('net_error', `udp bind ${port}: ${e.code || e.message}`); });
    for (const g of groups) {
      const ifs = lanInterfaceAddrs(this.guard);
      if (!ifs.length) { try { sock.addMembership(g); } catch { /* ohne LAN keine Gruppe */ } }
      for (const ip of ifs) { try { sock.addMembership(g, ip); } catch (e) { this.logger.debug({ err: e.message, g, ip }, 'edge: addMembership failed'); } }
    }
    sock.on('message', (msg, rinfo) => {
      // nur Absender aus dem LAN (Antworten auf Multicast kommen von LAN-Geräten)
      if (!this.guard.allowed(rinfo.address)) return;
      this.toChild({ t: 'udp', id, b64: msg.subarray(0, LIMITS.udpDatagramBytes).toString('base64'), address: rinfo.address, port: rinfo.port });
    });
    sock.on('error', (e) => this.logger.debug({ err: e.message, plugin: this.pluginId }, 'edge: udp socket error'));
    this.udp.set(id, sock);
    return { id, port };
  }

  async udpSend({ id, host, port, b64 }) {
    const c = this.caps().udp;
    this.need(!!c, 'udp');
    this.guard.check(host, { multicast: c.multicast });
    checkPort(port);
    const buf = decodeB64(b64, LIMITS.udpDatagramBytes);
    let sock;
    if (id !== undefined && id !== null) {
      sock = this.udp.get(id);
      if (!sock) throw new NetError('not_found', 'udp socket closed');
    } else {
      if (!this.ephemeral) {
        this.ephemeral = dgram.createSocket('udp4');
        this.ephemeral.on('error', () => {});
        this.ephemeral.on('message', (msg, rinfo) => {
          if (!this.guard.allowed(rinfo.address)) return;
          this.toChild({ t: 'udp', id: 0, b64: msg.subarray(0, LIMITS.udpDatagramBytes).toString('base64'), address: rinfo.address, port: rinfo.port });
        });
      }
      sock = this.ephemeral;
    }
    await new Promise((resolve, reject) => sock.send(buf, port, host, (e) => (e ? reject(new NetError('net_error', `udp send: ${e.code || e.message}`)) : resolve())));
    return {};
  }

  udpClose({ id }) {
    const s = this.udp.get(id);
    if (s) { this.udp.delete(id); try { s.close(); } catch { /* zu */ } }
    return {};
  }

  // ─── TCP ───────────────────────────────────────

  tcpConnect({ host, port }) {
    const c = this.caps().tcp;
    this.need(c && c.lan === true, 'tcp.lan');
    this.guard.check(host);
    checkPort(port);
    if (this.tcp.size >= LIMITS.tcpSocketsPerPlugin) throw new NetError('busy', 'too many TCP connections');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      let open = false;
      const t = setTimeout(() => { sock.destroy(); reject(new NetError('timeout', 'tcp connect timed out')); }, TCP_CONNECT_TIMEOUT_MS);
      sock.once('connect', () => {
        clearTimeout(t);
        open = true;
        this.tcp.set(id, sock);
        resolve({ id, remoteAddress: sock.remoteAddress, remotePort: sock.remotePort });
      });
      sock.on('data', (d) => this.toChild({ t: 'sock', id, ev: 'data', b64: d.toString('base64') }));
      sock.on('end', () => this.toChild({ t: 'sock', id, ev: 'end' }));
      sock.on('error', (e) => {
        clearTimeout(t);
        if (!open) reject(new NetError('net_error', `tcp connect: ${e.code || e.message}`));
        else this.toChild({ t: 'sock', id, ev: 'error', error: e.code || e.message });
      });
      sock.on('close', () => { if (this.tcp.delete(id)) this.toChild({ t: 'sock', id, ev: 'close' }); });
    });
  }

  tcpSocket(id) {
    const s = this.tcp.get(id);
    if (!s) throw new NetError('not_found', 'connection closed');
    return s;
  }

  async tcpWrite({ id, b64 }) {
    const s = this.tcpSocket(id);
    const buf = decodeB64(b64, LIMITS.tcpWriteBufferBytes);
    if (s.writableLength + buf.length > LIMITS.tcpWriteBufferBytes) throw new NetError('busy', 'write buffer full');
    await new Promise((resolve, reject) => s.write(buf, (e) => (e ? reject(new NetError('net_error', e.message)) : resolve())));
    return {};
  }

  tcpEnd({ id }) { const s = this.tcp.get(id); if (s) s.end(); return {}; }

  tcpDestroy({ id }) { const s = this.tcp.get(id); if (s) { this.tcp.delete(id); s.destroy(); } return {}; }

  // ─── HTTP ──────────────────────────────────────

  httpRequest({ method = 'GET', url, headers = {}, b64 = null, timeoutMs }) {
    const c = this.caps().http;
    this.need(c && c.lan === true, 'http.lan');
    let u;
    try { u = new URL(String(url)); } catch { throw new NetError('bad_request', 'invalid url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NetError('bad_request', 'only http and https');
    if (u.username || u.password) throw new NetError('bad_request', 'credentials in the url are not allowed (use a header)');
    this.guard.check(u.hostname);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    checkPort(port);
    const m = String(method).toUpperCase();
    if (!HTTP_METHODS.has(m)) throw new NetError('bad_request', `method ${m} not allowed`);
    const body = decodeB64(b64, LIMITS.httpRequestBytes);
    const hdrs = {};
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        const key = String(k).toLowerCase();
        if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key) || HOP_HEADERS.has(key)) continue;
        if (typeof v !== 'string' && typeof v !== 'number') continue;
        const val = String(v);
        if (/[\r\n\0]/.test(val) || val.length > 4096) continue;
        hdrs[key] = val;
      }
    }
    if (body.length) hdrs['content-length'] = String(body.length);
    const limit = Math.max(1000, Math.min(LIMITS.httpTimeoutMaxMs, Number.isFinite(timeoutMs) ? timeoutMs : LIMITS.httpTimeoutMaxMs));
    const mod = u.protocol === 'https:' ? https : http;
    // LAN-Geräte haben fast immer selbstsignierte Zertifikate (wie die HTTPS-Routen ohne Pin)
    const opts = { method: m, headers: hdrs, agent: false, timeout: limit, ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}) };
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => req.destroy(new NetError('timeout', 'http request timed out')), limit);
      const req = mod.request(u, opts, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (d) => {
          size += d.length;
          if (size > LIMITS.httpResponseBytes) { req.destroy(new NetError('too_large', 'response larger than 5 MB')); return; }
          chunks.push(d);
        });
        res.on('end', () => {
          clearTimeout(deadline);
          const out = {};
          for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
          resolve({ status: res.statusCode, headers: out, b64: Buffer.concat(chunks).toString('base64') });
        });
        res.on('error', (e) => { clearTimeout(deadline); reject(e instanceof NetError ? e : new NetError('net_error', e.message)); });
      });
      req.on('timeout', () => req.destroy(new NetError('timeout', 'http request timed out')));
      req.on('error', (e) => { clearTimeout(deadline); reject(e instanceof NetError ? e : new NetError('net_error', `http: ${e.code || e.message}`)); });
      if (body.length) req.write(body);
      req.end();
    });
  }

  // ─── mDNS ──────────────────────────────────────

  mdnsBrowse({ service }) {
    const c = this.caps().mdns;
    this.need(c && c.services.includes(service), `mdns ${service}`);
    if (!this.mdns) throw new NetError('not_available', 'mDNS not available');
    if (this.browses.size >= LIMITS.mdnsBrowsesPerPlugin) throw new NetError('busy', 'too many mDNS browses');
    const id = ++this.nextId;
    const mid = this.mdns.browse(service, (found) => {
      if (!this.guard.allowed(found.ip)) return;
      this.toChild({ t: 'mdns', id, service: found });
    });
    this.browses.set(id, mid);
    return { id };
  }

  mdnsStop({ id }) {
    const mid = this.browses.get(id);
    if (mid !== undefined) { this.browses.delete(id); this.mdns.stopBrowse(mid); }
    return {};
  }

  // ─── Seriell (v1: Fähigkeit wird geprüft, Gerät noch nicht durchgereicht) ──

  serialOpen({ name }) {
    const s = this.caps().serial;
    this.need(Array.isArray(s) && s.includes(name), `serial ${name}`);
    throw new NetError('not_available', 'serial devices are not passed to the edge container yet');
  }

  closeAll() {
    for (const s of this.udp.values()) { try { s.close(); } catch { /* zu */ } }
    this.udp.clear();
    if (this.ephemeral) { try { this.ephemeral.close(); } catch { /* zu */ } this.ephemeral = null; }
    for (const s of this.tcp.values()) s.destroy();
    this.tcp.clear();
    for (const mid of this.browses.values()) this.mdns.stopBrowse(mid);
    this.browses.clear();
  }
}

module.exports = { PluginNet, NetError };
