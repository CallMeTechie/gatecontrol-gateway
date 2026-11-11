'use strict';

// Lokale KI (Phase 3c, Schritt 3 – docs/local-ai.md): der Dienst ki (Ollama)
// neben dem Gateway oder ein vorhandener KI-Server im LAN. Gesteuert über
// features.ai aus dem Config-Pull; Zustand für die Telemetrie (features.ai)
// und die Management-API (/api/ai/*).
//
// Das Gateway entscheidet, der Wächter im Dienst ki führt aus: soll die KI
// laufen, liegt /gc-ai/run im tmpfs-Volume ai-ctl, sonst nicht. Der Wächter
// meldet sich in /gc-ai/ki.state. Pi-Image: /state/ai.json (Wunsch für den
// nächsten Start) und /state/ai-start (Host legt den Container an).
//
// Inferenz läuft im Ollama-Prozess; hier wird nur gestreamt (keine Rechenlast
// in der Ereignisschleife). Höchstens eine Antwort zugleich, zwei warten.
//
// KI-Server im LAN: Adresse als private IPv4/IPv6 oder als Name (resolve.js,
// nur private Adressen), optional mit API-Schlüssel (creds.js – vom Server
// geholt, nie im Config-Pull, nie im Log). Grafikkarte: gpu.js.
//
// https mit selbst signiertem Zertifikat: der Admin heftet es an (lan.pin, SHA-256).
// „Verbindung testen“ zeigt dafür das Zertifikat des Servers (nur der Handshake,
// src/proxy/tlsPin.js); danach gilt jede Verbindung nur mit genau diesem Zertifikat.
// Ohne Pin bleibt die normale Prüfung – sie wird nie abgeschaltet.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeAi, parseLanUrl, parsePin, validModel, validKey, APIS, PIN_INVALID } = require('./config');
const { inspectLeafCertificate } = require('../proxy/tlsPin');
const { createOllama, createOpenAi } = require('./backends');
const { createResolver } = require('./resolve');
const { AiKeyStore } = require('./creds');
const gpu = require('./gpu');
const { readHostProfile } = require('../radio/radio');
const { cleanText } = require('../print/config');
const { loop } = require('../features/status');
const logger = require('../logger');

const SERVICE_BASE = Object.freeze({ protocol: 'http:', host: '127.0.0.1', port: 11435 });
const RUN_FILE = 'run';
const STATE_FILE = 'ki.state';
const WANT_FILE = 'ai.json';
const START_FLAG = 'ai-start';
const ALIVE_S = 60;
const START_GRACE_MS = 3 * 60_000;
const START_FLAG_EVERY_MS = 10 * 60_000;
const TICK_MS = 60_000;
const TICK_BUSY_MS = 5_000;
const GPU_EVERY_MS = 10 * 60_000;
const MAX_ACTIVE = 1;
const MAX_WAITING = 2;
const STATE_RE = /^(idle|running|exit) ([0-9]{1,12})\s*$/;
// was dieses Gateway kann (der Server schaltet danach frei): GPU-Bericht, API-Schlüssel, Namen/IPv6, Verbindungstest,
// angeheftetes Zertifikat (https mit selbst signiertem Zertifikat)
const SUPPORTS = Object.freeze(['gpu', 'lanKey', 'lanHost', 'probe', 'lanPin']);
// der Test zeigt das Zertifikat des Servers, wenn es die Prüfung nicht besteht oder nicht das angeheftete ist
const TLS_ERRORS = new Set(['tls_untrusted', 'tls_pin_mismatch']);

function readText(file, max = 4096) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function writeAtomic(file, text, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/** Grafikkarten aus sysfs (PCI-Klasse 0x03…): nur die Hersteller (gpu.detectHost hat mehr). */
function detectGpus(sysRoot = '/sys') {
  return gpu.detectHost(sysRoot).cards.map((c) => ({ vendor: c.vendor }));
}

/** Body von POST /api/ai/chat → Anfrage oder null (ungültig). */
function parseChat(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  if (!validModel(b.model)) return null;
  const system = b.system == null ? '' : b.system;
  if (typeof system !== 'string') return null;
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 16) return null;
  let chars = system.length;
  const messages = [];
  for (const m of b.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    chars += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (chars > 1_000_000) return null;
  const schema = b.schema == null ? null : b.schema;
  if (schema !== null && (typeof schema !== 'object' || Array.isArray(schema) || JSON.stringify(schema).length > 32_768)) return null;
  const int = (v, min, max, d) => (v == null ? d : (Number.isInteger(v) && v >= min && v <= max ? v : NaN));
  const maxTokens = int(b.maxTokens, 1, 8192, 1024);
  const numCtx = int(b.numCtx, 2048, 32768, 8192);
  const timeoutMs = int(b.timeoutMs, 5000, 15 * 60_000, 5 * 60_000);
  if ([maxTokens, numCtx, timeoutMs].some(Number.isNaN)) return null;
  let temperature = null;
  if (b.temperature != null) {
    if (typeof b.temperature !== 'number' || !(b.temperature >= 0 && b.temperature <= 2)) return null;
    temperature = b.temperature;
  }
  return { model: b.model, system, messages, schema, maxTokens, numCtx, timeoutMs, temperature };
}

class AiService {
  constructor({
    stateDir = null, ctlDir = '/gc-ai', sysRoot = '/sys', procRoot = '/proc', now = Date.now, serviceBackend = null, lanBackend = null,
    serverUrl = null, apiToken = '', keyStore = null, resolver = null, inspect = inspectLeafCertificate,
  } = {}) {
    Object.assign(this, { stateDir, ctlDir, sysRoot, procRoot, now });
    this.cfg = normalizeAi(undefined);
    this.serviceBackend = serviceBackend || createOllama(SERVICE_BASE);
    this.resolver = resolver || createResolver();
    this.keys = keyStore || new AiKeyStore({ serverUrl, apiToken, stateDir });
    this.keysBusy = null;
    this.inspect = inspect;
    this.makeLan = lanBackend || ((lan) => this._lanBackend(lan.url, lan.api, () => this.keys.get(), lan.pin));
    this.lan = null;
    this.reachable = false;
    this.version = null;
    this.models = [];
    this.loadedModels = [];
    this.lastError = null;
    this.pullState = null;          // { model, state, completed, total, status, error, at, ctrl }
    this.active = 0;
    this.waiting = [];              // Warteschlange (resolve-Funktionen)
    this.running = new Set();       // AbortController laufender Antworten
    this.runSince = 0;
    this.lastStartFlag = 0;
    this.hostProfile = null;
    this.gpus = null;
    this.gpuAt = 0;
    this.probing = false;
    this.started = false;
    this.tickLoop = loop(() => this.tick(), () => (this.pullState && this.pullState.state === 'pulling' ? TICK_BUSY_MS : TICK_MS));
  }

  // ─── Einstellung und Dienst ────────────────────────────────────────────
  wantService() { return this.cfg.enabled && this.cfg.source === 'service'; }

  /** Ein Backend für einen KI-Server im LAN: Namen nur an private Adressen, Schlüssel als Bearer, https optional mit Pin. */
  _lanBackend(url, api, auth, pin = null) {
    const p = parseLanUrl(url);
    const base = { protocol: p.protocol, host: p.host, port: p.port, auth };
    if (p.name) base.lookup = this.resolver.lookupFor(p.host);
    if (p.protocol === 'https:' && pin) base.pin = pin;
    return api === 'openai' ? createOpenAi(base) : createOllama(base);
  }

  /**
   * Das Zertifikat, das der KI-Server zeigt (nur der TLS-Handshake, keine Anfrage, kein Schlüssel):
   * { sha256, subject, issuer, validTo, selfSigned } oder null. Derselbe Weg wie die Anfragen –
   * Namen nur an private Adressen.
   */
  async _certificate(p) {
    try {
      const c = await this.inspect({ host: p.host, port: p.port, timeoutMs: 10_000, ...(p.name ? { lookup: this.resolver.lookupFor(p.host) } : {}) });
      if (!c || typeof c.sha256 !== 'string') return null;
      return { sha256: c.sha256, subject: cleanText(c.subject, 200) || null, issuer: cleanText(c.issuer, 200) || null, validTo: c.validTo || null, selfSigned: c.selfSigned === true };
    } catch { return null; }
  }

  /** API-Schlüssel mit keyRev abgleichen (im Hintergrund; danach gleich neu fragen). */
  _syncKey() {
    const rev = this.cfg.enabled && this.cfg.source === 'lan' && this.cfg.lan ? this.cfg.lan.keyRev : null;
    if (!rev) { this.keys.clear(); return; }
    if (this.keysBusy) return;
    this.keysBusy = this.keys.sync(rev).then((fresh) => {
      if (fresh) { logger.info({ key: !!this.keys.get() }, 'ai: API key of the AI server fetched'); this.tick().catch(() => {}); }
    }, (e) => {
      logger.warn({ err: (e && e.code) || 'error' }, 'ai: API key of the AI server not fetched (next config pull tries again)');
    }).finally(() => { this.keysBusy = null; });
  }

  backend() {
    if (!this.cfg.enabled) return null;
    if (this.cfg.source === 'service') return this.serviceBackend;
    return this.lan;
  }

  /** features.ai aus dem Config-Pull. */
  async apply(raw) {
    const before = JSON.stringify(this.cfg);
    this.cfg = normalizeAi(raw);
    const changed = before !== JSON.stringify(this.cfg);
    this.lan = this.cfg.enabled && this.cfg.source === 'lan' && this.cfg.lan ? this.makeLan(this.cfg.lan) : null;
    this._syncKey();
    this.hostProfile = readHostProfile(this.stateDir);
    if (this.wantService() && !this.runSince) this.runSince = this.now();
    if (!this.wantService()) this.runSince = 0;
    if (changed) {
      if (!this.cfg.enabled || this.cfg.source !== 'service') this.cancelPull();
      if (!this.cfg.enabled) for (const c of this.running) c.abort();
      this.reachable = false;
      this.version = null;
      this.models = [];
      this.loadedModels = [];
      logger.info({ enabled: this.cfg.enabled, source: this.cfg.source, lanApi: this.cfg.lan && this.cfg.lan.api, lanKey: !!(this.cfg.lan && this.cfg.lan.keyRev),
        lanPin: !!(this.cfg.lan && this.cfg.lan.pin) }, 'ai: settings applied');
    }
    this._writeControl();
    this._writeWish();
    if (!this.started) {
      this.started = true;
      this.tickLoop.start(2_000);
    } else if (changed) {
      this.tickLoop.stop();
      this.tickLoop.start(1_000);
    }
  }

  stop() {
    this.tickLoop.stop();
    this.started = false;
    this.cancelPull();
    for (const c of this.running) c.abort();
  }

  _ctlUsable() {
    try { fs.accessSync(this.ctlDir, fs.constants.W_OK); return fs.statSync(this.ctlDir).isDirectory(); } catch { return false; }
  }

  _writeControl() {
    if (!this._ctlUsable()) return;
    const file = path.join(this.ctlDir, RUN_FILE);
    try {
      if (!this.wantService()) { fs.rmSync(file, { force: true }); return; }
      const text = 'RUN=1\n';
      if (readText(file) === text) return;
      writeAtomic(file, text);
      logger.info('ai: local AI service switched on');
    } catch (e) { logger.warn({ err: e.message }, 'ai: control file not written'); }
  }

  _writeWish() {
    if (!this.stateDir) return;
    const file = path.join(this.stateDir, WANT_FILE);
    const text = JSON.stringify({ want: this.wantService() }) + '\n';
    try { if (readText(file) !== text) writeAtomic(file, text); } catch (e) { logger.debug({ err: e.message }, 'ai: ai.json not written'); }
  }

  /** managed (Wächter lebt) | absent (Volume da, Container fehlt) | missing (keine Compose-Unterstützung) */
  service() {
    if (!this._ctlUsable()) return 'missing';
    const m = STATE_RE.exec(readText(path.join(this.ctlDir, STATE_FILE), 128) || '');
    if (!m) return 'absent';
    const at = Number(m[2]);
    return Number.isFinite(at) && Math.abs(this.now() / 1000 - at) <= ALIVE_S ? 'managed' : 'absent';
  }

  /** Pi-Image: Host soll den Dienst ki anlegen (höchstens alle 10 Min.). */
  _askHost() {
    if (!this.stateDir || !(this.hostProfile && this.hostProfile.ai_start === true)) return false;
    if (this.now() - this.lastStartFlag < START_FLAG_EVERY_MS) return true;
    try {
      writeAtomic(path.join(this.stateDir, START_FLAG), JSON.stringify({ ai: true, at: new Date(this.now()).toISOString() }) + '\n', 0o600);
      this.lastStartFlag = this.now();
      logger.info('ai: asked the host to start the ki container');
      return true;
    } catch (e) { logger.warn({ err: e.message }, 'ai: ai-start not written'); return false; }
  }

  _gpus() {
    if (!this.gpus || this.now() - this.gpuAt > GPU_EVERY_MS) {
      this.gpus = gpu.detectHost(this.sysRoot, this.procRoot);
      this.gpuAt = this.now();
    }
    return this.gpus;
  }

  hostFacts() {
    const hp = this.hostProfile;
    const memTotal = hp && Number.isSafeInteger(hp.mem_total) && hp.mem_total > 0 ? hp.mem_total : os.totalmem();
    const g = this._gpus();
    return { memTotal, memFree: os.freemem(), cores: os.cpus().length, arch: process.arch, gpu: g.cards, nvidiaDriver: g.nvidiaDriver, kfd: g.kfd, render: g.render };
  }

  /**
   * Die Grafikkarte im Dienst ki (nur source service): GPU-Art der Compose-Datei, ob der
   * Container die Geräte sieht, nvidia-smi, und ob das geladene Modell im Grafikspeicher liegt.
   * null: der Wächter meldet nichts (alte Compose-Datei, Dienst fehlt).
   */
  serviceGpu() {
    if (this.cfg.source !== 'service') return null;
    const s = gpu.readServiceGpu(this.ctlDir, this.now());
    if (!s) return null;
    return { mode: s.mode, devices: s.devices, access: gpu.serviceAccess(s), cards: s.cards, used: this.loadedModels.some((m) => m.vram > 0) };
  }

  // ─── Abfrage ──────────────────────────────────────────────────────────
  /** Einmal den KI-Server fragen (alle 60 s, beim Download alle 5 s). Wirft nie. */
  async tick() {
    const b = this.backend();
    if (!b) { this.reachable = false; return; }
    if (this.wantService()) {
      this._writeControl();
      if (this.service() === 'absent') this._askHost();
    }
    try {
      this.version = await b.version();
      this.reachable = true;
    } catch (e) {
      this.reachable = false;
      this.loadedModels = [];
      // ein Name wird beim nächsten Mal neu aufgelöst (neue Adresse per DHCP)
      if (this.cfg.source === 'lan' && this.cfg.lan) { const p = parseLanUrl(this.cfg.lan.url); if (p && p.name) this.resolver.forget(p.host); }
      if (!(this.wantService() && this.now() - this.runSince < START_GRACE_MS)) this._fail(e);
      return;
    }
    try {
      const [models, loaded] = await Promise.all([b.models(), b.loaded()]);
      this.models = models;
      this.loadedModels = loaded;
      this.lastError = null;
    } catch (e) { this._fail(e); }
  }

  _fail(e) {
    this.lastError = { at: this.now(), code: cleanText(String((e && e.code) || 'error'), 32), message: cleanText(String((e && e.message) || e), 160) };
  }

  /** off | service_missing | starting | running | unreachable | error */
  state() {
    if (!this.cfg.enabled) return 'off';
    if (this.cfg.source === 'lan') {
      if (!this.cfg.lan) return 'error';
      return this.reachable ? 'running' : 'unreachable';
    }
    const svc = this.service();
    if (svc !== 'managed') return 'service_missing';
    if (this.reachable) return 'running';
    return this.now() - this.runSince < START_GRACE_MS ? 'starting' : 'error';
  }

  // ─── Modelle laden / löschen ──────────────────────────────────────────
  /** 'accepted' | 'disabled' | 'lan_source' | 'not_running' | 'pull_running' | 'invalid_model' */
  requestPull(model) {
    if (!this.cfg.enabled) return 'disabled';
    if (this.cfg.source !== 'service') return 'lan_source';
    if (!validModel(model)) return 'invalid_model';
    if (this.pullState && this.pullState.state === 'pulling') return 'pull_running';
    if (!this.reachable) return 'not_running';
    const ctrl = new AbortController();
    const p = { model, state: 'pulling', completed: 0, total: 0, status: null, error: null, at: this.now(), ctrl };
    this.pullState = p;
    logger.info({ model }, 'ai: model download started');
    this.tickLoop.stop();
    this.tickLoop.start(TICK_BUSY_MS);
    this.serviceBackend.pull(model, {
      signal: ctrl.signal,
      onProgress: (x) => { p.completed = x.completed; p.total = x.total; p.status = x.status; },
    }).then(async () => {
      if (p.total) p.completed = p.total;
      logger.info({ model }, 'ai: model downloaded');
      // erst die neue Modell-Liste, dann „fertig“ – der Server sieht beides zusammen
      await this.tick();
      p.state = 'done';
    }, (e) => {
      if (e && e.code === 'aborted') { p.state = 'cancelled'; logger.info({ model }, 'ai: model download cancelled'); return; }
      p.state = 'error';
      p.error = { code: cleanText(String((e && e.code) || 'error'), 32), message: cleanText(String((e && e.message) || e), 160) };
      logger.warn({ model, err: p.error.message }, 'ai: model download failed');
    }).finally(() => { p.ctrl = null; });
    return 'accepted';
  }

  /** 'accepted' | 'no_pull' */
  cancelPull() {
    const p = this.pullState;
    if (!p || p.state !== 'pulling' || !p.ctrl) return 'no_pull';
    p.ctrl.abort();
    return 'accepted';
  }

  /** 'deleted' | 'disabled' | 'lan_source' | 'not_running' | 'invalid_model' | 'not_found' | 'failed' */
  async removeModel(model) {
    if (!this.cfg.enabled) return 'disabled';
    if (this.cfg.source !== 'service') return 'lan_source';
    if (!validModel(model)) return 'invalid_model';
    if (!this.reachable) return 'not_running';
    try {
      await this.serviceBackend.remove(model);
      logger.info({ model }, 'ai: model deleted');
      await this.tick();
      return 'deleted';
    } catch (e) {
      if (e && e.code === 'not_found') return 'not_found';
      this._fail(e);
      return 'failed';
    }
  }

  // ─── Verbindungstest (Einrichtung, noch nicht gespeichert) ──────────────
  /**
   * POST /api/ai/probe { url, api, key?, pin? } – einen KI-Server im LAN fragen, ohne etwas zu
   * speichern: → { reachable, version, models, auth, pinned, certificate, error }. Nur private
   * Ziele (wie lan.url); ein Test zugleich ('busy'). 'invalid_url' | 'invalid' bei falscher Eingabe.
   * https: `pin` (SHA-256) heftet das Zertifikat an. Besteht das Zertifikat die Prüfung nicht
   * (tls_untrusted) oder ist es nicht das angeheftete (tls_pin_mismatch), trägt `certificate`
   * das gezeigte Zertifikat – der Admin vergleicht den Fingerabdruck und bestätigt ihn.
   */
  async probe(b) {
    const body = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    const p = parseLanUrl(body.url);
    if (!p) return { error: 'invalid_url' };
    const api = body.api == null ? 'ollama' : body.api;
    if (!APIS.has(api)) return { error: 'invalid' };
    if (body.key != null && body.key !== '' && !validKey(body.key)) return { error: 'invalid' };
    const pin = parsePin(body.pin, p.protocol);
    if (pin === PIN_INVALID) return { error: 'invalid' };
    if (this.probing) return { error: 'busy' };
    const key = body.key ? body.key : null;
    const b2 = this._lanBackend(p.origin, api, () => key, pin);
    this.probing = true;
    try {
      const version = await b2.version();
      const models = await b2.models();
      return { probe: { reachable: true, url: p.origin, api, version, models, auth: !!key, pinned: !!pin, certificate: null, error: null } };
    } catch (e) {
      const code = cleanText(String((e && e.code) || 'error'), 32);
      const certificate = TLS_ERRORS.has(code) ? await this._certificate(p) : null;
      return { probe: { reachable: false, url: p.origin, api, version: null, models: [], auth: !!key, pinned: !!pin, certificate,
        error: { code, message: cleanText(String((e && e.message) || e), 160) } } };
    } finally {
      this.probing = false;
    }
  }

  // ─── Antworten ────────────────────────────────────────────────────────
  /** Platz in der Warteschlange: true (bekommen), false (voll). */
  async _slot(signal) {
    if (this.active < MAX_ACTIVE) { this.active++; return true; }
    if (this.waiting.length >= MAX_WAITING) return false;
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiting.push(entry);
      signal.addEventListener('abort', () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) { this.waiting.splice(i, 1); reject(Object.assign(new Error('aborted'), { code: 'aborted' })); }
      }, { once: true });
    });
    return true;
  }

  _release() {
    const next = this.waiting.shift();
    if (next) next.resolve(); else this.active = Math.max(0, this.active - 1);
  }

  /** Vor dem Strom: null (geht) oder der Grund (disabled | not_running | busy). */
  canChat() {
    const b = this.backend();
    if (!b) return 'disabled';
    if (this.cfg.source === 'service' && this.service() !== 'managed' && !this.reachable) return 'not_running';
    if (this.active >= MAX_ACTIVE && this.waiting.length >= MAX_WAITING) return 'busy';
    return null;
  }

  /**
   * Eine Antwort: wartet auf den Platz, dann der Strom vom KI-Server.
   * → { inputTokens, outputTokens, finish, model } ; wirft mit code (busy, aborted, timeout, unreachable, model_missing …).
   */
  async chat(q, { onDelta, signal, onStart }) {
    const b = this.backend();
    if (!b) throw Object.assign(new Error('disabled'), { code: 'disabled' });
    if (!await this._slot(signal)) throw Object.assign(new Error('busy'), { code: 'busy' });
    const ctrl = new AbortController();
    const relay = () => ctrl.abort();
    signal.addEventListener('abort', relay, { once: true });
    this.running.add(ctrl);
    try {
      if (onStart) onStart();
      const r = await b.chat(q, { onDelta, signal: ctrl.signal });
      return { ...r, model: q.model };
    } finally {
      signal.removeEventListener('abort', relay);
      this.running.delete(ctrl);
      this._release();
    }
  }

  // ─── Zustand ──────────────────────────────────────────────────────────
  _pullView() {
    const p = this.pullState;
    if (!p) return null;
    return { model: p.model, state: p.state, completed: p.completed, total: p.total, at: new Date(p.at).toISOString(), error: p.error };
  }

  /** features.ai der Telemetrie (klein halten: Heartbeat ≤ 16 KB). */
  featureTelemetry() {
    const h = this.hostFacts();
    return {
      enabled: this.cfg.enabled,
      source: this.cfg.source,
      service: this.service(),
      state: this.state(),
      version: this.version,
      models: this.models.slice(0, 12).map((m) => ({ name: m.name, size: m.size })),
      loaded: this.loadedModels.slice(0, 2).map((m) => ({ name: m.name, size: m.size, vram: m.vram, until: m.until })),
      pull: this._pullView(),
      host: { memTotal: h.memTotal, cores: h.cores, arch: h.arch, gpu: h.gpu, nvidiaDriver: h.nvidiaDriver, kfd: h.kfd, render: h.render },
      gpu: this.serviceGpu(),
      lan: this.cfg.source === 'lan' && this.cfg.lan
        ? { url: this.cfg.lan.url, api: this.cfg.lan.api, reachable: this.reachable, auth: !!this.keys.get(), pinned: !!this.cfg.lan.pin } : null,
      supports: SUPPORTS.slice(),
      busy: { active: this.active, waiting: this.waiting.length },
      error: this.lastError ? { code: this.lastError.code, at: this.lastError.at } : null,
    };
  }

  /** Frischer Zustand für den Server (Einrichtung „Lokale KI“), mit allen Modellen. */
  async status() {
    if (!(this.pullState && this.pullState.state === 'pulling')) await this.tick();
    const t = this.featureTelemetry();
    return { ...t, models: this.models.slice(0, 48), memFree: this.hostFacts().memFree, error: this.lastError };
  }
}

module.exports = { AiService, parseChat, detectGpus, SERVICE_BASE, MAX_ACTIVE, MAX_WAITING, SUPPORTS };
