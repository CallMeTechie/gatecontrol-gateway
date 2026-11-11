'use strict';

// Edge-Host (docs/edge.md): läuft als einziger Prozess im Edge-Container,
// hält den Kanal zum Server, setzt den Sollzustand (`state`) um, holt und
// prüft Pakete, startet je Edge-Teil einen abgeschotteten Prozess und führt
// dessen gc.*-Aufrufe aus.
//
// Netz hat der Edge-Host selbst keines nötig: Kanal, Pakete und jede
// gc.lan.*-/mDNS-Anfrage gehen über den Gateway-Socket (remote.js →
// bridge.js im Gateway-Container, der dort prüft und ausführt). gc.mqtt.*
// ebenso, wenn der Container isoliert läuft; mit alter Compose-Datei (Host-
// Netz) verwaltet der Edge-Host den Broker wie bisher selbst.
//
// Fail closed: ein Plugin-Prozess startet nur, wenn der Container nachweislich
// kein Netz hat (Betriebsart `isolated`, network_mode: none) oder – im Host-
// Netz (`fence`) – die Netzgrenze des Gateways aktiv ist.

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { EDGE_HOST_VERSION, PROTOCOL_VERSION, LIMITS, TIMING, RESTART_BACKOFF_MS, SOCKET_NAME } = require('./constants');
const { EdgeChannel } = require('./channel');
const { parseState, parseCall } = require('./protocol');
const packages = require('./packages');
const signature = require('./signature');
const { intersectCaps } = require('./manifest');
const { EdgeProcess, rssMb } = require('./pluginProcess');
const { EventBuffer } = require('./eventBuffer');
const { PluginStore } = require('./store');
const { NetError } = require('./netProxy');
const { GatewayRpc, RemoteNet, RemoteMqtt } = require('./remote');
const { checkBoundary } = require('./fence');

const GATEWAY_VERSION = (() => { try { return require('../../package.json').version; } catch { return '0.0.0'; } })();
const DOWNLOAD_RETRY_MS = 60000;
const INFO_WAIT_MS = 3000;

function errInfo(e) {
  return { code: (e && typeof e.code === 'string' && e.code.length <= 32) ? e.code : 'edge_error', message: String((e && e.message) || e).slice(0, 300) };
}

class EdgeHost extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.paths = o.paths;
    this.logger = o.logger || { info() {}, warn() {}, debug() {}, error() {} };
    this.timing = { ...TIMING, ...(o.timing || {}) };
    this.now = o.now || Date.now;
    this.gatewayVersion = o.gatewayVersion || GATEWAY_VERSION;
    this.keys = o.keys || null; // null = signature.trustedKeys()
    this.backoff = o.backoff || RESTART_BACKOFF_MS;
    this.socketPath = o.socketPath || path.join(this.paths.runDir, SOCKET_NAME);
    this.download = o.download || packages.download;
    // isoliert (kein Netz) oder Netzgrenze aktiv → { mode, active, backend, reason }
    this.fenceCheck = o.fenceCheck || (() => checkBoundary({ runDir: this.paths.runDir }));
    this.hardware = o.hardware || (() => { try { return require('../health/telemetry').hardwareProfile(); } catch { return null; } });
    this.mdns = o.mdns || null;
    this.rpc = o.rpc || new GatewayRpc({ socketPath: this.socketPath, logger: this.logger, timing: o.rpcTiming });
    // MQTT: im Host-Netz der lokale Manager (Broker-Dateien + internes Konto), isoliert das Gateway
    this.localMqtt = o.mqtt || null;
    this.remoteMqtt = new RemoteMqtt({ rpc: this.rpc });
    for (const m of [this.localMqtt, this.remoteMqtt]) if (m) m.onChange = () => this.onMqttChange();
    this.store = new packages.PackageStore({ packagesDir: this.paths.packagesDir, logger: this.logger });
    this.channel = o.channel || new EdgeChannel({ credentials: () => ({ socketPath: this.socketPath }), logger: this.logger, timing: o.channelTiming });
    this.plugins = new Map(); // id → Eintrag
    this.desired = null;
    this.mode = null; // 'isolated' | 'fence' – fest ab der ersten Prüfung (das Netz eines Containers ändert sich nicht)
    this.fence = { active: false, backend: null, reason: 'not_checked' };
    this.mqttAvailable = false;
    this.mqttTlsCert = false;
    this.reconciling = false;
    this.again = false;
    this.statusTimer = null;
    this.statusDebounce = null;
    this.fenceTimer = null;
    this.stateSeen = false;
    this.stopped = true;
  }

  // ─── Lebenszyklus ─────────────────────────────

  /** MQTT dieser Betriebsart (null, solange sie nicht feststeht). */
  get mqtt() {
    if (this.mode === 'isolated') return this.remoteMqtt;
    if (this.mode === 'fence') return this.localMqtt;
    return null;
  }

  async start() {
    this.stopped = false;
    await this.checkFenceNow();
    this.rpc.on('push', (plugin, msg) => {
      const e = this.plugins.get(plugin);
      if (e && e.proc) e.proc.toChild(msg);
    });
    this.rpc.on('open', (session) => this.onRpcOpen(session));
    this.rpc.start();
    // kurz auf die Angaben des Gateways warten (MQTT verfügbar?), damit das hello stimmt
    if (!this.rpc.info) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, INFO_WAIT_MS);
        if (t.unref) t.unref();
        this.rpc.once('info', () => { clearTimeout(t); resolve(); });
      });
    }
    this.mqttAvailable = !!(this.mqtt && this.mqtt.available());
    this.mqttTlsCert = !!(this.mqtt && this.mqtt.tlsCert && this.mqtt.tlsCert());
    this.channel.on('open', () => this.onOpen());
    this.channel.on('close', () => { this.stateSeen = false; this.scheduleStatus(); });
    this.channel.on('message', (m) => this.onMessage(m));
    this.channel.start();
    this.statusTimer = setInterval(() => this.sendStatus(), this.timing.statusEveryMs);
    this.fenceTimer = setInterval(() => this.tick().catch((e) => this.logger.warn({ err: e.message }, 'edge: tick failed')), this.timing.fenceCheckMs);
    for (const t of [this.statusTimer, this.fenceTimer]) if (t.unref) t.unref();
    if (!this.fence.active) this.fastStart();
    this.writeStatusFile();
  }

  /**
   * Gateway-Socket (wieder) verbunden. Nach einer Unterbrechung (Gateway-Container
   * neu gestartet) sind dort alle Sockets und Abos weg – laufende Edge-Teile
   * starten deshalb neu und richten sich frisch ein.
   */
  async onRpcOpen(session) {
    if (session <= 1) return;
    const running = [...this.plugins.values()].filter((e) => e.proc);
    if (!running.length) return;
    this.logger.info({ plugins: running.map((e) => e.id) }, 'edge: gateway socket back — restarting edge parts');
    for (const e of running) await this.stopProcess(e);
    this.requestReconcile();
  }

  onMqttChange() {
    const avail = !!(this.mqtt && this.mqtt.available());
    const tlsCert = !!(this.mqtt && this.mqtt.tlsCert && this.mqtt.tlsCert());
    if (avail !== this.mqttAvailable || tlsCert !== this.mqttTlsCert) {
      this.mqttAvailable = avail;
      this.mqttTlsCert = tlsCert;
      if (this.channel.connected) this.channel.send(this.hello()); // der Server zeigt den Broker an
    }
    this.scheduleStatus();
  }

  /**
   * Beim gemeinsamen Start mit dem Gateway-Container fehlen Zugangsdatei und
   * Marker oft noch: dann alle 2 s nachsehen (höchstens 2 min) statt erst
   * beim nächsten 30-s-Takt.
   */
  fastStart(everyMs = 2000, maxMs = 120000) {
    const until = Date.now() + maxMs;
    const t = setInterval(() => {
      if (this.stopped || Date.now() > until) { clearInterval(t); return; }
      this.tick().then(() => { if (this.fence.active) clearInterval(t); }, () => {});
    }, everyMs);
    if (t.unref) t.unref();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.statusTimer);
    clearInterval(this.fenceTimer);
    clearTimeout(this.statusDebounce);
    this.channel.stop();
    await Promise.all([...this.plugins.values()].map((e) => this.stopProcess(e)));
    if (this.localMqtt) await this.localMqtt.stop();
    this.rpc.stop();
    if (this.mdns) this.mdns.close();
  }

  async tick() {
    if (this.mqtt) { try { this.mqtt.refresh(); } catch (e) { this.logger.warn({ err: e.message }, 'edge: mqtt refresh failed'); } }
    const was = this.fence.active;
    await this.checkFenceNow();
    if (was !== this.fence.active || this.hasRetry()) this.requestReconcile();
    this.writeStatusFile();
  }

  hasRetry() {
    for (const e of this.plugins.values()) if (e.retryAt && e.retryAt <= this.now()) return true;
    return false;
  }

  async checkFenceNow() {
    let f;
    try { f = await this.fenceCheck(); } catch (e) { f = { active: false, backend: null, reason: e.message }; }
    const mode = f.mode === 'isolated' ? 'isolated' : 'fence';
    if (!this.mode) {
      this.mode = mode;
      this.logger.info({ mode }, mode === 'isolated' ? 'edge: container without network (isolated) — network I/O through the gateway'
        : 'edge: container in the host network — the gateway\'s network fence is required');
    } else if (mode !== this.mode) {
      f = { active: false, backend: null, reason: `mode_changed_${mode}` };
    }
    f = { mode: this.mode, active: f.active === true, backend: f.backend || null, reason: f.active ? null : (f.reason || 'inactive') };
    if (f.active !== this.fence.active) {
      if (f.active) this.logger.info({ mode: f.mode, backend: f.backend }, f.mode === 'isolated' ? 'edge: isolation confirmed' : 'edge: network fence active');
      else this.logger.warn({ mode: f.mode, reason: f.reason }, f.mode === 'isolated' ? 'edge: isolation NOT confirmed — edge parts stay stopped'
        : 'edge: network fence NOT active — edge parts stay stopped');
    }
    this.fence = f;
    return f;
  }

  /** Netzgrenze für hello/status: isoliert heißt „keine nötig“ (ältere Server zeigen das als aktiv). */
  fenceView() {
    if (this.mode === 'isolated') return { active: this.fence.active, backend: 'isolated' };
    return { active: this.fence.active, backend: this.fence.backend };
  }

  // ─── Kanal ────────────────────────────────────

  hello() {
    return {
      t: 'hello',
      v: PROTOCOL_VERSION,
      gw: {
        version: this.gatewayVersion,
        edgeHost: EDGE_HOST_VERSION,
        // tlsCert: TLS-Listener mit selbst erzeugtem Zertifikat (der Server schaltet den Schalter danach frei)
        mqtt: { available: !!(this.mqtt && this.mqtt.available()), tlsCert: !!(this.mqtt && this.mqtt.tlsCert && this.mqtt.tlsCert()) },
        fence: this.fenceView(),
        isolation: { mode: this.mode, active: this.fence.active },
        hardware: this.hardware(),
      },
    };
  }

  onOpen() {
    this.channel.send(this.hello());
  }

  onMessage(m) {
    switch (m.t) {
      case 'state': {
        let st;
        try { st = parseState(m); } catch (e) { this.logger.warn({ err: e.message }, 'edge: invalid state ignored'); return; }
        this.desired = st;
        if (!this.stateSeen) { this.stateSeen = true; this.resendEvents(); }
        this.requestReconcile();
        return;
      }
      case 'ack': {
        const e = this.plugins.get(m.plugin);
        if (e && Number.isFinite(m.seq)) e.buffer.ack(m.seq);
        return;
      }
      case 'call':
        this.onCall(m);
        return;
      case 'configure': {
        const e = this.plugins.get(m.plugin);
        if (!e) return;
        e.config = m.data === undefined ? null : m.data; // nur im Speicher, nie auf Platte
        if (e.proc) e.proc.configure(e.config);
        return;
      }
      default:
    }
  }

  async onCall(m) {
    let c;
    try { c = parseCall(m); } catch (e) {
      if (typeof m.id === 'string' && m.id.length <= 64) this.channel.send({ t: 'result', id: m.id, ok: false, error: { code: 'bad_request', message: e.message } });
      return;
    }
    const e = this.plugins.get(c.plugin);
    const reply = (msg) => {
      if (!this.channel.send(msg) && msg.ok) {
        this.channel.send({ t: 'result', id: c.id, ok: false, error: { code: 'too_large', message: 'result larger than the 64 KB frame' } });
      }
    };
    if (!e || !e.wanted) { reply({ t: 'result', id: c.id, ok: false, error: { code: 'not_enabled', message: 'edge part not enabled on this gateway' } }); return; }
    if (e.denied) { reply({ t: 'result', id: c.id, ok: false, error: { code: 'denied', message: e.lastError || 'denied' } }); return; }
    if (!e.proc) { reply({ t: 'result', id: c.id, ok: false, error: { code: 'not_running', message: 'edge part is not running' } }); return; }
    try {
      const result = await e.proc.call(c.method, c.params, c.timeoutMs);
      reply({ t: 'result', id: c.id, ok: true, result: result === undefined ? null : result });
    } catch (err) {
      reply({ t: 'result', id: c.id, ok: false, error: errInfo(err) });
    }
  }

  resendEvents() {
    for (const e of this.plugins.values()) for (const msg of e.buffer.pending()) this.channel.send(msg);
  }

  // ─── Sollzustand ──────────────────────────────

  requestReconcile() {
    if (this.reconciling) { this.again = true; return this.reconcilePromise; }
    this.reconciling = true;
    this.reconcilePromise = (async () => {
      try {
        do {
          this.again = false;
          await this.reconcile();
        } while (this.again && !this.stopped);
      } catch (e) {
        this.logger.error({ err: e.message, stack: e.stack }, 'edge: reconcile failed');
      } finally {
        this.reconciling = false;
        this.scheduleStatus();
      }
    })();
    return this.reconcilePromise;
  }

  entry(id) {
    let e = this.plugins.get(id);
    if (!e) {
      e = {
        id, version: null, sha256: null, spec: null, installed: null, proc: null, wanted: false, denied: false,
        status: 'stopped', lastError: null, retryAt: null, caps: {}, config: null, throttled: 0, restarts: 0,
        buffer: new EventBuffer({ now: this.now }),
        store: new PluginStore(this.paths.dataDir, id),
        net: null,
      };
      // gc.lan.* führt das Gateway aus (bridge.js) – hier keine eigenen Sockets
      e.net = new RemoteNet({ pluginId: id, rpc: this.rpc, caps: () => e.caps });
      this.plugins.set(id, e);
    }
    return e;
  }

  async reconcile() {
    const st = this.desired;
    if (!st) return;
    if (this.mqtt) {
      try { await this.mqtt.apply(st.edgeEnabled ? st.mqtt : { enabled: false, tls: false, accounts: [], pluginTopics: {} }); } catch (e) {
        this.logger.warn({ err: e.message }, 'edge: mqtt apply failed');
      }
    }
    const want = new Map();
    if (st.edgeEnabled) for (const p of st.plugins) if (p.enabled) want.set(p.id, p);
    // nicht mehr gewollt → stoppen
    for (const e of this.plugins.values()) {
      if (!want.has(e.id)) {
        e.wanted = false;
        await this.stopProcess(e);
        e.status = 'stopped';
        e.denied = false;
        e.lastError = null;
      }
    }
    // Pakete von Plugins, die gar nicht mehr im Sollzustand stehen, löschen
    if (st.edgeEnabled) this.store.pruneExcept(new Set(st.plugins.map((p) => p.id)));
    for (const p of want.values()) {
      if (this.stopped) return;
      await this.ensurePlugin(p, st);
    }
    for (const [id, e] of this.plugins) if (!e.wanted && !e.proc && !st.plugins.some((p) => p.id === id)) this.plugins.delete(id);
  }

  deny(e, code, message) {
    e.denied = true;
    e.status = 'denied';
    e.lastError = `${code}: ${message}`.slice(0, 300);
  }

  async ensurePlugin(p, st) {
    const e = this.entry(p.id);
    e.wanted = true;
    e.denied = false;
    if (p.capsError) { await this.stopProcess(e); this.deny(e, 'bad_caps', p.capsError); return; }
    // Paket vorhanden?
    let inst = this.store.installed(p.id, p.version, p.sha256);
    if (!inst) {
      if (e.retryAt && e.retryAt > this.now() && e.version === p.version && e.sha256 === p.sha256) return;
      e.status = e.proc ? 'update_pending' : 'starting';
      this.scheduleStatus();
      try {
        const buf = await this.download({ socketPath: this.socketPath }, p.id, p.version);
        const checked = packages.inspect(buf, { id: p.id, version: p.version, sha256: p.sha256, allowUnsigned: st.allowUnsigned,
          gatewayVersion: this.gatewayVersion, keys: this.keys || signature.trustedKeys() });
        inst = this.store.extract({ id: p.id, version: p.version, sha256: p.sha256 }, checked);
        e.retryAt = null;
        this.logger.info({ plugin: p.id, version: p.version, signature: inst.signature }, 'edge: package installed');
      } catch (err) {
        const info = errInfo(err);
        e.version = p.version;
        e.sha256 = p.sha256;
        if (['download_failed', 'not_found'].includes(info.code)) {
          e.retryAt = this.now() + DOWNLOAD_RETRY_MS;
          if (!e.proc) { e.status = 'stopped'; e.lastError = `${info.code}: ${info.message}`; }
        } else {
          await this.stopProcess(e);
          this.deny(e, info.code, info.message);
        }
        this.logger.warn({ plugin: p.id, version: p.version, err: info.message, code: info.code }, 'edge: package rejected');
        return;
      }
    }
    // Signatur gegen den aktuellen Schalter (allowUnsigned kann zurückgenommen werden)
    if (!signature.acceptable(inst.signature, st.allowUnsigned)) {
      await this.stopProcess(e);
      this.deny(e, 'unsigned', 'unsigned edge parts are not allowed on this gateway');
      return;
    }
    const caps = intersectCaps(inst.edge.capabilities, p.caps);
    const memoryMb = p.memoryMb || inst.edge.memoryMb;
    const spec = { id: p.id, version: p.version, dir: inst.dir, entry: inst.edge.entry, memoryMb };
    const changed = !e.spec || e.spec.version !== spec.version || e.sha256 !== p.sha256 || e.spec.memoryMb !== spec.memoryMb;
    e.caps = caps;
    e.version = p.version;
    e.sha256 = p.sha256;
    e.installed = inst;
    if (!this.fence.active) {
      await this.stopProcess(e);
      if (this.mode === 'isolated') this.deny(e, 'network_isolation_inactive', this.fence.reason || 'isolation not confirmed');
      else this.deny(e, 'network_fence_inactive', this.fence.reason || 'network fence not active');
      e.spec = spec;
      return;
    }
    if (changed && e.proc) await this.stopProcess(e);
    e.spec = spec;
    if (!e.proc) this.startProcess(e);
    else if (e.status === 'denied') e.status = e.proc.state;
  }

  startProcess(e) {
    const proc = new EdgeProcess(e.spec, {
      logger: this.logger,
      backoff: this.backoff,
      now: this.now,
      timing: this.timing,
      hooks: { hostCall: (api, args) => this.hostCall(e, api, args), config: () => e.config },
    });
    e.proc = proc;
    e.status = 'starting';
    e.lastError = null;
    proc.on('state', (s) => {
      e.status = s === 'stopping' ? 'stopped' : s;
      if (s === 'crashed') e.lastError = proc.lastError;
      this.scheduleStatus();
    });
    proc.on('started', () => {
      // alte Versionen erst nach erfolgreichem Start löschen
      try { this.store.prune(e.id, e.spec.version); } catch (err) { this.logger.debug({ err: err.message }, 'edge: prune failed'); }
      this.logger.info({ plugin: e.id, version: e.spec.version }, 'edge: edge part running');
    });
    proc.on('exit', () => {
      e.net.closeAll();
      if (this.mqtt) this.mqtt.dropPlugin(e.id); // ein neuer Prozess abonniert neu
    });
    proc.on('event', (name, data) => {
      const msg = e.buffer.push(e.id, name, data, new Date(this.now()).toISOString());
      this.channel.send(msg);
    });
    proc.on('log', (level, line) => {
      this.logger.debug({ plugin: e.id, level, line }, 'edge part log');
      this.channel.send({ t: 'log', plugin: e.id, level, line });
    });
    proc.start();
  }

  async stopProcess(e) {
    const proc = e.proc;
    if (!proc) return;
    e.restarts += proc.restarts;
    e.throttled += proc.events.drainDropped();
    e.proc = null;
    await proc.stop();
    e.net.closeAll();
    if (this.mqtt) this.mqtt.dropPlugin(e.id);
  }

  // ─── gc.* der Edge-Teile ──────────────────────

  async hostCall(e, api, args) {
    if (!e.wanted || e.denied) throw Object.assign(new Error('edge part not enabled'), { code: 'not_enabled' });
    switch (api) {
      case 'store.get': return e.store.get(args.key);
      case 'store.set': e.store.set(args.key, args.value); return {};
      case 'store.delete': e.store.delete(args.key); return {};
      default:
    }
    if (api.startsWith('mqtt.')) {
      if (!this.mqtt) throw new NetError('not_enabled', 'MQTT is not available on this gateway');
      return this.mqtt.pluginCall(e.id, () => e.caps, api, args, (msg) => { if (e.proc) e.proc.toChild(msg); });
    }
    const fn = e.net.apis()[api];
    if (!fn) throw new NetError('unknown_api', `unknown gc api ${String(api).slice(0, 40)}`);
    return fn(args);
  }

  // ─── Status ───────────────────────────────────

  pluginStatus(e) {
    const info = e.proc ? e.proc.info() : null;
    const throttled = e.throttled + (e.proc ? e.proc.events.drainDropped() : 0);
    e.throttled = 0;
    return {
      id: e.id,
      version: e.version,
      state: e.status,
      rssMb: info ? info.rssMb : null,
      restarts: e.restarts + (e.proc ? e.proc.restarts : 0),
      lastError: e.lastError || (info && info.lastError) || null,
      throttled,
      buffered: e.buffer.size,
    };
  }

  statusMessage() {
    return {
      t: 'status',
      plugins: [...this.plugins.values()].filter((e) => e.wanted || e.proc).map((e) => this.pluginStatus(e)),
      mqtt: this.mqtt ? this.mqtt.status() : { running: false, clients: 0, accounts: [] },
      fence: { ...this.fenceView(), reason: this.fence.reason },
      isolation: { mode: this.mode, active: this.fence.active, reason: this.fence.reason },
    };
  }

  scheduleStatus() {
    if (this.statusDebounce) return;
    this.statusDebounce = setTimeout(() => { this.statusDebounce = null; this.sendStatus(); }, this.timing.statusDebounceMs);
    if (this.statusDebounce.unref) this.statusDebounce.unref();
  }

  sendStatus() {
    const msg = this.statusMessage();
    if (this.channel.connected) this.channel.send(msg);
    this.writeStatusFile(msg);
    this.emit('status', msg);
  }

  /** Zusammenfassung für die Telemetrie des Gateway-Containers (tmpfs, nur bei Bedarf geschrieben). */
  writeStatusFile(msg = null) {
    const dir = this.paths.statusDir;
    if (!dir) return;
    try {
      const m = msg || this.statusMessage();
      const out = {
        at: new Date(this.now()).toISOString(),
        edgeHost: EDGE_HOST_VERSION,
        connected: this.channel.connected === true,
        edgeEnabled: !!(this.desired && this.desired.edgeEnabled),
        hostRssMb: rssMb(process.pid),
        fence: m.fence,
        mode: this.mode,
        isolation: { active: this.fence.active, reason: this.fence.reason },
        plugins: m.plugins.map((p) => ({ id: p.id, version: p.version, state: p.state, rssMb: p.rssMb, restarts: p.restarts })),
        mqtt: { running: m.mqtt.running, clients: m.mqtt.clients },
      };
      const tmp = path.join(dir, `.status.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o644 });
      fs.renameSync(tmp, path.join(dir, 'status.json'));
    } catch (e) {
      this.logger.debug({ err: e.message }, 'edge: status file not written');
    }
  }
}

module.exports = { EdgeHost, LIMITS };
