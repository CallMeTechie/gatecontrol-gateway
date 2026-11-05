'use strict';

// Gateway-Seite der Edge-Laufzeit (läuft im Gateway-Container, nicht im
// Edge-Container): reicht serverUrl + apiToken über die Datei
// /run/gc-edge/credentials an den Edge-Host weiter und liest dessen
// Zusammenfassung für die Telemetrie. Ohne Edge-Dienst in der Compose-Datei
// gibt es /run/gc-edge nicht – dann tut dieses Modul nichts.
//
// /run/gc-edge ist ein tmpfs-Volume (uid 0, gid 61001, mode 2750): der
// Gateway-Container (root, ohne CAP_CHOWN/CAP_DAC_OVERRIDE) schreibt, das
// setgid-Bit gibt jeder Datei die Gruppe des Edge-Benutzers, der sie damit
// lesen, aber weder ändern noch löschen kann.

const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const logger = require('../logger');

const CREDENTIALS_FILE = 'credentials';
const STATUS_FILE = 'status.json';
const STATUS_MAX_BYTES = 64 * 1024;
const STATUS_MAX_AGE_MS = 3 * 60 * 1000;

function writeAtomic(dir, name, body, mode) {
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, body, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, path.join(dir, name));
}

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

class EdgeLink {
  constructor({ config, runDir = process.env.GC_EDGE_RUN_DIR || '/run/gc-edge', statusDir = process.env.GC_EDGE_STATUS_DIR || '/run/gc-edge-status',
    lookup, now = Date.now } = {}) {
    this.config = config;
    this.runDir = runDir;
    this.statusDir = statusDir;
    this.lookup = lookup;
    this.now = now;
    this.server = null;
    this.lastWritten = null;
    this.lastError = null;
  }

  /** Edge-Dienst vorhanden (Volume eingehängt)? */
  deployed() {
    try { return fs.statSync(this.runDir).isDirectory(); } catch { return false; }
  }

  /** Zugangsdatei aktualisieren (beim Start und bei jedem Heartbeat). */
  async sync() {
    if (!this.deployed()) return { deployed: false };
    try {
      const r = await resolveServer(this.config.serverUrl, this.lookup);
      if (r.addrs.length) this.server = r;
    } catch (e) {
      // DNS gerade nicht erreichbar: letzte bekannte Adressen behalten
      this.lastError = `resolve: ${e.code || e.message}`;
      logger.debug({ err: e.message }, 'edge: server name not resolved');
    }
    const body = JSON.stringify({
      v: 1,
      serverUrl: this.config.serverUrl,
      apiToken: this.config.apiToken,
      serverAddrs: this.server ? this.server.addrs : [],
      tunnelIp: this.config.tunnelIp,
    });
    if (body !== this.lastWritten) {
      try {
        writeAtomic(this.runDir, CREDENTIALS_FILE, body, 0o440);
        this.lastWritten = body;
        this.lastError = null;
      } catch (e) {
        this.lastError = `credentials: ${e.code || e.message}`;
        logger.warn({ err: e.message }, 'edge: could not write the credentials for the edge container');
      }
    }
    return { deployed: true, server: this.server };
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
      };
    } catch {
      return null;
    }
  }

  /** Telemetrie-Block `edge` (null = kein Edge-Dienst). */
  telemetry() {
    if (!this.deployed()) return null;
    return {
      deployed: true,
      error: this.lastError,
      host: this.readStatus(),
    };
  }
}

module.exports = { EdgeLink, resolveServer, CREDENTIALS_FILE };
