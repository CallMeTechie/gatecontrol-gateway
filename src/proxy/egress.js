'use strict';

const net = require('node:net');
const logger = require('../logger');

const DUAL_BIND_OVERLAP_MS = 10_000;

/** Strip the IPv4-mapped-IPv6 prefix from a socket remoteAddress. */
function normalizeIp(addr) {
  if (!addr) return addr;
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** IPv4 dotted-quad → 32-bit unsigned int, or null if not a valid IPv4. */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/**
 * Source-lock check: is `remoteAddr` inside any CIDR in `allowedCidrs`?
 * Empty/missing allowlist ⇒ DENY (default-deny — an egress door must never
 * accept an unconfigured source).
 */
function ipInAllowlist(remoteAddr, allowedCidrs) {
  if (!Array.isArray(allowedCidrs) || allowedCidrs.length === 0) return false;
  const ip = ipv4ToInt(normalizeIp(remoteAddr));
  if (ip === null) return false;
  for (const cidr of allowedCidrs) {
    const [base, prefixStr] = String(cidr).split('/');
    const prefix = prefixStr === undefined ? 32 : parseInt(prefixStr, 10);
    const baseInt = ipv4ToInt(base);
    if (baseInt === null || !(prefix >= 0 && prefix <= 32)) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((ip & mask) === (baseInt & mask)) return true;
  }
  return false;
}

/**
 * Mirror of TcpProxyManager, reversed: binds a listener on a LAN IP and
 * forwards accepted connections INTO the tunnel toward a server-side
 * endpoint. Source-locked (default-deny) per route.
 */
class EgressProxyManager {
  constructor() {
    this._listeners = new Map(); // id → { server, port, route }
    this._status = new Map();     // id → { bound, bind_error, lan_bind_ip, lan_listen_port }
    this._dropCounts = new Map(); // id → number (source-lock rejections)
  }

  listListenerPorts() {
    return [...this._listeners.values()].map(l => l.port).filter(Boolean);
  }

  getStatus() {
    return [...this._status.entries()].map(([id, s]) => ({
      id,
      bound: s.bound,
      bind_error: s.bind_error,
      lan_bind_ip: s.lan_bind_ip,
      lan_listen_port: s.lan_listen_port,
      source_drops: this._dropCounts.get(id) || 0,
    }));
  }

  async setRoutes(egressRoutes) {
    const routes = egressRoutes || [];
    const newIds = new Set(routes.map(r => r.id));
    for (const [id, l] of this._listeners) {
      if (!newIds.has(id)) {
        try {
          await this._stopListener(id, l);
          this._status.delete(id);
          this._dropCounts.delete(id);
        }
        catch (err) { logger.warn({ egressId: id, err: err.message }, 'Failed to stop egress listener — continuing'); }
      }
    }
    // Review-I1: failed binds live in _status but NOT _listeners (bind threw before
    // _listeners.set ran) — the loop above never prunes them; clean up explicitly.
    for (const id of [...this._status.keys()]) {
      if (!newIds.has(id)) { this._status.delete(id); this._dropCounts.delete(id); }
    }
    // Per-route isolation: a bind failure must NOT abort the loop and must NOT
    // reject (runs in the async 'change' listener — a reject crash-loops the gateway).
    for (const route of routes) {
      try {
        const existing = this._listeners.get(route.id);
        if (!existing) {
          await this._startListener(route);
        } else if (this._bindChanged(existing.route, route)) {
          await this._transitionListener(route, existing);
        } else if (this._softChanged(existing.route, route)) {
          Object.assign(existing.route, route);
          logger.info({ egressId: route.id }, 'Egress route updated in place (no rebind)');
        }
      } catch (err) {
        this._status.set(route.id, {
          bound: false, bind_error: err.code || err.message,
          lan_bind_ip: route.lan_bind_ip, lan_listen_port: route.lan_listen_port,
        });
        logger.error(
          { egressId: route.id, lanBind: `${route.lan_bind_ip}:${route.lan_listen_port}`, err: err.code || err.message },
          'Failed to apply egress route — skipping it; other routes unaffected',
        );
      }
    }
  }

  // _bindChanged: fields that determine the kernel listen socket (require a rebind).
  _bindChanged(a, b) {
    return a.lan_bind_ip !== b.lan_bind_ip || a.lan_listen_port !== b.lan_listen_port;
  }

  // _softChanged: fields read per-connection in _handleConnection (apply in place, no rebind).
  _softChanged(a, b) {
    return a.tunnel_target_host !== b.tunnel_target_host
      || a.tunnel_target_port !== b.tunnel_target_port
      || JSON.stringify([...(a.allowed_source_ips || [])].sort()) !== JSON.stringify([...(b.allowed_source_ips || [])].sort());
  }

  async _startListener(route) {
    const server = net.createServer(socket => this._handleConnection(socket, route));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(route.lan_listen_port, route.lan_bind_ip, () => { server.off('error', reject); resolve(); });
    });
    const port = server.address().port;
    logger.info({ egressId: route.id, bind: `${route.lan_bind_ip}:${port}`, target: `${route.tunnel_target_host}:${route.tunnel_target_port}` }, 'Egress listener started');
    this._listeners.set(route.id, { server, port, route });
    this._status.set(route.id, {
      bound: true, bind_error: null,
      lan_bind_ip: route.lan_bind_ip, lan_listen_port: port,
    });
  }

  async _stopListener(id, l) {
    logger.info({ egressId: id, port: l.port }, 'Egress listener stopping');
    await new Promise(resolve => l.server.close(resolve));
    this._listeners.delete(id);
  }

  async _transitionListener(route, existing) {
    logger.info({ egressId: route.id }, 'Egress listener transition (dual-bind overlap)');
    const newServer = net.createServer(socket => this._handleConnection(socket, route));
    await new Promise((resolve, reject) => {
      newServer.once('error', reject);
      newServer.listen(route.lan_listen_port, route.lan_bind_ip, () => { newServer.off('error', reject); resolve(); });
    });
    const newPort = newServer.address().port;
    const oldL = existing;
    this._listeners.set(route.id, { server: newServer, port: newPort, route });
    this._status.set(route.id, {
      bound: true, bind_error: null,
      lan_bind_ip: route.lan_bind_ip, lan_listen_port: newPort,
    });
    setTimeout(async () => {
      await new Promise(r => oldL.server.close(r));
      logger.info({ egressId: route.id, oldPort: oldL.port, newPort }, 'Dual-bind overlap expired, old egress listener closed');
    }, DUAL_BIND_OVERLAP_MS);
  }

  _handleConnection(clientSocket, route) {
    const src = clientSocket.remoteAddress;
    if (!ipInAllowlist(src, route.allowed_source_ips)) {
      logger.warn({ egressId: route.id, src: normalizeIp(src) }, 'Egress connection rejected — source not in allowlist');
      this._dropCounts.set(route.id, (this._dropCounts.get(route.id) || 0) + 1);
      try { clientSocket.destroy(); } catch (_e) { /* already destroyed */ }
      return;
    }
    const upstream = net.connect(route.tunnel_target_port, route.tunnel_target_host);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    const onCloseOrError = () => {
      try { upstream.destroy(); } catch (_e) { /* already destroyed */ }
      try { clientSocket.destroy(); } catch (_e) { /* already destroyed */ }
    };
    clientSocket.on('error', onCloseOrError);
    upstream.on('error', onCloseOrError);
    clientSocket.on('close', onCloseOrError);
    upstream.on('close', onCloseOrError);
  }

  async stopAll() {
    for (const [id, l] of [...this._listeners]) {
      await this._stopListener(id, l);
    }
  }
}

module.exports = { EgressProxyManager, ipInAllowlist, normalizeIp, DUAL_BIND_OVERLAP_MS };
