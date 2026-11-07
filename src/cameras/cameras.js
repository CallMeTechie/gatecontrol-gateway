'use strict';

// Kameras im Heimnetz (Phase 3c, Schritt 4 – docs/cameras.md). Gesteuert über
// features.cameras aus dem Config-Pull; Zustand für die Telemetrie
// (features.cameras), die Berichte an den Server und die Management-API
// (/api/cameras/*).
//
// Das Gateway spricht ONVIF/RTSP/HTTP mit den Kameras selbst (nur Adressen in
// eigenen LAN-Netzen oder features.cameras.subnets) und entscheidet, für
// welche Kamera ein ffmpeg laufen soll; der Wächter im Dienst kameras führt
// aus (Steuerdatei /gc-cam/run/<id>.env, Ring unter /gc-cam/media/<id>/).
// Clips setzt das Gateway aus den Segmenten des Rings zusammen (kein
// Umkodieren) und legt sie unter /recordings ab.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeCameras, hostAllowed, mayRecord, ID_RE, EVENT_ID_RE, KINDS, RTSP_PATH_RE } = require('./config');
const onvif = require('./onvif');
const rtsp = require('./rtsp');
const camHttp = require('./http');
const { discover: wsDiscover } = require('./discovery');
const { Ring } = require('./ring');
const fmp4 = require('./fmp4');
const { CredStore } = require('./creds');
const { readHostProfile } = require('../radio/radio');
const { cleanText } = require('../print/config');
const { loop } = require('../features/status');
const logger = require('../logger');

const SCRIPT = path.join(__dirname, 'kameras.sh');
const WANT_FILE = 'cameras.json';
const START_FLAG = 'cameras-start';
const ALIVE_S = 60;
const TICK_MS = 5_000;
const REC_MS = 1_000;
const RESOLVE_EVERY_MS = 10 * 60_000;
const RESOLVE_RETRY_MS = [30_000, 60_000, 120_000, 300_000];
const REPORT_EVERY_MS = 5 * 60_000;
const REPORT_MIN_MS = 30_000;
const CLEAN_EVERY_MS = 60 * 60_000;
const DEMAND_MS = 60_000;
const PRE_MS = 5_000;
const POST_MS = 10_000;
const MAX_CLIP_MS = 120_000;
const STALE_TRUE_MS = 60_000;
const SNAP_FRESH_MS = 15_000;
const SNAP_MAX = 4 * 1024 * 1024;
const DISK_LOW = 1024 * 1024 * 1024;
const START_FLAG_EVERY_MS = 10 * 60_000;
const MAX_PENDING = 200;
const RANK = { person: 4, vehicle: 3, animal: 2, motion: 1 };
const ONVIF_PORTS = [80, 8000, 2020, 8080, 8899];
// zuletzt ONVIF über HTTPS (Kameras, die nur das anbieten)
const ONVIF_TLS_PORTS = [443];

const rid = (p) => p + crypto.randomBytes(8).toString('hex').slice(0, 15);
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

function readText(file, max = 4096) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function writeAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

class CamError extends Error {
  constructor(code, message, status = 502) { super(message || code); this.code = code; this.status = status; }
}

/** Fehler eines Kamera-Aufrufs → Code der Verträge (auth_failed, unreachable, not_onvif, no_stream, …) */
function codeOf(e) {
  const c = e && typeof e.code === 'string' ? e.code : 'error';
  if (c === 'auth_failed' || c === 'not_allowed' || c === 'not_onvif' || c === 'no_stream' || c === 'tls_untrusted') return c;
  if (c === 'tls_failed') return 'unreachable';
  if (c === 'unreachable' || c === 'timeout' || c === 'aborted') return 'unreachable';
  if (c === 'too_large' || c === 'bad_xml' || c === 'redirect' || c === 'fault') return 'not_onvif';
  return 'error';
}

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** rtsp://host:port/path aus einer Admin-Eingabe → { host, port, path } (ohne Zugang) oder null */
function parseRtspUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'rtsp:' || u.hash) return null;
  const port = u.port ? Number(u.port) : 554;
  const p = (u.pathname || '/') + u.search;
  if (!RTSP_PATH_RE.test(p)) return null;
  return { host: u.hostname, port, path: p, user: u.username ? decodeURIComponent(u.username) : null, password: u.password ? decodeURIComponent(u.password) : null };
}

/**
 * Wo liegt der Clip-Speicher `dir`? Aus /proc/self/mountinfo (pure, getestet):
 *   { mount: 'folder', folder } – ein Ordner des Hosts (GC_CAMERA_DIR, z. B. /volume1/kameras); `folder` ist
 *                                 der Pfad innerhalb seines Dateisystems (Synology: /kameras für /volume1/kameras)
 *   { mount: 'volume', volume }  – ein benanntes Docker-Volume (Standard cam-recordings)
 *   { mount: 'none' }            – kein eigener Mount: die Clips lägen im Container und gingen beim Update verloren
 *   null                         – unbekannt (kein Linux, keine mountinfo)
 */
function mountOf(dir, mountinfo) {
  if (typeof mountinfo !== 'string' || !mountinfo) return null;
  const unesc = (x) => x.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const want = path.resolve(dir);
  let hit = null;
  for (const line of mountinfo.split('\n')) {
    const f = line.split(' ');
    if (f.length < 10) continue;
    if (unesc(f[4]) === want) hit = f; // die letzte Zeile gewinnt (überlagerte Mounts)
  }
  if (!hit) return { mount: 'none' };
  const root = unesc(hit[3]);
  const vol = /\/volumes\/([^/]{1,128})\/_data\/?$/.exec(root);
  if (vol) return { mount: 'volume', volume: cleanText(vol[1], 128) };
  return { mount: 'folder', folder: cleanText(root, 160) || '/' };
}

function isJpeg(b) { return Buffer.isBuffer(b) && b.length > 4 && b[0] === 0xff && b[1] === 0xd8; }

class CameraService {
  constructor({
    reporter = null, serverUrl = '', apiToken = '', stateDir = null, getSubnets = () => [], ctlDir = '/gc-cam', recDir = '/recordings',
    now = Date.now, creds = null, discoverFn = wsDiscover, statfs = (p) => fs.statfsSync(p),
  } = {}) {
    Object.assign(this, { reporter, stateDir, getSubnets, ctlDir, recDir, now, discoverFn, statfs });
    this.cfg = normalizeCameras(undefined);
    this.creds = creds || new CredStore({ serverUrl, apiToken, stateDir });
    this.cams = new Map();          // id → Laufzeit { info, resolvedAt, retry, state, problem, events, kinds, sub, … }
    this.pending = [];              // Ereignis-Meldungen an den Server
    this.lastReport = 0;
    this.reportDirty = true;
    this.lastClean = 0;
    this.lastStartFlag = 0;
    this.hostProfile = null;
    this.discovered = [];
    this.discoveredAt = null;
    this.storage = { path: recDir, free: null, total: null, used: null, clips: null, problem: null, mount: null, folder: null, volume: null };
    this.mountinfo = () => readText('/proc/self/mountinfo', 256 * 1024);
    this.mountAt = 0;
    this.lastError = null;
    this.started = false;
    this.credsBusy = null;
    this.tickLoop = loop(() => this.tick(), () => TICK_MS);
    this.recLoop = loop(() => this.recordStep(), () => REC_MS);
  }

  // ─── Einstellung ──────────────────────────────────────────────────────
  async apply(raw) {
    const before = JSON.stringify(this.cfg);
    this.cfg = normalizeCameras(raw);
    const changed = before !== JSON.stringify(this.cfg);
    this.hostProfile = readHostProfile(this.stateDir);
    if (!this.cfg.enabled) {
      this._stopAll();
      if (changed) { this.creds.clear(); logger.info('cameras: switched off'); }
      this._writeWish();
      if (this.started) { this.tickLoop.stop(); this.recLoop.stop(); this.started = false; }
      return;
    }
    const ids = new Set(this.cfg.cameras.map((c) => c.id));
    for (const [id, rt] of this.cams) if (!ids.has(id)) { this._stopEvents(rt); this._removeRun(id); this.cams.delete(id); }
    for (const c of this.cfg.cameras) {
      const rt = this.cams.get(c.id);
      if (!rt) this.cams.set(c.id, this._runtime(c));
      else if (JSON.stringify(rt.cam) !== JSON.stringify(c)) {
        const hostChanged = rt.cam.host !== c.host || JSON.stringify(rt.cam.onvif) !== JSON.stringify(c.onvif) || JSON.stringify(rt.cam.rtsp) !== JSON.stringify(c.rtsp) || rt.cam.profile !== c.profile || rt.cam.stream !== c.stream || rt.cam.tlsInsecure !== c.tlsInsecure;
        rt.cam = c;
        if (hostChanged) { rt.info = null; rt.resolvedAt = 0; rt.retryAt = 0; this._stopEvents(rt); }
      }
    }
    this._installScript();
    this._writeWish();
    this._syncCreds();
    if (changed) { this.reportDirty = true; logger.info({ cameras: this.cfg.cameras.length, nobodyHome: this.cfg.nobodyHome }, 'cameras: settings applied'); }
    if (!this.started) {
      this.started = true;
      this.tickLoop.start(1_000);
      this.recLoop.start(REC_MS);
    } else if (changed) { this.tickLoop.stop(); this.tickLoop.start(500); }
  }

  stop() {
    this.tickLoop.stop();
    this.recLoop.stop();
    this.started = false;
    for (const rt of this.cams.values()) this._stopEvents(rt);
  }

  _runtime(cam) {
    return {
      cam, info: null, resolvedAt: 0, retryAt: 0, retries: 0, state: 'starting', problem: null,
      events: 'off', kinds: [], sub: null, active: new Map(), lastTrueAt: 0, event: null,
      liveUntil: 0, snapUntil: 0, runWritten: null, snapshotAt: null, lastEventAt: null, codec: cam.codec, width: null, height: null, audio: null,
    };
  }

  _stopAll() {
    for (const [id, rt] of this.cams) { this._stopEvents(rt); this._removeRun(id); }
    this.cams.clear();
  }

  _syncCreds() {
    if (this.credsBusy || !this.cfg.enabled) return this.credsBusy;
    this.credsBusy = this.creds.sync(this.cfg.credRev).then((fresh) => {
      if (fresh) { for (const rt of this.cams.values()) { rt.resolvedAt = 0; rt.retryAt = 0; rt.runWritten = null; } logger.info('cameras: access data loaded'); }
    }, (e) => { this._fail({ code: 'credentials', message: e.message }); logger.warn({ err: e.message }, 'cameras: access data not loaded'); })
      .finally(() => { this.credsBusy = null; });
    return this.credsBusy;
  }

  _fail(e) { this.lastError = { at: this.now(), code: cleanText(String((e && e.code) || 'error'), 32), message: cleanText(String((e && e.message) || e), 160) }; }

  allowed(host) { return hostAllowed(host, this.getSubnets(), this.cfg.subnets); }

  // ─── Dienst kameras ───────────────────────────────────────────────────
  _ctlUsable() {
    try { fs.accessSync(this.ctlDir, fs.constants.W_OK); return fs.statSync(this.ctlDir).isDirectory(); } catch { return false; }
  }

  /** managed (Wächter lebt) | absent (Volume da, Container fehlt) | missing (keine Compose-Unterstützung) */
  service() {
    if (!this._ctlUsable()) return 'missing';
    const m = /^alive ([0-9]{1,12})\s*$/.exec(readText(path.join(this.ctlDir, 'kameras.state'), 64) || '');
    if (!m) return 'absent';
    return Math.abs(this.now() / 1000 - Number(m[1])) <= ALIVE_S ? 'managed' : 'absent';
  }

  _installScript() {
    if (!this._ctlUsable()) return;
    try {
      const src = fs.readFileSync(SCRIPT);
      const dst = path.join(this.ctlDir, 'kameras.sh');
      let cur = null;
      try { cur = fs.readFileSync(dst); } catch { cur = null; }
      if (!cur || !cur.equals(src)) writeAtomic(dst, src, 0o600);
      fs.mkdirSync(path.join(this.ctlDir, 'run'), { recursive: true, mode: 0o700 });
    } catch (e) { logger.warn({ err: e.message }, 'cameras: watcher script not installed'); }
  }

  _writeWish() {
    if (!this.stateDir) return;
    const file = path.join(this.stateDir, WANT_FILE);
    const text = JSON.stringify({ want: this.cfg.enabled }) + '\n';
    try { if (readText(file) !== text) writeAtomic(file, text, 0o644); } catch (e) { logger.debug({ err: e.message }, 'cameras: cameras.json not written'); }
  }

  _askHost() {
    if (!this.stateDir || !(this.hostProfile && this.hostProfile.cameras_start === true)) return;
    if (this.now() - this.lastStartFlag < START_FLAG_EVERY_MS) return;
    try {
      writeAtomic(path.join(this.stateDir, START_FLAG), JSON.stringify({ cameras: true, at: new Date(this.now()).toISOString() }) + '\n');
      this.lastStartFlag = this.now();
      logger.info('cameras: asked the host to start the kameras container');
    } catch (e) { logger.warn({ err: e.message }, 'cameras: cameras-start not written'); }
  }

  _runFile(id) { return path.join(this.ctlDir, 'run', `${id}.env`); }

  _removeRun(id) {
    try { fs.rmSync(this._runFile(id), { force: true }); } catch { /* fehlt */ }
  }

  /** RTSP-Adresse mit Zugang für ffmpeg (nur in die Steuerdatei, nie ins Log). */
  _rtspUrl(rt) {
    const s = rt.info && rt.info.rtsp;
    if (!s) return null;
    const cr = this.creds.get(rt.cam.id);
    const auth = cr && cr.user ? `${encodeURIComponent(cr.user)}:${encodeURIComponent(cr.password || '')}@` : '';
    return `rtsp://${auth}${rt.cam.host}:${s.port}${s.path}`;
  }

  _writeRun(rt) {
    if (!this._ctlUsable()) return false;
    const url = this._rtspUrl(rt);
    if (!url) return false;
    const vtag = (rt.codec || rt.cam.codec) === 'h265' ? 'hvc1' : '';
    const text = `URL=${url}\nAUDIO=${rt.cam.audio ? 1 : 0}\nVTAG=${vtag}\n`;
    if (rt.runWritten === text && fs.existsSync(this._runFile(rt.cam.id))) return true;
    try {
      fs.mkdirSync(path.join(this.ctlDir, 'run'), { recursive: true, mode: 0o700 });
      writeAtomic(this._runFile(rt.cam.id), text, 0o600);
      rt.runWritten = text;
      return true;
    } catch (e) { logger.warn({ err: e.message, camera: rt.cam.id }, 'cameras: control file not written'); return false; }
  }

  ring(id) { return new Ring(path.join(this.ctlDir, 'media', id)); }

  /** Läuft der Ring (Wächter meldet running, Liste frisch)? */
  ringState(id) {
    const st = /^(running|exit|wait|idle) ([0-9]{1,12})/.exec(readText(path.join(this.ctlDir, 'state', id), 64) || '');
    const r = this.ring(id);
    const m = r.mtime('index.m3u8');
    if (m && this.now() - m < 15_000) return 'running';
    if (st && st[1] === 'running') return 'starting';
    if (st && (st[1] === 'exit' || st[1] === 'wait')) return 'error';
    return 'idle';
  }

  // ─── Kamera auflösen (ONVIF / RTSP) ───────────────────────────────────
  _ctx(rt, cr, extra = {}) {
    return {
      host: rt.cam.host, port: rt.cam.onvif ? rt.cam.onvif.port : 80, tls: !!(rt.cam.onvif && rt.cam.onvif.tls), insecure: rt.cam.tlsInsecure === true,
      user: cr ? cr.user : null, password: cr ? cr.password : null, offsetMs: rt.offsetMs || 0, ...extra,
    };
  }

  /** Stream, Snapshot, Ereignis-Adresse, Codec. Wirft nie (setzt state/problem). */
  async resolve(rt) {
    const cam = rt.cam;
    if (!this.allowed(cam.host)) { rt.state = 'not_allowed'; rt.problem = 'not_allowed'; return; }
    const cr = this.creds.get(cam.id);
    try {
      if (cam.onvif) {
        const info = await this.onvifInfo({
          host: cam.host, port: cam.onvif.port, path: cam.onvif.path, tls: cam.onvif.tls === true, insecure: cam.tlsInsecure === true,
          user: cr && cr.user, password: cr && cr.password, profile: cam.profile, stream: cam.stream, kinds: true,
        });
        rt.offsetMs = info.offsetMs;
        if (cam.rtsp) info.rtsp = cam.rtsp;
        rt.info = info;
        rt.codec = info.codec || cam.codec;
        rt.width = info.width; rt.height = info.height;
        rt.kinds = info.kinds;
        rt.events = info.events ? 'pullpoint' : 'unsupported';
        // Ton: ONVIF nennt es nicht verlässlich – das SDP des Streams sagt es (ein kurzes DESCRIBE, Fehler = unbekannt)
        rt.audio = await this._audioOf(cam, info.rtsp, cr);
      } else {
        const d = await rtsp.describe({ host: cam.host, port: cam.rtsp.port, path: cam.rtsp.path, user: cr && cr.user, password: cr && cr.password });
        rt.info = { rtsp: cam.rtsp, snapshot: null, events: null, device: null, codec: d.codec, audio: d.audio };
        rt.codec = d.codec; rt.audio = d.audio;
        rt.events = 'unsupported';
      }
      rt.state = 'ok'; rt.problem = null; rt.resolvedAt = this.now(); rt.retries = 0;
    } catch (e) {
      const code = codeOf(e);
      rt.state = code === 'auth_failed' ? 'auth_failed' : (code === 'unreachable' ? 'unreachable' : (code === 'no_stream' ? 'no_stream' : (code === 'tls_untrusted' ? 'tls_untrusted' : 'error')));
      rt.problem = code;
      rt.retryAt = this.now() + RESOLVE_RETRY_MS[Math.min(rt.retries, RESOLVE_RETRY_MS.length - 1)];
      rt.retries++;
      logger.info({ camera: cam.id, problem: code }, 'cameras: camera not reachable');
    }
    this.reportDirty = true;
  }

  /** Hat der Stream eine Tonspur? true/false aus dem SDP, null wenn das DESCRIBE nicht klappt. */
  async _audioOf(cam, parts, cr) {
    if (!parts || !Number.isInteger(parts.port)) return null;
    try {
      const d = await rtsp.describe({ host: cam.host, port: parts.port, path: parts.path, user: cr && cr.user, password: cr && cr.password });
      return d.audio === true;
    } catch { return null; }
  }

  /**
   * ONVIF einer Kamera abfragen: Uhr, Geräteinfo, Fähigkeiten, Profile, Stream/Snapshot des
   * gewählten Profils, Ereignis-Arten. → { device, profiles, profile, rtsp, snapshot, events, kinds, codec, width, height, offsetMs }
   */
  async onvifInfo({ host, port, path: devPath = onvif.DEVICE_PATH, tls = false, insecure = false, user, password, profile = null, stream = 'main', kinds = false, allProfiles = false }) {
    const ctx = { host, port, tls, insecure, user, password, offsetMs: 0 };
    try { ctx.offsetMs = await onvif.clockOffset(ctx, devPath); } catch (e) { if (codeOf(e) === 'unreachable') throw e; }
    const device = await onvif.deviceInfo(ctx, devPath);
    const caps = await onvif.capabilities(ctx, devPath);
    const mediaPath = (caps.media && caps.media.path) || devPath;
    const mctx = caps.media ? onvif.at(ctx, caps.media) : ctx;
    const list = await onvif.profiles(mctx, mediaPath);
    const usable = list.filter((p) => p.codec === 'h264' || p.codec === 'h265');
    if (!usable.length) throw new onvif.OnvifError('no_stream', 'the camera has no H.264/H.265 profile');
    const pick = usable.find((p) => p.token === profile) || (stream === 'sub' && usable[1]) || usable[0];
    const rtspParts = await onvif.streamUri(mctx, mediaPath, pick.token);
    if (!rtspParts) throw new onvif.OnvifError('no_stream', 'the camera named no RTSP address');
    const snapshot = await onvif.snapshotUri(mctx, mediaPath, pick.token).catch(() => null);
    const profiles = [];
    if (allProfiles) {
      for (const p of usable.slice(0, 4)) {
        const r = p.token === pick.token ? rtspParts : await onvif.streamUri(mctx, mediaPath, p.token).catch(() => null);
        profiles.push({ ...p, rtsp: r, snapshot: p.token === pick.token ? !!snapshot : null });
      }
    }
    let events = null;
    let found = [];
    if (caps.events) {
      events = caps.events;
      if (kinds) found = await onvif.eventKinds(onvif.at(ctx, caps.events), caps.events.path).catch(() => []);
    }
    return {
      device, profiles, profile: pick.token, rtsp: rtspParts,
      snapshot: snapshot ? { port: snapshot.port || (snapshot.tls ? 443 : 80), path: snapshot.path, ...(snapshot.tls ? { tls: true } : {}) } : null,
      events, kinds: found, codec: pick.codec, width: pick.width, height: pick.height, offsetMs: ctx.offsetMs,
      media: { port: mctx.port, path: mediaPath, ...(mctx.tls ? { tls: true } : {}) },
    };
  }

  // ─── Takt ─────────────────────────────────────────────────────────────
  wantRing(rt) {
    const t = this.now();
    if (rt.state !== 'ok' || !rt.info || !rt.info.rtsp) return false;
    if (rt.liveUntil > t || rt.snapUntil > t) return true;
    return mayRecord(rt.cam, this.cfg.nobodyHome);
  }

  wantEvents(rt) {
    return rt.state === 'ok' && !!(rt.info && rt.info.events) && rt.cam.events.length > 0 && mayRecord(rt.cam, this.cfg.nobodyHome);
  }

  /** Einmal alles nachziehen (alle 5 s). Wirft nie. */
  async tick() {
    if (!this.cfg.enabled) return;
    const t = this.now();
    const svc = this.service();
    if (svc === 'managed') this._installScript();
    else if (svc === 'absent') this._askHost();
    if (this.credsBusy) await this.credsBusy.catch(() => {});
    for (const rt of this.cams.values()) {
      const due = !rt.resolvedAt ? t >= rt.retryAt : t - rt.resolvedAt > RESOLVE_EVERY_MS;
      if (due) await this.resolve(rt);
      if (this.wantRing(rt) && svc !== 'missing') this._writeRun(rt);
      else if (rt.runWritten !== null || fs.existsSync(this._runFile(rt.cam.id))) { this._removeRun(rt.cam.id); rt.runWritten = null; }
      if (this.wantEvents(rt)) { if (!rt.sub) this._startEvents(rt); } else if (rt.sub) this._stopEvents(rt);
      if (!this.wantEvents(rt) && rt.event) this._endEvent(rt, t, true);
      const snap = this.ring(rt.cam.id).mtime('snap.jpg');
      if (snap) rt.snapshotAt = snap;
    }
    if (t - this.lastClean > CLEAN_EVERY_MS) { this.lastClean = t; this.cleanup(); }
    this._disk();
    await this._flush();
    if ((this.reportDirty && t - this.lastReport > REPORT_MIN_MS) || t - this.lastReport > REPORT_EVERY_MS) await this.report();
  }

  _disk() {
    // wo die Clips liegen (Ordner der NAS / Docker-Volume / im Container) – ändert sich nur mit einem Neustart, stündlich frisch
    if (!this.mountAt || this.now() - this.mountAt > CLEAN_EVERY_MS) {
      this.mountAt = this.now();
      const m = mountOf(this.recDir, this.mountinfo());
      Object.assign(this.storage, { mount: m ? m.mount : null, folder: (m && m.folder) || null, volume: (m && m.volume) || null });
    }
    try {
      fs.accessSync(this.recDir, fs.constants.W_OK);
      const s = this.statfs(this.recDir);
      const free = Number(s.bavail) * Number(s.bsize);
      const total = Number(s.blocks) * Number(s.bsize);
      this.storage.free = Number.isFinite(free) ? free : null;
      this.storage.total = Number.isFinite(total) ? total : null;
      this.storage.problem = this.storage.free !== null && this.storage.free < DISK_LOW ? 'disk_low' : null;
    } catch { this.storage.problem = 'not_writable'; this.storage.free = null; this.storage.total = null; }
  }

  // ─── Ereignisse (ONVIF PullPoint) ─────────────────────────────────────
  _startEvents(rt) {
    const ctrl = new AbortController();
    rt.sub = { ctrl };
    const run = async () => {
      let backoff = 30_000;
      while (!ctrl.signal.aborted) {
        const cr = this.creds.get(rt.cam.id);
        const ev = rt.info && rt.info.events;
        if (!ev) return;
        const ctx = { ...onvif.at(this._ctx(rt, cr), ev), signal: ctrl.signal };
        let sub = null;
        try {
          sub = await onvif.createPullPoint(ctx, ev.path);
          rt.events = 'pullpoint';
          this.reportDirty = true;
          let renewAt = this.now() + 60_000;
          backoff = 30_000;
          while (!ctrl.signal.aborted) {
            const msgs = await onvif.pullMessages(ctx, sub, { timeoutS: 10 });
            for (const m of msgs) this.onMessage(rt, m);
            if (this.now() >= renewAt) { await onvif.renew(ctx, sub); renewAt = this.now() + 60_000; }
          }
        } catch (e) {
          if (ctrl.signal.aborted) break;
          rt.events = 'error';
          this.reportDirty = true;
          logger.info({ camera: rt.cam.id, problem: codeOf(e) }, 'cameras: event subscription lost');
          await new Promise((r) => { const tt = setTimeout(r, backoff); tt.unref(); ctrl.signal.addEventListener('abort', () => { clearTimeout(tt); r(); }, { once: true }); });
          backoff = Math.min(backoff * 2, 300_000);
        } finally {
          if (sub && ctrl.signal.aborted) onvif.unsubscribe({ ...ctx, signal: undefined }, sub);
        }
      }
    };
    run().catch(() => {});
  }

  _stopEvents(rt) {
    if (rt.sub) { rt.sub.ctrl.abort(); rt.sub = null; }
    rt.active.clear();
  }

  /** Eine ONVIF-Nachricht → Ereignis beginnen/erweitern/beenden. */
  onMessage(rt, msg) {
    const t = this.now();
    let any = false;
    for (const { kind, active } of onvif.classify(msg.topic, msg.items)) {
      rt.active.set(kind, active);
      if (active) rt.lastTrueAt = t;
      any = true;
    }
    if (!any) return;
    const wanted = rt.cam.events;
    const hits = [...rt.active].filter(([k, on]) => on && (wanted.includes(k) || wanted.includes('motion'))).map(([k]) => k);
    if (hits.length && mayRecord(rt.cam, this.cfg.nobodyHome)) {
      if (!rt.event) this._startEvent(rt, t, hits);
      else {
        const before = rt.event.kind;
        for (const k of hits) rt.event.kinds.add(k);
        rt.event.endAt = null;
        rt.event.kind = [...rt.event.kinds].sort((a, b) => RANK[b] - RANK[a])[0];
        if (rt.event.kind !== before) this._queue(rt, 'update');
      }
    } else if (rt.event && !rt.event.endAt) rt.event.endAt = t + POST_MS;
  }

  _startEvent(rt, t, kinds) {
    const ev = {
      id: rid('e'), cameraId: rt.cam.id, kinds: new Set(kinds), kind: kinds.slice().sort((a, b) => RANK[b] - RANK[a])[0],
      startedAt: t, endAt: null, endedAt: null, nobodyHome: this.cfg.nobodyHome, clip: null, thumb: false, rec: null, sent: false,
    };
    rt.event = ev;
    rt.lastEventAt = t;
    const day = path.join(this.recDir, rt.cam.id, dayOf(t));
    ev.dir = day;
    const canRecord = this.service() === 'managed' && !this.storage.problem && this.ringState(rt.cam.id) === 'running';
    if (canRecord) {
      try { ev.rec = this._openClip(rt, ev); } catch (e) { logger.warn({ err: e.message, camera: rt.cam.id }, 'cameras: clip not started'); }
    }
    this._queue(rt, 'start');
    // Vorschaubild kurz nach dem Beginn (die Person ist dann meist im Bild)
    setTimeout(() => { this._thumb(rt, ev).catch(() => {}); }, 1500).unref();
    logger.info({ camera: rt.cam.id, kind: ev.kind, clip: !!ev.rec }, 'cameras: event');
  }

  async _thumb(rt, ev) {
    let img = null;
    try { img = await this.snapshot(rt.cam.id, { maxBytes: 1024 * 1024, wait: false }); } catch { img = null; }
    if (!img) return;
    try {
      fs.mkdirSync(ev.dir, { recursive: true, mode: 0o750 });
      writeAtomic(path.join(ev.dir, `${ev.id}.jpg`), img.data, 0o640);
      ev.thumb = true;
      if (ev.endedAt) this._writeMeta(rt, ev);
    } catch (e) { logger.debug({ err: e.message }, 'cameras: thumbnail not written'); }
  }

  _endEvent(rt, t, force = false) {
    const ev = rt.event;
    if (!ev) return;
    ev.endedAt = ev.endAt && !force ? ev.endAt - POST_MS : t;
    rt.event = null;
    if (ev.rec) this._closeClip(ev);
    this._writeMeta(rt, ev);
    this._queue(rt, 'end', ev);
  }

  _writeMeta(rt, ev) {
    try {
      fs.mkdirSync(ev.dir, { recursive: true, mode: 0o750 });
      const meta = { id: ev.id, cameraId: ev.cameraId, kind: ev.kind, kinds: [...ev.kinds], startedAt: iso(ev.startedAt), endedAt: iso(ev.endedAt), nobodyHome: ev.nobodyHome, clip: ev.clip, thumb: ev.thumb };
      writeAtomic(path.join(ev.dir, `${ev.id}.json`), JSON.stringify(meta) + '\n', 0o640);
    } catch (e) { logger.debug({ err: e.message }, 'cameras: event meta not written'); }
  }

  _queue(rt, phase, ev = rt.event) {
    if (!ev) return;
    this.pending.push({
      id: ev.id, cameraId: ev.cameraId, kind: ev.kind, kinds: [...ev.kinds], phase, startedAt: iso(ev.startedAt), endedAt: iso(ev.endedAt),
      nobodyHome: ev.nobodyHome, clip: ev.clip, thumb: ev.thumb,
    });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    this._flush().catch(() => {});
  }

  async _flush() {
    if (!this.reporter || !this.pending.length || this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length) {
        const batch = this.pending.slice(0, 32);
        const r = await this.reporter.post('/api/v1/gateway/cameras/events', { events: batch });
        if (!r.ok) break;
        this.pending.splice(0, batch.length);
      }
    } finally { this.flushing = false; }
  }

  // ─── Clips ────────────────────────────────────────────────────────────
  _openClip(rt, ev) {
    const ring = this.ring(rt.cam.id);
    const init = ring.read('init.mp4', 1024 * 1024);
    const pl = ring.playlist();
    if (!init || !pl || !pl.segments.length) return null;
    const info = fmp4.initInfo(init);
    const { buf, durationOffset } = fmp4.withMehd(init, 0n);
    fs.mkdirSync(ev.dir, { recursive: true, mode: 0o750 });
    const part = path.join(ev.dir, `.${ev.id}.part`);
    const fd = fs.openSync(part, 'w', 0o640);
    fs.writeSync(fd, buf);
    const rec = { ring, fd, part, durationOffset, movieTs: info.movieTimescale, base: null, lastSeq: -1, ms: 0, bytes: buf.length, initMtime: ring.mtime('init.mp4') };
    // Vorlauf: Segmente, die bis PRE_MS vor dem Ereignis zurückreichen
    const from = ev.startedAt - PRE_MS;
    const pre = pl.segments.filter((s) => (s.at === null ? true : s.at + s.duration * 1000 >= from));
    const start = pre.length ? pre : pl.segments.slice(-1);
    for (const s of start.slice(-Math.ceil(PRE_MS / 1000) - 2)) this._append(rec, s);
    return rec;
  }

  _append(rec, seg) {
    const b = rec.ring.read(seg.name);
    if (!b) return false;
    if (!rec.base) rec.base = fmp4.firstTimes(b);
    const out = fmp4.rebase(b, rec.base);
    fs.writeSync(rec.fd, out);
    rec.bytes += out.length;
    rec.ms += Math.round(seg.duration * 1000);
    rec.lastSeq = seg.seq;
    return true;
  }

  _closeClip(ev) {
    const rec = ev.rec;
    ev.rec = null;
    try {
      const d = Buffer.alloc(8);
      d.writeBigUInt64BE(BigInt(Math.round((rec.ms / 1000) * rec.movieTs)));
      fs.writeSync(rec.fd, d, 0, 8, rec.durationOffset);
      fs.fsyncSync(rec.fd);
      fs.closeSync(rec.fd);
      if (rec.ms <= 0) { fs.rmSync(rec.part, { force: true }); return; }
      fs.renameSync(rec.part, path.join(ev.dir, `${ev.id}.mp4`));
      ev.clip = { ms: rec.ms, bytes: rec.bytes };
    } catch (e) {
      logger.warn({ err: e.message }, 'cameras: clip not finished');
      try { fs.closeSync(rec.fd); } catch { /* closed */ }
      try { fs.rmSync(rec.part, { force: true }); } catch { /* fehlt */ }
    }
  }

  /** Jede Sekunde: laufende Clips weiterschreiben, Ereignisse beenden. */
  recordStep() {
    const t = this.now();
    for (const rt of this.cams.values()) {
      const ev = rt.event;
      if (!ev) continue;
      // Kameras, die kein „aus“ schicken: nach 60 s ohne neues „an“ gilt die Bewegung als vorbei
      if (!ev.endAt && rt.lastTrueAt && t - rt.lastTrueAt > STALE_TRUE_MS) ev.endAt = t;
      if (ev.rec) {
        try {
          const pl = ev.rec.ring.playlist();
          const restarted = ev.rec.ring.mtime('init.mp4') !== ev.rec.initMtime || (pl && pl.segments.length && pl.segments[pl.segments.length - 1].seq < ev.rec.lastSeq);
          if (restarted) ev.endAt = t;
          else if (pl) for (const s of pl.segments) if (s.seq > ev.rec.lastSeq && ev.rec.ms < MAX_CLIP_MS) this._append(ev.rec, s);
        } catch (e) { logger.debug({ err: e.message }, 'cameras: clip step failed'); }
      }
      const tooLong = t - ev.startedAt >= MAX_CLIP_MS || (ev.rec && ev.rec.ms >= MAX_CLIP_MS);
      if ((ev.endAt && t >= ev.endAt) || tooLong) this._endEvent(rt, t, tooLong && !ev.endAt);
    }
  }

  /** Pfad einer Ereignis-Datei (clip.mp4 | thumb.jpg) oder null. */
  eventFile(eventId, kind) {
    if (!EVENT_ID_RE.test(String(eventId))) return null;
    const ext = kind === 'clip' ? 'mp4' : 'jpg';
    let camDirs = [];
    try { camDirs = fs.readdirSync(this.recDir).filter((n) => ID_RE.test(n)); } catch { return null; }
    for (const c of camDirs) {
      let days = [];
      try { days = fs.readdirSync(path.join(this.recDir, c)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse(); } catch { continue; }
      for (const d of days.slice(0, 120)) {
        const p = path.join(this.recDir, c, d, `${eventId}.${ext}`);
        try { const st = fs.lstatSync(p); if (st.isFile()) return { path: p, size: st.size }; } catch { /* weiter */ }
      }
    }
    return null;
  }

  deleteEvents(ids) {
    let n = 0;
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 100)) {
      if (!EVENT_ID_RE.test(String(id))) continue;
      for (const k of ['clip', 'thumb']) {
        const f = this.eventFile(id, k);
        if (f) { try { fs.rmSync(f.path, { force: true }); n += k === 'clip' ? 1 : 0; fs.rmSync(f.path.replace(/\.(mp4|jpg)$/, '.json'), { force: true }); } catch { /* weg */ } }
      }
    }
    return n;
  }

  /** Stündlich: Tage älter als die Aufbewahrung löschen, Belegung zählen. */
  cleanup() {
    const days = new Map(this.cfg.cameras.map((c) => [c.id, c.retentionDays]));
    let used = 0;
    let clips = 0;
    let names = [];
    try { names = fs.readdirSync(this.recDir); } catch { return; }
    for (const c of names.filter((n) => ID_RE.test(n))) {
      const keep = days.get(c) || 7;
      const cut = dayOf(this.now() - keep * 86400_000);
      let ds = [];
      try { ds = fs.readdirSync(path.join(this.recDir, c)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)); } catch { continue; }
      for (const d of ds) {
        const dir = path.join(this.recDir, c, d);
        if (d < cut) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } continue; }
        try {
          for (const f of fs.readdirSync(dir)) {
            const st = fs.lstatSync(path.join(dir, f));
            if (!st.isFile()) continue;
            used += st.size;
            if (f.endsWith('.mp4')) clips++;
            // Reste abgebrochener Clips (älter als 10 Min.)
            if (f.endsWith('.part') && this.now() - st.mtimeMs > 600_000) fs.rmSync(path.join(dir, f), { force: true });
          }
        } catch { /* weiter */ }
      }
    }
    this.storage.used = used;
    this.storage.clips = clips;
  }

  // ─── Standbild, Live ──────────────────────────────────────────────────
  _rt(id) {
    if (!ID_RE.test(String(id))) throw new CamError('unknown_camera', 'unknown camera', 404);
    const rt = this.cams.get(id);
    if (!rt) throw new CamError('unknown_camera', 'unknown camera', 404);
    return rt;
  }

  /** → { data (JPEG), at } | null (wait false); wirft CamError. */
  async snapshot(id, { maxBytes = SNAP_MAX, wait = true } = {}) {
    if (!this.cfg.enabled) throw new CamError('feature_disabled', 'cameras are off', 503);
    const rt = this._rt(id);
    const max = Math.min(SNAP_MAX, Math.max(16 * 1024, Number.isInteger(maxBytes) ? maxBytes : SNAP_MAX));
    const ring = this.ring(id);
    const fresh = () => {
      const m = ring.mtime('snap.jpg');
      if (!m || this.now() - m > SNAP_FRESH_MS) return null;
      const b = ring.read('snap.jpg', max);
      return isJpeg(b) ? { data: b, at: m } : null;
    };
    const f = fresh();
    if (f) return f;
    if (rt.info && rt.info.snapshot && this.allowed(rt.cam.host)) {
      const cr = this.creds.get(id);
      try {
        const r = await camHttp.request({
          host: rt.cam.host, port: rt.info.snapshot.port, path: rt.info.snapshot.path, tls: rt.info.snapshot.tls === true, insecure: rt.cam.tlsInsecure === true,
          user: cr && cr.user, password: cr && cr.password, maxBytes: SNAP_MAX, timeoutMs: 8000,
        });
        if (r.status === 200 && isJpeg(r.body)) {
          rt.snapshotAt = this.now();
          if (r.body.length <= max) return { data: r.body, at: this.now() };
        } else if (r.status !== 200 && !wait) return null;
      } catch (e) {
        if (!wait) return null;
        if (codeOf(e) === 'auth_failed') throw new CamError('auth_failed', 'the camera refused the user or password');
        if (codeOf(e) === 'tls_untrusted') throw new CamError('tls_untrusted', 'the certificate of the camera is not trusted');
      }
    }
    if (!wait) return null;
    if (this.service() !== 'managed' || rt.state !== 'ok') throw new CamError('not_ready', 'no picture available', 409);
    rt.snapUntil = this.now() + DEMAND_MS;
    this._writeRun(rt);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      const x = fresh();
      if (x) return x;
    }
    throw new CamError('not_ready', 'no picture yet', 409);
  }

  /** Live-Wunsch (60 s, jeder Abruf verlängert) → { ready, codec, audio } */
  live(id) {
    if (!this.cfg.enabled) throw new CamError('feature_disabled', 'cameras are off', 503);
    const rt = this._rt(id);
    if (this.service() !== 'managed') throw new CamError('service_missing', 'the kameras service is not running', 409);
    rt.liveUntil = this.now() + DEMAND_MS;
    if (rt.state === 'ok') this._writeRun(rt);
    const ring = this.ring(id);
    const pl = ring.playlist();
    const init = ring.read('init.mp4', 1024 * 1024);
    let codec = null;
    try { codec = init ? fmp4.codecsString(fmp4.initInfo(init)) : null; } catch { codec = null; }
    return { ready: !!(pl && pl.segments.length >= 2 && init), codec, audio: !!rt.cam.audio };
  }

  /** Eine Datei des Rings (index.m3u8 | init.mp4 | s<n>.m4s) → Buffer; verlängert den Live-Wunsch. */
  liveFile(id, name) {
    const rt = this._rt(id);
    rt.liveUntil = this.now() + DEMAND_MS;
    if (rt.state === 'ok' && this.service() === 'managed') this._writeRun(rt);
    const b = this.ring(id).read(name);
    if (!b) throw new CamError('not_ready', 'not ready yet', 409);
    return b;
  }

  // ─── Suche, Test ──────────────────────────────────────────────────────
  async discover() {
    if (!this.cfg.enabled) throw new CamError('feature_disabled', 'cameras are off', 503);
    const found = await this.discoverFn({ subnets: this.getSubnets(), allowed: (ip) => this.allowed(ip) });
    this.discovered = found.slice(0, 64);
    this.discoveredAt = this.now();
    return this.discovered;
  }

  /** Mgmt /api/cameras/probe → das Ergebnis (ohne Zugang); wirft CamError. */
  async probe(b) {
    if (!this.cfg.enabled) throw new CamError('feature_disabled', 'cameras are off', 503);
    const q = b && typeof b === 'object' ? b : {};
    const user = typeof q.user === 'string' ? q.user.slice(0, 64) : '';
    const password = typeof q.password === 'string' ? q.password.slice(0, 128) : '';
    if (/[\r\n\0]/.test(user + password)) throw new CamError('invalid_request', 'invalid user or password', 400);
    if (q.rtspUrl != null) {
      const u = parseRtspUrl(q.rtspUrl);
      if (!u) throw new CamError('invalid_request', 'invalid RTSP address', 400);
      if (!this.allowed(u.host)) throw new CamError('not_allowed', 'the address is not in the home network of this gateway', 403);
      const cu = user || u.user || '';
      const cp = password || u.password || '';
      let d;
      try { d = await rtsp.describe({ host: u.host, port: u.port, path: u.path, user: cu, password: cp }); } catch (e) { throw this._probeError(e); }
      const snap = await this._probeGrab({ host: u.host, port: u.port, path: u.path, user: cu, password: cp, codec: d.codec });
      return { ok: true, source: 'rtsp', host: u.host, info: { manufacturer: null, model: null, firmware: null }, profiles: [], rtsp: { port: u.port, path: u.path }, events: { supported: false, kinds: [] }, codec: d.codec, width: null, height: null, audio: d.audio, snapshot: snap };
    }
    const host = typeof q.host === 'string' ? q.host.trim() : '';
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new CamError('invalid_request', 'invalid address', 400);
    if (!this.allowed(host)) throw new CamError('not_allowed', 'the address is not in the home network of this gateway', 403);
    const devPath = typeof q.onvifPath === 'string' && /^\/[A-Za-z0-9._~/-]{0,127}$/.test(q.onvifPath) ? q.onvifPath : onvif.DEVICE_PATH;
    // HTTPS: onvifTls (der Admin wählte es) – sonst erst die üblichen http-Ports, zuletzt 443 mit TLS
    const insecure = q.tlsInsecure === true;
    const given = Number.isInteger(q.onvifPort) && q.onvifPort > 0 && q.onvifPort < 65536 ? q.onvifPort : null;
    const tries = given
      ? [{ port: given, tls: q.onvifTls === true }]
      : (q.onvifTls === true ? ONVIF_TLS_PORTS.map((p) => ({ port: p, tls: true }))
        : [...ONVIF_PORTS.map((p) => ({ port: p, tls: false })), ...ONVIF_TLS_PORTS.map((p) => ({ port: p, tls: true }))]);
    let lastErr = null;
    for (const { port, tls } of tries) {
      try {
        const info = await this.onvifInfo({ host, port, path: devPath, tls, insecure, user, password, kinds: true, allProfiles: true, profile: typeof q.profile === 'string' ? q.profile : null });
        let snapshot = null;
        if (info.snapshot) {
          try {
            const r = await camHttp.request({ host, port: info.snapshot.port, path: info.snapshot.path, tls: info.snapshot.tls === true, insecure, user, password, maxBytes: SNAP_MAX, timeoutMs: 8000 });
            if (r.status === 200 && isJpeg(r.body) && r.body.length <= 1024 * 1024) snapshot = { data: r.body.toString('base64'), mime: 'image/jpeg' };
          } catch { snapshot = null; }
        }
        if (!snapshot) snapshot = await this._probeGrab({ host, port: info.rtsp.port, path: info.rtsp.path, user, password, codec: info.codec });
        const audio = await this._audioOf({ host }, info.rtsp, { user, password });
        return {
          ok: true, source: 'onvif', host, onvif: tls ? { port, path: devPath, tls: true } : { port, path: devPath }, tlsInsecure: tls && insecure,
          info: info.device, profile: info.profile,
          profiles: info.profiles.map((p) => ({ token: p.token, name: p.name, codec: p.codec, width: p.width, height: p.height, rtsp: p.rtsp, snapshot: p.snapshot })),
          rtsp: info.rtsp, events: { supported: !!info.events, kinds: info.kinds }, codec: info.codec, width: info.width || null, height: info.height || null, audio, snapshot,
        };
      } catch (e) {
        lastErr = e;
        const c = codeOf(e);
        // falsches Passwort / nicht geprüftes Zertifikat: das ist die Kamera – kein weiterer Port
        if (c === 'auth_failed' || c === 'tls_untrusted' || tries.length === 1) break;
      }
    }
    throw this._probeError(lastErr);
  }

  _probeError(e) {
    const c = codeOf(e);
    if (c === 'auth_failed') return new CamError('auth_failed', 'the camera refused the user or password', 401);
    if (c === 'no_stream') return new CamError('no_stream', 'the camera offers no usable video stream', 502);
    if (c === 'not_onvif') return new CamError('not_onvif', 'the camera does not answer ONVIF', 502);
    if (c === 'tls_untrusted') return new CamError('tls_untrusted', 'the certificate of the camera is not trusted (self-signed?) – choose "do not check the certificate" if you trust it', 502);
    return new CamError('unreachable', 'the camera does not answer', 502);
  }

  /** Testbild über einen kurzen ffmpeg-Lauf (nur mit dem Dienst kameras) → { data, mime } | null */
  async _probeGrab({ host, port, path: p, user, password, codec }) {
    if (this.service() !== 'managed') return null;
    const id = rid('c');
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password || '')}@` : '';
    try {
      fs.mkdirSync(path.join(this.ctlDir, 'run'), { recursive: true, mode: 0o700 });
      writeAtomic(this._runFile(id), `URL=rtsp://${auth}${host}:${port}${p}\nAUDIO=0\nVTAG=${codec === 'h265' ? 'hvc1' : ''}\n`, 0o600);
      const ring = this.ring(id);
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500));
        const b = ring.read('snap.jpg', 1024 * 1024);
        if (isJpeg(b)) return { data: b.toString('base64'), mime: 'image/jpeg' };
      }
      return null;
    } finally { this._removeRun(id); }
  }

  // ─── Zustand ──────────────────────────────────────────────────────────
  cameraView(rt) {
    return {
      id: rt.cam.id,
      state: rt.state,
      problem: rt.problem,
      events: this.wantEvents(rt) ? rt.events : (rt.info && !rt.info.events ? 'unsupported' : 'off'),
      kinds: rt.kinds,
      codec: rt.codec || null,
      width: rt.width || null,
      height: rt.height || null,
      // Tonspur im Stream (aus dem SDP): true/false, null = unbekannt
      audio: typeof rt.audio === 'boolean' ? rt.audio : null,
      stream: this.service() === 'missing' ? 'service_missing' : this.ringState(rt.cam.id),
      recording: mayRecord(rt.cam, this.cfg.nobodyHome),
      snapshotAt: iso(rt.snapshotAt),
      lastEventAt: iso(rt.lastEventAt),
      info: rt.info && rt.info.device ? rt.info.device : null,
    };
  }

  async report() {
    if (!this.reporter) return;
    this.lastReport = this.now();
    this.reportDirty = false;
    const body = { at: new Date(this.now()).toISOString(), service: this.service(), storage: { ...this.storage }, cameras: [...this.cams.values()].map((rt) => this.cameraView(rt)) };
    const r = await this.reporter.post('/api/v1/gateway/cameras/report', body);
    if (!r.ok) this.reportDirty = true;
  }

  state() {
    if (!this.cfg.enabled) return 'off';
    if (this.service() === 'missing') return 'service_missing';
    if (this.lastError && this.now() - this.lastError.at < 10 * 60_000) return 'error';
    return 'running';
  }

  /** features.cameras der Telemetrie (klein). */
  featureTelemetry() {
    const rts = [...this.cams.values()];
    const hp = this.hostProfile;
    const memTotal = hp && Number.isSafeInteger(hp.mem_total) && hp.mem_total > 0 ? hp.mem_total : os.totalmem();
    return {
      enabled: this.cfg.enabled,
      service: this.service(),
      state: this.state(),
      cameras: rts.length,
      recording: rts.filter((rt) => mayRecord(rt.cam, this.cfg.nobodyHome)).length,
      live: rts.filter((rt) => rt.liveUntil > this.now()).length,
      storage: { free: this.storage.free, total: this.storage.total, problem: this.storage.problem, mount: this.storage.mount },
      host: { cores: os.cpus().length, memTotal, arch: process.arch },
      error: this.lastError ? { code: this.lastError.code, at: this.lastError.at } : null,
    };
  }

  /** Frischer Zustand (Mgmt /api/cameras/status). */
  async status() {
    this._disk();
    return {
      ...this.featureTelemetry(),
      storage: { ...this.storage },
      list: [...this.cams.values()].map((rt) => this.cameraView(rt)),
      discovered: this.discovered,
      discoveredAt: iso(this.discoveredAt),
      kinds: KINDS,
    };
  }
}

module.exports = { CameraService, CamError, parseRtspUrl, codeOf, dayOf, mountOf, PRE_MS, POST_MS, MAX_CLIP_MS };
