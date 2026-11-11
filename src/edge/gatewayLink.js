'use strict';

// Gateway-Seite der Edge-Laufzeit (läuft im Gateway-Container, nicht im
// Edge-Container). Ohne Edge-Dienst in der Compose-Datei gibt es /run/gc-edge
// nicht – dann tut dieses Modul nichts.
//
// /run/gc-edge ist ein tmpfs-Volume (uid 0, gid 61001, mode 2750): der
// Gateway-Container (root, ohne CAP_CHOWN/CAP_DAC_OVERRIDE) legt dort den
// Gateway-Socket gw.sock an (bridge.js: Relay zum Server, Pakete, RPC für
// gc.lan.*/mDNS/gc.mqtt.*) und den Marker der Netzgrenze; das setgid-Bit gibt
// jeder Datei die Gruppe des Edge-Benutzers. Das API-Token bleibt im
// Gateway-Container (früher: Datei `credentials` – wird beim Start gelöscht).
//
// Netzgrenze (fenceRules.js): nur für alte Compose-Dateien nötig, in denen der
// Edge-Container im Host-Netz läuft. Sie wird trotzdem immer gesetzt, wo es
// geht – ob der Edge-Container wirklich ohne Netz läuft, meldet er selbst, und
// darauf verlässt sich das Gateway nicht. Alle 30 s, unabhängig vom Heartbeat.

const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const logger = require('../logger');
const { FenceManager } = require('./fenceRules');
const { privateLanCidrs, makeLanGuard } = require('./lanGuard');
const { EdgeBridge } = require('./bridge');
const { MdnsService } = require('./mdnsService');
const { MqttManager } = require('./mqtt/manager');

const CREDENTIALS_FILE = 'credentials';
const STATUS_FILE = 'status.json';
const STATUS_MAX_BYTES = 64 * 1024;
const STATUS_MAX_AGE_MS = 3 * 60 * 1000;

async function resolveServer(serverUrl, lookup = dns.promises.lookup) {
  const u = new URL(serverUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (net.isIP(host)) return { host, port, addrs: [host] };
  const res = await lookup(host, { all: true, verbatim: true });
  const addrs = [...new Set(res.map((r) => r.address))].slice(0, 8);
  return { host, port, addrs };
}

function clampStr(v, max = 120) { return typeof v === 'string' ? v.slice(0, max) : null; }
function clampNum(v) { return Number.isFinite(v) ? Math.round(v * 10) / 10 : null; }

/** mDNS des Gateways für die Edge-Teile: primäre LAN-Schnittstelle (wie der LAN-Scan). */
function defaultMdns() {
  const { primaryLanIp } = require('../discovery/lanInterfaces');
  const { defaultGatewayIp } = require('../health/telemetry');
  return new MdnsService({ logger, getInterface: () => primaryLanIp(defaultGatewayIp()) });
}

class EdgeLink {
  constructor({ config, runDir = process.env.GC_EDGE_RUN_DIR || '/run/gc-edge', statusDir = process.env.GC_EDGE_STATUS_DIR || '/run/gc-edge-status',
    mqttConfDir = process.env.GC_EDGE_MQTT_CONF_DIR || '/gc-mqtt-conf', mqttBrokerDir = process.env.GC_EDGE_MQTT_BROKER_DIR || '/gc-mqtt',
    lookup, now = Date.now, fence, getLanCidrs, bridge } = {}) {
    this.config = config;
    this.fence = fence || new FenceManager({ runDir, logger, now });
    this.getLanCidrs = getLanCidrs || privateLanCidrs;
    this.runDir = runDir;
    this.statusDir = statusDir;
    this.lookup = lookup;
    this.now = now;
    this.server = null;
    this.lastError = null;
    this.socketError = null;
    this.cleaned = false;
    this.bridge = bridge === undefined ? this.makeBridge({ mqttConfDir, mqttBrokerDir }) : bridge;
  }

  makeBridge({ mqttConfDir, mqttBrokerDir }) {
    const mdns = defaultMdns();
    // MQTT-Broker-Dateien schreibt das Gateway nur mit dem Volume edge-mqtt-conf (neue Compose-Datei);
    // sonst meldet der Manager „nicht verfügbar“ und der Edge-Host (alte Compose) macht es selbst.
    // das Zertifikat des TLS-Listeners liegt im State-Verzeichnis (die Ablage der Broker-Dateien ist ein tmpfs)
    const tlsDir = this.config && this.config.stateDir ? path.join(this.config.stateDir, 'mqtt-tls') : undefined;
    const mqtt = new MqttManager({ dir: mqttConfDir, brokerDir: mqttBrokerDir, tlsDir, logger, mdns });
    return new EdgeBridge({
      runDir: this.runDir,
      upstream: () => (this.config && this.config.serverUrl && this.config.apiToken
        ? { serverUrl: this.config.serverUrl, apiToken: this.config.apiToken, serverAddrs: this.server ? this.server.addrs : [] } : null),
      guard: makeLanGuard({ tunnelIp: () => (this.config ? this.config.tunnelIp : null), serverAddrs: () => (this.server ? this.server.addrs : []) }),
      mdns,
      mqtt,
      logger,
    });
  }

  /** Edge-Dienst vorhanden (Volume eingehängt)? */
  deployed() {
    try { return fs.statSync(this.runDir).isDirectory(); } catch { return false; }
  }

  /** Abgleich (beim Start und alle 30 s): Server-Adressen, Netzgrenze, Broker-Dateien. */
  async sync() {
    if (!this.deployed()) return { deployed: false };
    if (!this.cleaned) {
      // ältere Gateways legten das Token in /run/gc-edge/credentials ab – der Edge-Container braucht es nicht mehr
      try { fs.rmSync(path.join(this.runDir, CREDENTIALS_FILE), { force: true }); this.cleaned = true; } catch (e) {
        logger.warn({ err: e.message }, 'edge: old credentials file not removed');
      }
    }
    try {
      const r = await resolveServer(this.config.serverUrl, this.lookup);
      if (r.addrs.length) { this.server = r; this.lastError = null; }
    } catch (e) {
      // DNS gerade nicht erreichbar: letzte bekannte Adressen behalten
      this.lastError = `resolve: ${e.code || e.message}`;
      logger.debug({ err: e.message }, 'edge: server name not resolved');
    }
    if (this.bridge) this.bridge.tick();
    // Netzgrenze: nur mit bekannter Server-Adresse (sonst bleibt der Edge-Teil zu)
    try {
      await this.fence.apply({
        lanCidrs: this.getLanCidrs(),
        serverAddrs: this.server ? this.server.addrs : [],
        serverPort: this.server ? this.server.port : 443,
        tunnelIp: this.config.tunnelIp,
      });
    } catch (e) {
      logger.warn({ err: e.message }, 'edge fence: apply failed');
    }
    return { deployed: true, server: this.server, fence: this.fence.state };
  }

  /** Gateway-Socket öffnen und alle 30 s abgleichen (Server-Adressen, LAN-Subnetze, Regeln, Broker). */
  async start(intervalMs = 30000) {
    if (this.bridge) {
      try { await this.bridge.start(); } catch (e) {
        this.socketError = `socket: ${e.code || e.message}`;
        logger.warn({ err: e.message }, 'edge: gateway socket not opened — the edge container cannot reach the server');
      }
    }
    this.timer = setInterval(() => { this.sync().catch((e) => logger.debug({ err: e.message }, 'edge: sync failed')); }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  async stop() {
    clearInterval(this.timer);
    if (this.bridge) { try { await this.bridge.stop(); } catch (e) { logger.debug({ err: e.message }, 'edge: bridge stop failed'); } }
  }

  /** Zusammenfassung des Edge-Hosts (nicht vertrauenswürdig: begrenzt und geklemmt). */
  readStatus() {
    try {
      const file = path.join(this.statusDir, STATUS_FILE);
      const st = fs.statSync(file);
      if (st.size > STATUS_MAX_BYTES) return null;
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object') return null;
      const at = Date.parse(j.at);
      return {
        at: Number.isFinite(at) ? new Date(at).toISOString() : null,
        stale: !Number.isFinite(at) || this.now() - at > STATUS_MAX_AGE_MS,
        edge_host: clampStr(j.edgeHost, 32),
        connected: j.connected === true,
        edge_enabled: j.edgeEnabled === true,
        host_rss_mb: clampNum(j.hostRssMb),
        plugins: Array.isArray(j.plugins) ? j.plugins.slice(0, 32).filter((p) => p && typeof p === 'object').map((p) => ({
          id: clampStr(p.id, 64), version: clampStr(p.version, 64), state: clampStr(p.state, 32),
          rss_mb: clampNum(p.rssMb), restarts: Number.isInteger(p.restarts) ? p.restarts : 0,
        })) : [],
        mqtt: j.mqtt && typeof j.mqtt === 'object'
          ? { running: j.mqtt.running === true, clients: Number.isInteger(j.mqtt.clients) ? j.mqtt.clients : 0 } : null,
        fence: j.fence && typeof j.fence === 'object' ? { active: j.fence.active === true, backend: clampStr(j.fence.backend, 16) } : null,
        // ab Edge-Host 1.1.0: 'isolated' (Container ohne Netz) | 'fence' (Host-Netz, Netzgrenze nötig)
        mode: j.mode === 'isolated' || j.mode === 'fence' ? j.mode : null,
        isolation: j.isolation && typeof j.isolation === 'object'
          ? { active: j.isolation.active === true, reason: clampStr(j.isolation.reason, 120) } : null,
      };
    } catch {
      return null;
    }
  }

  /** Telemetrie-Block `edge` (null = kein Edge-Dienst). */
  telemetry() {
    if (!this.deployed()) return null;
    const host = this.readStatus();
    return {
      deployed: true,
      error: this.socketError || this.lastError,
      fence: { ...this.fence.state },
      // Betriebsart laut Edge-Host (nur mit frischer Zusammenfassung): 'isolated' → keine Netzgrenze nötig,
      // 'fence' → alte Compose-Datei, ohne Netzgrenze startet nichts (Server: compose_outdated)
      mode: host && !host.stale ? host.mode : null,
      socket: this.bridge ? this.bridge.status() : null,
      host,
    };
  }
}

module.exports = { EdgeLink, resolveServer, CREDENTIALS_FILE };
