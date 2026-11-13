'use strict';

const net = require('node:net');
const os = require('node:os');
const logger = require('../logger');

const DUAL_BIND_OVERLAP_MS = 10_000;
const DIRECT_PROBE_TIMEOUT_MS = 1_000;

// Why a listener could not be opened, as the heartbeat reports it
// (l4_listener_issues[].reason). The server turns it into a hint.
const BIND_REASONS = {
  EADDRINUSE: 'port_in_use',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EADDRNOTAVAIL: 'address_unavailable',
};
function bindReason(code) {
  return Object.prototype.hasOwnProperty.call(BIND_REASONS, code) ? BIND_REASONS[code] : 'error';
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) out.push(String(a.address).toLowerCase());
  }
  return out;
}

/**
 * Does the route point at this very host, on the port it listens on? Then a
 * service of the host that already holds the port IS the target — there is
 * nothing to forward (see _noteBindFailure).
 */
function isSelfTarget(route, bindIp, addrs = localAddresses()) {
  const lp = Number(route.listen_port);
  if (!Number.isInteger(lp) || lp <= 0 || Number(route.target_lan_port) !== lp) return false;
  const host = String(route.target_lan_host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'))) return true;
  return host === String(bindIp || '').toLowerCase() || addrs.includes(host);
}

function probeTcp(host, port, timeoutMs = DIRECT_PROBE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

const sameRoute = (a, b) => a.listen_port === b.listen_port
  && a.target_lan_host === b.target_lan_host && a.target_lan_port === b.target_lan_port;

class TcpProxyManager {
  constructor({ bindIp, localAddrs = localAddresses, probe = probeTcp }) {
    this.bindIp = bindIp;
    this._localAddrs = localAddrs;
    this._probe = probe;
    this._listeners = new Map(); // id → { server, port, target }
    // id → { route_id, listen_port, reason, code }: routes without a listener
    this._failures = new Map();
    // id → { route, listen_port }: routes whose port the target service of
    // this host holds itself — served without a listener (_noteBindFailure)
    this._direct = new Map();
  }

  listListenerPorts() {
    return [...this._listeners.values()].map(l => l.port).filter(Boolean);
  }

  /** Routes without a listener and why: [{ route_id, listen_port, reason, code }]. */
  listListenerIssues() {
    return [...this._failures.values()].map(f => ({ ...f }));
  }

  /** Routes the target service of this host answers itself: [{ route_id, listen_port }]. */
  listDirectRoutes() {
    return [...this._direct.entries()].map(([id, d]) => ({ route_id: id, listen_port: d.listen_port }));
  }

  /**
   * A listener could not be opened. One case is no failure: the port is taken
   * (EADDRINUSE) and the route points at this host on that same port — then
   * the target service itself holds the port on the address the server dials
   * (the gateway runs in the host network), and a connection probe to that
   * address proves it answers there. Such a route is served directly, without
   * a listener; it is kept as "direct" and not bound again while it stays
   * unchanged, so the gateway never takes the port away from the service when
   * that restarts. Everything else is recorded with its reason.
   */
  async _noteBindFailure(route, err) {
    const code = (err && err.code) || null;
    if (code === 'EADDRINUSE' && isSelfTarget(route, this.bindIp, this._localAddrs())
        && await this._probe(this.bindIp, route.listen_port)) {
      this._failures.delete(route.id);
      this._direct.set(route.id, { route, listen_port: route.listen_port });
      logger.info(
        { routeId: route.id, listenPort: route.listen_port },
        'TCP route targets this host on its own listen port and the service holds it — served directly, no listener',
      );
      return true;
    }
    this._direct.delete(route.id);
    this._failures.set(route.id, {
      route_id: route.id,
      listen_port: route.listen_port,
      reason: bindReason(code),
      ...(code ? { code } : {}),
    });
    return false;
  }

  async setRoutes(l4Routes) {
    const newIds = new Set(l4Routes.map(r => r.id));
    // Remove listeners no longer in config
    for (const [id, l] of this._listeners) {
      if (!newIds.has(id)) {
        try {
          await this._stopListener(id, l);
        } catch (err) {
          logger.warn({ routeId: id, err: err.message }, 'Failed to stop TCP listener — continuing');
        }
      }
    }
    for (const id of [...this._failures.keys()]) if (!newIds.has(id)) this._failures.delete(id);
    for (const id of [...this._direct.keys()]) if (!newIds.has(id)) this._direct.delete(id);
    // Add or update. Each route is isolated: a failure to bind one listener
    // (e.g. EADDRINUSE — a host process owns the port under network_mode:host,
    // or two routes share a listen_port) must NOT abort the others, and must
    // NOT reject this method. setRoutes runs inside an async EventEmitter
    // 'change' listener (bootstrap.js), where a rejection is unhandled and —
    // on Node's default mode — would crash-loop the gateway. Skip + log instead.
    for (const route of l4Routes) {
      try {
        const existing = this._listeners.get(route.id);
        if (!existing) {
          const direct = this._direct.get(route.id);
          if (direct && sameRoute(direct.route, route)) continue;
          this._direct.delete(route.id);
          await this._startListener(route);
          this._failures.delete(route.id);
        } else if (existing.target.port !== route.target_lan_port
                || existing.target.host !== route.target_lan_host
                || existing.listenPortRequested !== route.listen_port
                || route._forcePortChange) {
          // Port- or target-change → dual-bind overlap
          await this._transitionListener(route, existing);
        }
      } catch (err) {
        // a failed transition keeps the old listener — only a route without
        // any listener is a missing one
        if (!this._listeners.has(route.id) && await this._noteBindFailure(route, err)) continue;
        logger.error(
          { routeId: route.id, listenPort: route.listen_port, err: err.code || err.message },
          'Failed to apply TCP route — skipping it; other routes unaffected',
        );
      }
    }
  }

  async _startListener(route) {
    const server = net.createServer(socket => this._handleConnection(socket, route));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(route.listen_port, this.bindIp, () => { server.off('error', reject); resolve(); });
    });
    const port = server.address().port;
    logger.info({ routeId: route.id, port, target: `${route.target_lan_host}:${route.target_lan_port}` }, 'TCP listener started');
    this._listeners.set(route.id, {
      server, port,
      target: { host: route.target_lan_host, port: route.target_lan_port },
      listenPortRequested: route.listen_port,
    });
  }

  async _stopListener(id, l) {
    logger.info({ routeId: id, port: l.port }, 'TCP listener stopping');
    await new Promise(resolve => l.server.close(resolve));
    this._listeners.delete(id);
  }

  async _transitionListener(route, existing) {
    logger.info({ routeId: route.id }, 'TCP listener transition (dual-bind overlap)');
    // Start new listener BEFORE closing old
    const newServer = net.createServer(socket => this._handleConnection(socket, route));
    await new Promise((resolve, reject) => {
      newServer.once('error', reject);
      newServer.listen(route.listen_port, this.bindIp, () => { newServer.off('error', reject); resolve(); });
    });
    const newPort = newServer.address().port;

    // Store as new listener under a temp key, swap after overlap
    const oldL = existing;
    this._listeners.set(route.id, {
      server: newServer, port: newPort,
      target: { host: route.target_lan_host, port: route.target_lan_port },
      listenPortRequested: route.listen_port,
    });

    setTimeout(async () => {
      await new Promise(r => oldL.server.close(r));
      logger.info({ routeId: route.id, oldPort: oldL.port, newPort }, 'Dual-bind overlap expired, old listener closed');
    }, DUAL_BIND_OVERLAP_MS);
  }

  _handleConnection(clientSocket, route) {
    const upstream = net.connect(route.target_lan_port, route.target_lan_host);
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
    this._failures.clear();
    this._direct.clear();
  }
}

module.exports = { TcpProxyManager, DUAL_BIND_OVERLAP_MS, isSelfTarget, bindReason };
