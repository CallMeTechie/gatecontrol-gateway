'use strict';

// MQTT (docs/edge.md "MQTT"): läuft im Gateway-Container (neue Compose-Datei,
// Edge ohne Netz: Dateien nach /gc-mqtt-conf, Edge-Teile rufen gc.mqtt.* per
// RPC, bridge.js) oder – alte Compose-Datei mit Netzgrenze – im Edge-Host.
// Schreibt die Broker-Dateien aus
// dem Sollzustand, hält das interne Konto `gc-edge` am lokalen Broker,
// verteilt Nachrichten an die Edge-Teile (gc.mqtt.*) und kündigt den Broker
// per mDNS als _mqtt._tcp an. Das interne Konto darf nur die pluginTopics;
// jedes Plugin zusätzlich nur seine genehmigten mqtt.topics.
//
// TLS (state.mqtt.tls, Standard aus): zusätzlich Port 8883 an den LAN-Adressen,
// mit einem selbst erzeugten Zertifikat (src/cache/selfsigned.js). Es liegt in
// `tlsDir` (Gateway: /state/mqtt-tls) und bleibt über Neustarts gleich; sein
// Fingerabdruck (SHA-256) geht mit dem Status an den Server, damit man ihn in
// Geräten hinterlegen kann. Port 1883 bleibt daneben offen.

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { BrokerFiles, hashPassword, INTERNAL_USER, PORT } = require('./broker');
const { loadOrCreate } = require('../../cache/selfsigned');
const { MqttClient } = require('./client');
const topics = require('../topics');
const { LIMITS } = require('../constants');
const { isPhysicalLan } = require('../../discovery/lanInterfaces');

class MqttError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Eigene IPv4-Adressen der LAN-Schnittstellen (RFC 1918) – dort lauscht der Broker. */
function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!isPhysicalLan(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) out.push(a.address);
    }
  }
  return [...new Set(out)].sort();
}

// Mosquitto 2.1: "Client <id> [<ip>:<port>] disconnected." (ältere ohne Adresse)
const DISCONNECT_RE = /Client (\S+)(?: \[[^\]]*\])? (?:disconnected|closed its connection|has exceeded timeout)/;
const CONNECT_RE = /New client connected from \S+ as (\S+) \(.*?u'([^']*)'\)/;

const HOST_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

class MqttManager {
  /**
   * @param {string} [o.tlsDir]  wo das Zertifikat des TLS-Listeners bleibt (übersteht Neustarts);
   *                             ohne Angabe ein Ordner in `dir` (alte Compose-Datei: eigenes Volume)
   */
  constructor({ dir, brokerDir, tlsDir, logger, mdns = null, hostname = os.hostname(), getLanAddrs = lanAddresses, clientFactory, retryMs = 5000, now = Date.now, onChange = () => {},
    loadCert = loadOrCreate } = {}) {
    this.onChange = onChange;
    this.files = new BrokerFiles(dir, { brokerDir: brokerDir || dir });
    this.tlsDir = tlsDir || (dir ? path.join(dir, 'tls-own') : null);
    this.loadCert = loadCert;
    this.cert = null; // { cert, key, sha256 } – erst erzeugt, wenn TLS eingeschaltet wird
    this.logger = logger || { info() {}, warn() {}, debug() {} };
    this.mdns = mdns;
    this.hostname = hostname.split('.')[0] || 'gatecontrol';
    this.getLanAddrs = getLanAddrs;
    this.clientFactory = clientFactory || ((o) => new MqttClient(o));
    this.retryMs = retryMs;
    this.now = now;
    this.password = crypto.randomBytes(24).toString('base64url');
    this.internalHash = hashPassword(this.password);
    this.cfg = { enabled: false, tls: false, accounts: [], pluginTopics: {} };
    this.client = null;
    this.retryTimer = null;
    this.subs = new Map();     // `${plugin}#${id}` → { plugin, id, filter, toChild }
    this.filterRefs = new Map(); // filter → Anzahl
    this.nextId = 0;
    this.clients = 0;
    this.accounts = new Map(); // user → { connected, lastSeen }
    this.clientUsers = new Map(); // clientId → user
    this.tls = 'off';
    this.lastAddrs = [];
    // Konten und Themen des Gateways selbst (Funk: zigbee2mqtt, src/radio/z2m.js) – kommen
    // nicht vom Server; ein gleichnamiges Konto aus dem state wird übergangen
    this.local = { accounts: [], topics: [] };
    this.localSubs = new Map(); // filter → Set(handler)
  }

  available() { return this.files.available(); }

  /** Dieses Gateway erzeugt das Zertifikat für den TLS-Listener selbst (hello: mqtt.tlsCert). */
  tlsCert() { return true; }

  /**
   * Das Zertifikat des TLS-Listeners: aus `tlsDir` geladen oder einmal erzeugt (10 Jahre).
   * Geräte prüfen den Fingerabdruck; Name und Adressen stehen nur für Clients drin, die
   * zusätzlich den Namen prüfen. null, wenn es sich nicht anlegen lässt (→ tls: missing_cert).
   */
  ensureCert(addrs = []) {
    if (this.cert) return this.cert;
    if (!this.tlsDir) return null;
    try {
      const names = HOST_LABEL_RE.test(this.hostname) ? [{ dns: this.hostname }, { dns: `${this.hostname}.local` }] : [];
      const c = this.loadCert(this.tlsDir, { commonName: 'GateControl MQTT', altNames: [...names, ...addrs.map((ip) => ({ ip }))] });
      this.cert = { cert: c.cert, key: c.key, sha256: c.sha256 };
      if (c.created) this.logger.info({ sha256: c.sha256 }, 'edge: certificate for the MQTT TLS listener created');
    } catch (e) {
      this.logger.warn({ err: e.message }, 'edge: certificate for the MQTT TLS listener not available');
      return null;
    }
    return this.cert;
  }

  internalTopics(cfg = this.cfg) {
    return [...new Set(Object.values(cfg.pluginTopics || {}).flat().concat(this.local.topics))];
  }

  /** Konten für die Broker-Dateien: die des Servers, dazu die eigenen des Gateways (gleicher Name: das eigene gilt). */
  allAccounts() {
    const own = new Set(this.local.accounts.map((a) => a.user));
    return (this.cfg.accounts || []).filter((a) => !own.has(a.user)).concat(this.local.accounts);
  }

  // ─── Für das Gateway selbst (Funk: zigbee2mqtt) ──────────────

  /** Eigene Konten ({ user, hash, acl }) und Themen des internen Kontos setzen (schreibt die Broker-Dateien neu). */
  setLocal({ accounts = [], topics: own = [] } = {}) {
    const next = { accounts: accounts.slice(0, 4), topics: own.filter((t) => topics.validFilter(t)).slice(0, 8) };
    if (JSON.stringify(next) === JSON.stringify(this.local)) return;
    this.local = next;
    this.refresh();
  }

  /** Läuft der Broker (vom Server eingeschaltet, Volume da)? */
  brokerEnabled() { return !!(this.cfg.enabled && this.available()); }
  /** Ist das interne Konto gerade angemeldet? */
  localReady() { return !!(this.client && this.client.connected); }

  /** Eigenes Abo (nur Themen aus setLocal); → Funktion zum Beenden. */
  localSubscribe(filter, fn) {
    if (!topics.validFilter(filter) || !this.local.topics.some((t) => topics.covers(t, filter))) throw new MqttError('denied', 'topic not set up');
    let set = this.localSubs.get(filter);
    if (!set) {
      set = new Set();
      this.localSubs.set(filter, set);
      if (this.client && this.client.connected) this.client.subscribe(filter, 0).catch((e) => this.logger.debug({ err: e.message }, 'radio: MQTT subscribe failed'));
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size || this.localSubs.get(filter) !== set) return;
      this.localSubs.delete(filter);
      if (!this.filterRefs.has(filter) && this.client && this.client.connected) this.client.unsubscribe(filter).catch(() => null);
    };
  }

  /** Eigene Nachricht (nur Themen aus setLocal). */
  async localPublish(topic, payload, { qos = 0, retain = false } = {}) {
    if (!topics.validTopic(topic) || !this.local.topics.some((t) => topics.matches(t, topic))) throw new MqttError('denied', 'topic not set up');
    if (!this.client || !this.client.connected) throw new MqttError('not_available', 'local MQTT broker not reachable');
    await this.client.publish(topic, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)), { qos, retain });
  }

  /** Sollzustand (state.mqtt, bereits geprüft) anwenden. */
  async apply(cfg) {
    this.cfg = cfg;
    if (!cfg.enabled || !this.available()) {
      if (cfg.enabled) this.logger.warn('edge: MQTT wanted, but the mqtt volume is missing');
      this.files.disable();
      this.stopClient();
      if (this.mdns) this.mdns.announce(null);
      return;
    }
    this.refresh();
    this.ensureClient();
  }

  /** Dateien neu schreiben (auch bei geänderten LAN-Adressen; vom Tick aufgerufen). */
  refresh() {
    if (!this.cfg.enabled || !this.available()) return;
    const addrs = this.getLanAddrs();
    const r = this.files.write({ accounts: this.allAccounts(), internalHash: this.internalHash, internalTopics: this.internalTopics(),
      listenAddrs: addrs, tls: this.cfg.tls, cert: this.cfg.tls ? this.ensureCert(addrs) : null });
    if (r.tls !== this.tls) { this.tls = r.tls; this.onChange(); }
    if (r.confChanged) this.logger.info({ listen: addrs }, 'edge: MQTT broker configuration written');
    if (this.mdns && (r.confChanged || addrs.join() !== this.lastAddrs.join())) {
      this.mdns.announce(addrs.length ? { instance: `GateControl MQTT ${this.hostname}`, service: '_mqtt._tcp', host: this.hostname, port: PORT, addresses: addrs } : null);
    }
    this.lastAddrs = addrs;
    // Abos neu prüfen: entfernte pluginTopics → Abos der Plugins beenden
    for (const [k, s] of this.subs) if (!this.allowedFor(s.plugin, s.caps).some((a) => topics.covers(a, s.filter))) this.removeSub(k);
  }

  ensureClient() {
    if (this.client || this.retryTimer) return;
    const c = this.clientFactory({ host: '127.0.0.1', port: PORT, clientId: `gc-edge-host-${process.pid}`, username: INTERNAL_USER, password: this.password });
    this.client = c;
    c.on('message', (topic, payload, meta) => this.onMessage(topic, payload, meta));
    c.on('close', () => { if (this.client === c) { this.client = null; this.logger.warn('edge: MQTT connection lost'); this.onChange(); this.scheduleRetry(); } });
    c.connect().then(async () => {
      this.logger.info('edge: connected to the local MQTT broker');
      this.onChange();
      try {
        await c.subscribe('$SYS/broker/clients/connected', 0);
        await c.subscribe('$SYS/broker/log/N', 0);
      } catch (e) { this.logger.debug({ err: e.message }, 'edge: $SYS subscribe failed'); }
      for (const f of this.filterRefs.keys()) c.subscribe(f, 1).catch((e) => this.logger.warn({ err: e.message, filter: f }, 'edge: MQTT resubscribe failed'));
      for (const f of this.localSubs.keys()) if (!this.filterRefs.has(f)) c.subscribe(f, 0).catch((e) => this.logger.debug({ err: e.message, filter: f }, 'radio: MQTT resubscribe failed'));
    }, (e) => {
      if (this.client === c) this.client = null;
      this.logger.debug({ err: e.message }, 'edge: MQTT broker not reachable yet');
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (!this.cfg.enabled || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.cfg.enabled) this.ensureClient(); }, this.retryMs);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  stopClient() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const c = this.client;
    this.client = null;
    if (c) c.end();
    this.clients = 0;
  }

  onMessage(topic, payload, meta) {
    if (topic === '$SYS/broker/clients/connected') { this.clients = Number(payload.toString()) || 0; return; }
    if (topic === '$SYS/broker/log/N') { this.onLog(payload.toString('utf8')); return; }
    for (const [f, set] of this.localSubs) {
      if (!topics.matches(f, topic)) continue;
      for (const fn of set) { try { fn(topic, payload, meta); } catch (e) { this.logger.debug({ err: e.message }, 'radio: MQTT handler failed'); } }
    }
    for (const s of this.subs.values()) {
      if (!topics.matches(s.filter, topic)) continue;
      s.toChild({ t: 'mqtt', id: s.id, topic, b64: payload.toString('base64'), retain: meta.retain, qos: meta.qos });
    }
  }

  onLog(line) {
    let m = CONNECT_RE.exec(line);
    if (m) {
      this.clientUsers.set(m[1], m[2]);
      this.accounts.set(m[2], { connected: true, lastSeen: new Date(this.now()).toISOString() });
      this.onChange();
      return;
    }
    m = DISCONNECT_RE.exec(line);
    if (m) {
      const user = this.clientUsers.get(m[1]);
      this.clientUsers.delete(m[1]);
      if (user && ![...this.clientUsers.values()].includes(user)) {
        this.accounts.set(user, { connected: false, lastSeen: new Date(this.now()).toISOString() });
        this.onChange();
      }
    }
  }

  // ─── gc.mqtt.* ────────────────────────────────

  allowedFor(plugin, caps) {
    const own = (caps && caps.mqtt && caps.mqtt.topics) || [];
    const granted = (this.cfg.pluginTopics && this.cfg.pluginTopics[plugin]) || [];
    // genehmigt für das Plugin UND im ACL des internen Kontos
    return own.filter((f) => granted.some((g) => topics.covers(g, f)));
  }

  async pluginCall(plugin, getCaps, api, args, toChild) {
    if (!this.cfg.enabled) throw new MqttError('not_enabled', 'MQTT is not enabled on this gateway');
    const allowed = this.allowedFor(plugin, getCaps());
    switch (api) {
      case 'mqtt.subscribe': {
        const f = args.topic;
        if (!topics.validFilter(f) || !allowed.some((a) => topics.covers(a, f))) throw new MqttError('denied', `topic ${String(f).slice(0, 64)} not approved`);
        const mine = [...this.subs.values()].filter((s) => s.plugin === plugin).length;
        if (mine >= LIMITS.mqttSubscriptionsPerPlugin) throw new MqttError('busy', 'too many subscriptions');
        const id = ++this.nextId;
        this.subs.set(`${plugin}#${id}`, { plugin, id, filter: f, toChild, caps: getCaps() });
        const n = (this.filterRefs.get(f) || 0) + 1;
        this.filterRefs.set(f, n);
        if (n === 1 && this.client && this.client.connected) await this.client.subscribe(f, 1);
        return { id };
      }
      case 'mqtt.unsubscribe':
        this.removeSub(`${plugin}#${args.id}`);
        return {};
      case 'mqtt.publish': {
        const t = args.topic;
        if (!topics.validTopic(t) || !allowed.some((a) => topics.matches(a, t))) throw new MqttError('denied', `topic ${String(t).slice(0, 64)} not approved`);
        const payload = Buffer.from(typeof args.b64 === 'string' ? args.b64 : '', 'base64');
        if (payload.length > LIMITS.mqttPayloadBytes) throw new MqttError('too_large', 'payload larger than 256 KB');
        if (!this.client || !this.client.connected) throw new MqttError('not_available', 'local MQTT broker not reachable');
        await this.client.publish(t, payload, { qos: args.qos === 1 ? 1 : 0, retain: args.retain === true });
        return {};
      }
      default:
        throw new MqttError('unknown_api', 'unknown mqtt api');
    }
  }

  removeSub(key) {
    const s = this.subs.get(key);
    if (!s) return;
    this.subs.delete(key);
    const n = (this.filterRefs.get(s.filter) || 1) - 1;
    if (n <= 0) {
      this.filterRefs.delete(s.filter);
      if (!this.localSubs.has(s.filter) && this.client && this.client.connected) this.client.unsubscribe(s.filter).catch(() => null);
    } else this.filterRefs.set(s.filter, n);
  }

  /** Prozess eines Plugins beendet → seine Abos aufräumen. */
  dropPlugin(plugin) {
    for (const [k, s] of this.subs) if (s.plugin === plugin) this.removeSub(k);
  }

  status() {
    return {
      running: !!(this.client && this.client.connected),
      clients: Math.max(0, this.clients - (this.client && this.client.connected ? 1 : 0)), // ohne das interne Konto
      tls: this.tls,
      // Fingerabdruck (SHA-256 über DER, hex) und Zertifikat (PEM, öffentlich) des TLS-Listeners
      ...(this.tls === 'on' && this.cert ? { tlsSha256: this.cert.sha256, tlsCert: this.cert.cert } : {}),
      accounts: (this.cfg.accounts || []).map((a) => ({ user: a.user, connected: !!(this.accounts.get(a.user) || {}).connected,
        lastSeen: (this.accounts.get(a.user) || {}).lastSeen || null })),
    };
  }

  async stop() {
    this.cfg = { ...this.cfg, enabled: false };
    this.stopClient();
  }
}

module.exports = { MqttManager, MqttError, lanAddresses };
