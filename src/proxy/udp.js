'use strict';

// UDP-Weiterleitung der TCP/UDP-Routen (docs/udp.md).
//
// Der Server (Caddy, caddy-l4) schickt die Datagramme einer UDP-Route an
// <Tunnel-IP>:<listen_port> des Gateways; das Gateway gibt sie an
// target_lan_host:target_lan_port im Heimnetz weiter. UDP kennt keine
// Verbindung – deshalb bekommt jeder Absender (Quell-IP:Port, praktisch: eine
// Sitzung von Caddy) einen eigenen Upstream-Socket. Antworten des Ziels kommen
// auf diesem Socket an und gehen an genau diesen Absender zurück.
//
// - Der Upstream-Socket ist mit dem Ziel „verbunden“ (connect): der Kernel
//   nimmt nur Datagramme von target_lan_host:target_lan_port an, ein anderes
//   Gerät im LAN kann nichts in die Sitzung schieben, und ein ICMP „port
//   unreachable“ kommt als ECONNREFUSED an.
// - Leerlauf: eine Zuordnung ohne Datagramm in beide Richtungen wird nach
//   idleTimeoutMs (Standard 60 s) geschlossen.
// - Obergrenze je Route (maxSessions, Standard 1024): ist sie erreicht, wird
//   die am längsten ruhende Zuordnung freigegeben, wenn sie mindestens
//   EVICT_MIN_IDLE_MS ruht; sonst wird das neue Datagramm verworfen (gezählt).
// - Broadcast und Multicast werden bewusst nicht unterstützt: ein solches Ziel
//   wird abgelehnt, und ohne SO_BROADCAST lehnt der Kernel das Senden an eine
//   Broadcast-Adresse des Netzes ab (EACCES, gezählt).

const dgram = require('node:dgram');
const net = require('node:net');
const logger = require('../logger');
const { isSelfTarget, bindReason } = require('./tcp');

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_SESSIONS = 1024;
const EVICT_MIN_IDLE_MS = 2_000;
// Datagramme, die warten, bis der Upstream-Socket verbunden ist (Namensauflösung)
const MAX_PENDING = 32;
const MAX_ROUTES = 512;

const IDLE_MIN_S = 5;
const IDLE_MAX_S = 3600;
const SESSIONS_MIN = 16;
const SESSIONS_MAX = 65535;

function intInRange(raw, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Einstellungen aus der Umgebung: GC_UDP_IDLE_TIMEOUT_S (5–3600, Standard 60)
 * und GC_UDP_MAX_SESSIONS (16–65535 je Route, Standard 1024). Ungültige Werte
 * fallen auf den Standard zurück.
 */
function udpOptionsFromEnv(env = process.env) {
  const idle = intInRange(env.GC_UDP_IDLE_TIMEOUT_S, IDLE_MIN_S, IDLE_MAX_S);
  const max = intInRange(env.GC_UDP_MAX_SESSIONS, SESSIONS_MIN, SESSIONS_MAX);
  return {
    idleTimeoutMs: idle ? idle * 1000 : DEFAULT_IDLE_TIMEOUT_MS,
    maxSessions: max || DEFAULT_MAX_SESSIONS,
  };
}

/** Broadcast-, Multicast- und unspezifizierte Adressen – als Ziel nicht unterstützt. */
function isUnsupportedTarget(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(h)) {
    const a = Number(h.split('.')[0]);
    return h === '255.255.255.255' || h === '0.0.0.0' || (a >= 224 && a <= 239);
  }
  if (net.isIPv6(h)) return h.startsWith('ff') || h === '::';
  return false;
}

const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;

/**
 * UDP-Routen aus dem Config-Pull (`udp_routes`, nur von einem Server, der
 * die Capability `udp-routes` kennt): [{ id, listen_port, target_lan_host,
 * target_lan_port }]. Server-Eingabe – ungültige Einträge fallen weg.
 */
function normalizeUdpRoutes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    if (!Number.isSafeInteger(r.id) || r.id <= 0 || seen.has(r.id)) continue;
    if (!isPort(r.listen_port) || !isPort(r.target_lan_port)) continue;
    if (typeof r.target_lan_host !== 'string' || !r.target_lan_host.trim() || r.target_lan_host.length > 253) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      listen_port: r.listen_port,
      target_lan_host: r.target_lan_host.trim().replace(/^\[|\]$/g, ''),
      target_lan_port: r.target_lan_port,
    });
    if (out.length >= MAX_ROUTES) break;
  }
  return out;
}

const sameTarget = (a, b) => a.target_lan_host === b.target_lan_host && a.target_lan_port === b.target_lan_port;
const sameRoute = (a, b) => a.listen_port === b.listen_port && sameTarget(a, b);

function newCounters() {
  return {
    sessions_total: 0,
    datagrams_in: 0, // vom Server ans Gateway
    datagrams_out: 0, // Antworten des Ziels zurück an den Server
    bytes_in: 0,
    bytes_out: 0,
    dropped_limit: 0, // verworfen: Obergrenze gleichzeitiger Zuordnungen erreicht
    evicted: 0, // ruhende Zuordnung für eine neue freigegeben
    icmp_unreachable: 0, // Ziel meldet „port unreachable“ (ECONNREFUSED)
    upstream_errors: 0, // andere Fehler zum Ziel (Name unbekannt, Host weg, Broadcast …)
    idle_closed: 0,
  };
}

class UdpProxyManager {
  /**
   * @param {{ bindIp: string, idleTimeoutMs?: number, maxSessions?: number,
   *   localAddrs?: () => string[], now?: () => number, sweepIntervalMs?: number }} opts
   */
  constructor({ bindIp, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, maxSessions = DEFAULT_MAX_SESSIONS, localAddrs, now = Date.now, sweepIntervalMs } = {}) {
    this.bindIp = bindIp;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxSessions = maxSessions;
    this._localAddrs = localAddrs;
    this._now = now;
    this._sweepIntervalMs = sweepIntervalMs || Math.max(250, Math.min(5_000, Math.floor(idleTimeoutMs / 4)));
    this._listeners = new Map(); // id → listener (siehe _startListener)
    this._failures = new Map(); // id → { route_id, listen_port, reason, code, protocol }
    this._direct = new Map(); // id → { route, listen_port }
    this._sweepTimer = null;
  }

  // ─── Auskunft (Selbstprüfung, Heartbeat) ────────────────────────────

  listListenerPorts() {
    return [...this._listeners.values()].map(l => l.port);
  }

  listListenerIssues() {
    return [...this._failures.values()].map(f => ({ ...f }));
  }

  /** Routen, deren Port der Zieldienst dieses Hosts selbst hält (wie TCP, ohne Probe). */
  listDirectRoutes() {
    return [...this._direct.entries()].map(([id, d]) => ({ route_id: id, listen_port: d.listen_port, protocol: 'udp' }));
  }

  /** Zähler je Route: [{ route_id, listen_port, sessions, …newCounters() }]. */
  getStatus() {
    return [...this._listeners.entries()].map(([id, l]) => ({
      route_id: id,
      listen_port: l.port,
      sessions: l.sessions.size,
      ...l.counters,
    }));
  }

  // ─── Routen anwenden ────────────────────────────────────────────────

  async setRoutes(udpRoutes) {
    const routes = Array.isArray(udpRoutes) ? udpRoutes : [];
    const newIds = new Set(routes.map(r => r.id));
    for (const [id, l] of [...this._listeners]) {
      if (!newIds.has(id)) this._stopListener(id, l);
    }
    for (const id of [...this._failures.keys()]) if (!newIds.has(id)) this._failures.delete(id);
    for (const id of [...this._direct.keys()]) if (!newIds.has(id)) this._direct.delete(id);

    // Jede Route für sich: ein Fehler (Port belegt …) stoppt die anderen nicht
    // und lässt setRoutes nie scheitern (läuft im 'change'-Listener, bootstrap.js).
    for (const route of routes) {
      try {
        if (isUnsupportedTarget(route.target_lan_host)) {
          const known = this._listeners.get(route.id);
          if (known) this._stopListener(route.id, known);
          this._direct.delete(route.id);
          this._failures.set(route.id, { route_id: route.id, listen_port: route.listen_port, reason: 'error', code: 'UNSUPPORTED_TARGET', protocol: 'udp' });
          logger.warn({ routeId: route.id, target: route.target_lan_host }, 'UDP route to a broadcast/multicast address — not supported, no listener');
          continue;
        }
        const existing = this._listeners.get(route.id);
        if (!existing) {
          const direct = this._direct.get(route.id);
          if (direct && sameRoute(direct.route, route)) continue;
          this._direct.delete(route.id);
          await this._startListener(route);
          this._failures.delete(route.id);
        } else if (existing.listenPortRequested !== route.listen_port) {
          // Neuer Port: erst den neuen Socket binden, dann den alten schließen
          // (klappt das Binden nicht, bleibt der alte bestehen).
          const old = existing;
          this._listeners.delete(route.id);
          try {
            await this._startListener(route);
          } catch (err) {
            this._listeners.set(route.id, old);
            throw err;
          }
          this._closeListenerSockets(old, route.id);
          logger.info({ routeId: route.id, oldPort: old.port, newPort: this._listeners.get(route.id).port }, 'UDP listener moved to a new port');
        } else if (!sameTarget(existing.route, route)) {
          // Neues Ziel: Socket bleibt, bestehende Zuordnungen zeigen noch aufs alte Ziel
          existing.route = { ...route };
          for (const s of [...existing.sessions.values()]) this._closeSession(existing, s);
          logger.info({ routeId: route.id, target: `${route.target_lan_host}:${route.target_lan_port}` }, 'UDP route target changed — sessions reset');
        }
      } catch (err) {
        if (this._listeners.has(route.id)) {
          logger.error({ routeId: route.id, listenPort: route.listen_port, err: err.code || err.message }, 'Failed to move UDP listener — old one kept');
          continue;
        }
        this._noteBindFailure(route, err);
      }
    }
    this._armSweep();
  }

  _noteBindFailure(route, err) {
    const code = (err && err.code) || null;
    const addrs = this._localAddrs ? this._localAddrs() : undefined;
    if (code === 'EADDRINUSE' && isSelfTarget(route, this.bindIp, addrs)) {
      // Der Zieldienst dieses Hosts hält den Port selbst: der Server erreicht
      // ihn dort direkt (wie bei TCP). Eine UDP-Probe gibt es nicht – ein
      // UDP-Dienst muss auf eine leere Anfrage nicht antworten.
      this._failures.delete(route.id);
      this._direct.set(route.id, { route: { ...route }, listen_port: route.listen_port });
      logger.info({ routeId: route.id, listenPort: route.listen_port }, 'UDP route targets this host on its own listen port and the service holds it — served directly, no listener');
      return;
    }
    this._direct.delete(route.id);
    this._failures.set(route.id, {
      route_id: route.id,
      listen_port: route.listen_port,
      reason: bindReason(code),
      ...(code ? { code } : {}),
      protocol: 'udp',
    });
    logger.error({ routeId: route.id, listenPort: route.listen_port, err: code || (err && err.message) }, 'Failed to apply UDP route — skipping it; other routes unaffected');
  }

  async _startListener(route) {
    const type = net.isIPv6(this.bindIp || '') ? 'udp6' : 'udp4';
    const socket = dgram.createSocket({ type });
    await new Promise((resolve, reject) => {
      const onError = (err) => { try { socket.close(); } catch (_e) { /* not bound */ } reject(err); };
      socket.once('error', onError);
      socket.bind({ port: route.listen_port, address: this.bindIp, exclusive: true }, () => {
        socket.off('error', onError);
        resolve();
      });
    });
    const l = {
      socket,
      port: socket.address().port,
      listenPortRequested: route.listen_port,
      route: { ...route },
      sessions: new Map(), // "ip:port" → Sitzung; Reihenfolge = zuletzt aktiv am Ende
      counters: newCounters(),
      closed: false,
    };
    socket.on('message', (msg, rinfo) => this._onClientDatagram(l, msg, rinfo));
    socket.on('error', (err) => {
      // Ein Fehler am gebundenen Socket: schließen und als fehlend melden – die
      // Selbstprüfung im Heartbeat bindet ihn neu (selfCheckRunner).
      logger.error({ routeId: route.id, port: l.port, err: err.code || err.message }, 'UDP listener failed — closing it, the next reconcile binds it again');
      if (this._listeners.get(route.id) === l) {
        this._stopListener(route.id, l);
        this._failures.set(route.id, { route_id: route.id, listen_port: route.listen_port, reason: 'error', ...(err.code ? { code: err.code } : {}), protocol: 'udp' });
      }
    });
    this._listeners.set(route.id, l);
    logger.info({ routeId: route.id, port: l.port, target: `${route.target_lan_host}:${route.target_lan_port}` }, 'UDP listener started');
    return l;
  }

  _stopListener(id, l) {
    logger.info({ routeId: id, port: l.port }, 'UDP listener stopping');
    this._closeListenerSockets(l, id);
    if (this._listeners.get(id) === l) this._listeners.delete(id);
  }

  _closeListenerSockets(l, _id) {
    l.closed = true;
    for (const s of [...l.sessions.values()]) this._closeSession(l, s);
    try { l.socket.close(); } catch (_e) { /* already closed */ }
  }

  // ─── Datagramme ─────────────────────────────────────────────────────

  _onClientDatagram(l, msg, rinfo) {
    if (l.closed) return;
    l.counters.datagrams_in += 1;
    l.counters.bytes_in += msg.length;
    const key = `${rinfo.address}:${rinfo.port}`;
    let s = l.sessions.get(key);
    if (s) {
      // ans Ende: die Map bleibt nach letzter Aktivität sortiert
      l.sessions.delete(key);
      l.sessions.set(key, s);
    } else {
      if (l.sessions.size >= this.maxSessions && !this._evictOne(l)) {
        l.counters.dropped_limit += 1;
        if (l.counters.dropped_limit === 1 || l.counters.dropped_limit % 1000 === 0) {
          logger.warn({ routeId: l.route.id, port: l.port, max: this.maxSessions, dropped: l.counters.dropped_limit }, 'UDP session limit reached — datagram dropped');
        }
        return;
      }
      s = this._openSession(l, key, rinfo);
    }
    s.lastActive = this._now();
    this._sendUpstream(l, s, msg);
  }

  /** Gibt die am längsten ruhende Zuordnung frei, wenn sie lange genug ruht. */
  _evictOne(l) {
    const oldest = l.sessions.values().next().value;
    if (!oldest || this._now() - oldest.lastActive < EVICT_MIN_IDLE_MS) return false;
    this._closeSession(l, oldest);
    l.counters.evicted += 1;
    return true;
  }

  _openSession(l, key, rinfo) {
    const target = l.route;
    const type = net.isIPv6(target.target_lan_host) ? 'udp6' : 'udp4';
    const upstream = dgram.createSocket({ type });
    const s = {
      key,
      address: rinfo.address,
      port: rinfo.port,
      upstream,
      connected: false,
      pending: [],
      closed: false,
      lastActive: this._now(),
    };
    l.sessions.set(key, s);
    l.counters.sessions_total += 1;
    upstream.on('message', (reply) => {
      if (s.closed || l.closed) return;
      s.lastActive = this._now();
      l.counters.datagrams_out += 1;
      l.counters.bytes_out += reply.length;
      l.socket.send(reply, s.port, s.address, (err) => {
        if (err) logger.debug({ routeId: l.route.id, err: err.code || err.message }, 'UDP reply to the server not sent');
      });
    });
    upstream.on('error', (err) => this._onUpstreamError(l, s, err));
    try {
      upstream.connect(target.target_lan_port, target.target_lan_host, (err) => {
        if (s.closed) return;
        if (err) { this._onUpstreamError(l, s, err); return; }
        s.connected = true;
        const queued = s.pending;
        s.pending = [];
        for (const m of queued) this._sendUpstream(l, s, m);
      });
    } catch (err) {
      // synchroner Fehler (ungültige Adresse) – wie ein Fehler zum Ziel behandeln
      setImmediate(() => this._onUpstreamError(l, s, err));
    }
    return s;
  }

  _sendUpstream(l, s, msg) {
    if (s.closed) return;
    if (!s.connected) {
      if (s.pending.length < MAX_PENDING) s.pending.push(msg);
      return;
    }
    try {
      s.upstream.send(msg, (err) => { if (err) this._onUpstreamError(l, s, err); });
    } catch (err) {
      this._onUpstreamError(l, s, err);
    }
  }

  _onUpstreamError(l, s, err) {
    if (s.closed) return;
    const code = err && err.code;
    if (code === 'ECONNREFUSED') l.counters.icmp_unreachable += 1;
    else l.counters.upstream_errors += 1;
    logger.debug({ routeId: l.route.id, client: s.key, err: code || (err && err.message) }, 'UDP upstream error — session closed');
    // Die Zuordnung endet; das nächste Datagramm dieses Absenders öffnet eine neue.
    this._closeSession(l, s);
  }

  _closeSession(l, s) {
    if (s.closed) return;
    s.closed = true;
    s.pending = [];
    if (l.sessions.get(s.key) === s) l.sessions.delete(s.key);
    try { s.upstream.close(); } catch (_e) { /* already closed */ }
  }

  // ─── Leerlauf ───────────────────────────────────────────────────────

  _armSweep() {
    if (this._listeners.size === 0) {
      if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
      return;
    }
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this.sweepIdle(), this._sweepIntervalMs);
    if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
  }

  /** Schließt Zuordnungen, die idleTimeoutMs lang kein Datagramm sahen. Gibt die Anzahl zurück. */
  sweepIdle() {
    const now = this._now();
    let closed = 0;
    for (const l of this._listeners.values()) {
      for (const s of [...l.sessions.values()]) {
        if (now - s.lastActive < this.idleTimeoutMs) continue;
        this._closeSession(l, s);
        l.counters.idle_closed += 1;
        closed += 1;
      }
    }
    return closed;
  }

  async stopAll() {
    for (const [id, l] of [...this._listeners]) this._stopListener(id, l);
    this._failures.clear();
    this._direct.clear();
    this._armSweep();
  }
}

module.exports = {
  UdpProxyManager,
  udpOptionsFromEnv,
  normalizeUdpRoutes,
  isUnsupportedTarget,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_SESSIONS,
  EVICT_MIN_IDLE_MS,
};
