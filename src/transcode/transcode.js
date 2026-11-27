'use strict';

// „Videos umwandeln“ (docs/transcode.md): Videos, die nicht überall laufen
// (z. B. H.264 mit 10 Bit), wandelt der eigene Dienst „umwandeln“ auf dem
// Gateway-Host per Grafik-Hardware (VAAPI) in H.264 High 8 Bit um – Ton,
// Untertitel, Kapitel und Anhänge bleiben. Capability `transcode`, Schalter
// `features.transcode`.
//
// Das Gateway entscheidet und meldet, der Wächter im Dienst führt aus (wie bei
// den Kameras und Office): Der Dienst hat kein Netz und keinen Port; Aufträge
// gehen als kleine Dateien ins gemeinsame tmpfs-Volume umw-ctl (/gc-umw):
//   umwandeln.sh, run, conf, pause, jobs/<id>.job   – schreibt das Gateway
//   state/…                                         – schreibt der Wächter
// Das Gateway sieht die Medien nicht; es prüft die Schreibweise der Pfade
// (config.js), der Wächter prüft im Dienst gegen seine eingehängten Wurzeln.
// Alles, was aus state/ kommt, ist Eingabe eines Containers, der fremde
// Videodateien verarbeitet: feste Formate, Größengrenzen, keine Links.
//
// Die Warteschlange liegt in /state/transcode.json und übersteht Neustart und
// Update; ein unterbrochener Auftrag beginnt neu (die Zwischendatei räumt der
// Wächter weg, am Zielort liegt nie eine halbe Datei).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../logger');
const { loop } = require('../features/status');
const { readJson, writeJson } = require('../features/persist');
const { normalizeTranscode, checkPath, ID_RE } = require('./config');

const SCRIPT = path.join(__dirname, 'umwandeln.sh');
const STATE_FILE = 'transcode.json';
const ALIVE_S = 60;
const TICK_MS = 1_000;
const REPORT_PROGRESS_MS = 10_000;
const REPORT_RETRY_MS = 60_000;
const REPORT_GONE_MS = 10 * 60_000;
const QUICK_TIMEOUT_MS = 30_000;
const MAX_QUEUE = 32;
const MAX_KEPT = 200;
const KEEP_MS = 7 * 24 * 3_600_000;
const MAX_QUICK = 4;
const PAUSE_DEFAULT_S = 900;
const PAUSE_MAX_S = 86_400;
const MAX_TRASH = 2000;

const ACTIVE = new Set(['queued', 'running', 'paused', 'verifying']);
const STATE_RE = /^(queued|running|paused|verifying|done|failed) ([0-9]{1,12}) ([a-z_]{1,32}|-) ([0-9]{1,3}) ([0-9]{1,6}(?:\.[0-9]{1,3})?) ([0-9]{1,6}(?:\.[0-9]{1,3})?)\s*$/;
const ALIVE_RE = /^alive ([0-9]{1,12})\s*$/;
const CODE_RE = /^[a-z_]{1,32}$/;
const ENCODERS = new Set(['vaapi_icq', 'vaapi_qvbr']);
const MODES = new Set(['vaapi_icq', 'vaapi_qvbr', 'software']);
const PROBE_NUM = { bits: 'bits', width: 'width', height: 'height', level: 'level', fps: 'fps', video: 'video', audio: 'audio',
  subtitles: 'subtitles', attachments: 'attachments', pictures: 'pictures', other: 'other', chapters: 'chapters', duration: 'duration', size: 'size' };
const PROBE_TEXT = { codec: 'codec', profile: 'profile', pix_fmt: 'pixFmt', field_order: 'fieldOrder', container: 'container' };

class TranscodeError extends Error {
  constructor(code, status = 400, message) { super(message || code); this.code = code; this.status = status; }
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanLine(s, n) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 ? ' ' : ch;
  }
  return out.slice(0, n);
}

/** Schlüssel=Wert je Zeile → Map (erste Nennung gilt), `log` gesammelt. */
function parseKv(text) {
  const kv = new Map();
  const log = [];
  if (typeof text !== 'string') return { kv, log };
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i);
    if (!/^[a-z0-9_]{1,32}$/.test(k)) continue;
    const v = line.slice(i + 1);
    if (k === 'log') { if (log.length < 20) log.push(cleanLine(v, 300)); continue; }
    if (!kv.has(k)) kv.set(k, v);
  }
  return { kv, log };
}

const numOf = (v) => (typeof v === 'string' && /^[0-9]{1,15}(\.[0-9]{1,6})?$/.test(v) ? Number(v) : null);

/** Befund einer Datei (ffprobe) aus den Zeilen mit dem Präfix `src_` oder `new_`. */
function probeView(kv, prefix) {
  if (!kv.has(`${prefix}codec`)) return null;
  const out = {};
  for (const [k, name] of Object.entries(PROBE_TEXT)) out[name] = cleanLine(kv.get(prefix + k) || '', 64).trim();
  for (const [k, name] of Object.entries(PROBE_NUM)) out[name] = numOf(kv.get(prefix + k));
  return out;
}

/** Befund eines Auftrags (state/<id>.res) für Server und Plugin. */
function parseResult(text) {
  const { kv, log } = parseKv(text);
  const mode = kv.get('mode');
  const out = {
    source: probeView(kv, 'src_'),
    output: probeView(kv, 'new_'),
    mode: MODES.has(mode) ? mode : null,
    seconds: numOf(kv.get('seconds')),
    trashPath: kv.has('trash') ? cleanLine(kv.get('trash'), 4096) : null,
    restored: kv.has('restored') ? cleanLine(kv.get('restored'), 4096) : null,
    resumed: kv.get('resumed') === '1',
    freeKb: numOf(kv.get('free_kb')),
    needKb: numOf(kv.get('need_kb')),
    log,
  };
  return out;
}

/** state/caps des Wächters → Fähigkeiten. */
function parseCaps(text) {
  const { kv } = parseKv(text);
  if (kv.get('v') !== '1') return null;
  const dev = kv.get('device');
  const groups = (kv.get('groups') || '').split(' ').map(numOf).filter((n) => Number.isInteger(n)).slice(0, 32);
  return {
    at: iso((numOf(kv.get('at')) || 0) * 1000),
    ffmpeg: cleanLine(kv.get('ffmpeg') || '', 40).trim() || null,
    uid: numOf(kv.get('uid')),
    groups,
    device: dev === 'ok' || dev === 'denied' ? dev : 'absent',
    devicePath: cleanLine(kv.get('device_path') || '', 128).trim() || null,
    deviceGid: numOf(kv.get('device_gid')),
    deviceMode: /^[0-7]{3,4}$/.test(kv.get('device_mode') || '') ? kv.get('device_mode') : null,
    driver: cleanLine(kv.get('driver') || '', 80).trim() || null,
    vaH264Enc: kv.get('va_h264_enc') === '1',
    encoders: (kv.get('enc') || '').split(',').filter((e) => ENCODERS.has(e)),
    software: kv.get('software') === '1',
  };
}

/** state/roots: <ok|missing|readonly> TAB <frei kB> TAB <gesamt kB> TAB <Pfad> */
function parseRoots(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length !== 4 || !/^(ok|missing|readonly)$/.test(f[0]) || !f[3].startsWith('/')) continue;
    const free = numOf(f[1]); const total = numOf(f[2]);
    out.push({ path: cleanLine(f[3], 4096), state: f[0], free: free === null ? null : free * 1024, total: total === null ? null : total * 1024 });
    if (out.length >= 16) break;
  }
  return out;
}

/** state/trash: <id> TAB <pending|done> TAB <at> TAB <Größe> TAB <läuft ab> TAB <Pfad des Originals> */
function parseTrash(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length !== 6 || !ID_RE.test(f[0]) || f[1] !== 'done') continue;
    const at = numOf(f[2]); const size = numOf(f[3]); const exp = numOf(f[4]);
    if (at === null || size === null || exp === null || !f[5].startsWith('/')) continue;
    out.push({ id: f[0], at: iso(at * 1000), size, expiresAt: iso(exp * 1000), path: cleanLine(f[5], 4096) });
    if (out.length >= MAX_TRASH) break;
  }
  return out;
}

class TranscodeService {
  constructor({ reporter = null, stateDir = null, ctlDir = '/gc-umw', now = Date.now, pollMs = 250, quickTimeoutMs = QUICK_TIMEOUT_MS, tickMs = TICK_MS, reserveMb = null } = {}) {
    // reserveMb: nur für Tests (der Wächter hält sonst 2 GB über der geschätzten Größe frei)
    Object.assign(this, { reporter, stateDir, ctlDir, now, pollMs, quickTimeoutMs, tickMs, reserveMb });
    this.cfg = normalizeTranscode(undefined);
    this.jobs = new Map();     // id → Auftrag (Reihenfolge = Eingang)
    this.pauseUntil = 0;       // „alles anhalten“ bis (ms), 0 = nicht
    this.loaded = false;
    this.started = false;
    this.quick = 0;
    this.dirty = false;        // Warteschlange geändert → speichern
    this.reportDirty = false;  // Zustand geändert → melden
    this.progressDirty = false; // nur der Fortschritt → höchstens alle 10 s melden
    this.lastReport = 0;
    this.reportHold = 0;
    this.lastTrashSent = null;
    this.lastError = null;
    this.tickLoop = loop(() => this.tick(), () => this.tickMs);
  }

  // ─── Einstellung ──────────────────────────────────────────────────────
  async apply(raw) {
    const before = JSON.stringify(this.cfg);
    this.cfg = normalizeTranscode(raw);
    const changed = before !== JSON.stringify(this.cfg);
    if (!this.loaded) this._load();
    this._install();
    if (changed) {
      this.reportDirty = true;
      logger.info({ enabled: this.cfg.enabled, roots: this.cfg.roots.length, software: this.cfg.software, trashDays: this.cfg.trashDays }, 'transcode: settings applied');
    }
    if (this.cfg.enabled && !this.started) { this.started = true; this.tickLoop.start(500); }
    if (!this.cfg.enabled && this.started) {
      this.tickLoop.stop(); this.started = false;
      // der Wächter bricht den laufenden Auftrag ab (run ist weg); er wartet hier bis zum Wiedereinschalten
      for (const j of this.jobs.values()) if (ACTIVE.has(j.state)) Object.assign(j, { state: 'queued', handed: false, percent: 0, fps: 0, speed: 0 });
      this._save();
    }
  }

  stop() { this.tickLoop.stop(); this.started = false; }

  _load() {
    this.loaded = true;
    if (!this.stateDir) return;
    const s = readJson(this.stateDir, STATE_FILE);
    if (!s || !Array.isArray(s.jobs)) return;
    for (const j of s.jobs.slice(0, MAX_QUEUE + MAX_KEPT)) {
      if (!j || !ID_RE.test(j.id) || typeof j.path !== 'string' || typeof j.state !== 'string') continue;
      this.jobs.set(j.id, {
        id: j.id, path: j.path, software: j.software === true, quality: Number.isInteger(j.quality) ? j.quality : null,
        state: ACTIVE.has(j.state) || ['done', 'failed', 'cancelled'].includes(j.state) ? j.state : 'failed',
        code: typeof j.code === 'string' && CODE_RE.test(j.code) ? j.code : null,
        percent: 0, fps: 0, speed: 0, paused: j.paused === true, handed: j.handed === true,
        submittedAt: Number(j.submittedAt) || this.now(), startedAt: Number(j.startedAt) || null, finishedAt: Number(j.finishedAt) || null,
        result: j.result && typeof j.result === 'object' ? j.result : null,
      });
    }
    this.pauseUntil = Number(s.pauseUntil) || 0;
  }

  _save() {
    this.dirty = false;
    if (!this.stateDir) return;
    writeJson(this.stateDir, STATE_FILE, { v: 1, pauseUntil: this.pauseUntil, jobs: [...this.jobs.values()] });
  }

  // ─── Volume umw-ctl ───────────────────────────────────────────────────
  _ctlUsable() {
    try { fs.accessSync(this.ctlDir, fs.constants.W_OK); return fs.lstatSync(this.ctlDir).isDirectory(); } catch { return false; }
  }

  _file(...parts) { return path.join(this.ctlDir, ...parts); }

  /**
   * Eine eigene Datei im Volume schreiben: neu angelegt (nie durch einen Link hindurch), dann umbenannt.
   * 0644/0755 mit Absicht: Den Zugang regelt allein der Volume-Ordner (root:61002, 2750) – nur das Gateway
   * und die Zusatzgruppe des Dienstes kommen hinein. So hängt nichts an umask oder am setgid-Bit, das ein
   * chmod ohne CAP_FSETID (cap_drop: ALL) entfernt.
   */
  _write(rel, data) {
    const file = this._file(rel);
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, data, { mode: 0o644, flag: 'wx' });
    fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, file);
  }

  _remove(rel) { try { fs.rmSync(this._file(rel), { force: true }); } catch { /* best effort */ } }

  /** Ein echter Ordner (kein Link) – legt ihn an, wenn er fehlt. */
  _dir(rel, mode) {
    const d = this._file(rel);
    try { fs.mkdirSync(d, { mode }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const st = fs.lstatSync(d);
    if (!st.isDirectory()) throw new Error(`${rel} is not a directory`);
    if ((st.mode & 0o777) !== mode) fs.chmodSync(d, mode);
  }

  /** Eine Datei des Wächters lesen: gewöhnliche Datei, kein Link, begrenzte Größe. */
  _read(rel, max = 4096) {
    let fd = null;
    try {
      if (!fs.lstatSync(this._file('state')).isDirectory()) return null;
      fd = fs.openSync(this._file('state', rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > max) return null;
      return fs.readFileSync(fd, 'utf8');
    } catch { return null; } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* zu */ }
    }
  }

  /** Skript, Ordner, run/conf/pause nach dem Stand der Einstellung. */
  _install() {
    if (!this._ctlUsable()) return false;
    try {
      this._dir('jobs', 0o755);
      this._dir('state', 0o770);   // hier schreibt der Wächter (Gruppe des Volumes, vom Volume-Ordner geerbt)
      if (this.cfg.enabled) {
        const src = fs.readFileSync(SCRIPT);
        let cur = null;
        try { cur = fs.readFileSync(this._file('umwandeln.sh')); } catch { cur = null; }
        if (!cur || !cur.equals(src)) this._write('umwandeln.sh', src);
        const conf = `TRASH_DAYS=${this.cfg.trashDays}\nMIN_FREE_GB=${this.cfg.minFreeGb}\nMIN_FREE_PCT=${this.cfg.minFreePct}\nVERIFY_DECODE=${this.cfg.verifyDecode ? 1 : 0}\n${Number.isInteger(this.reserveMb) ? `RESERVE_MB=${this.reserveMb}\n` : ''}`;
        let old = null;
        try { old = fs.readFileSync(this._file('conf'), 'utf8'); } catch { old = null; }
        if (old !== conf) this._write('conf', conf);
        if (!fs.existsSync(this._file('run'))) this._write('run', 'on\n');
        const pausedAll = this.pauseUntil > this.now();
        if (pausedAll && !fs.existsSync(this._file('pause'))) this._write('pause', `${Math.floor(this.pauseUntil / 1000)}\n`);
        if (!pausedAll) this._remove('pause');
      } else this._remove('run');
      return true;
    } catch (e) {
      logger.warn({ err: e.message }, 'transcode: control files not written');
      return false;
    }
  }

  /** managed (Wächter lebt) | absent (Volume da, Dienst fehlt) | missing (keine Compose-Unterstützung) */
  service() {
    if (!this._ctlUsable()) return 'missing';
    const m = ALIVE_RE.exec(this._read('umwandeln.state', 64) || '');
    if (!m) return 'absent';
    return Math.abs(this.now() / 1000 - Number(m[1])) <= ALIVE_S ? 'managed' : 'absent';
  }

  caps() { return parseCaps(this._read('caps', 2048)); }

  /** Die Wurzeln der Einstellung mit dem, was der Dienst dazu meldet (not_mounted: dort nicht eingehängt). */
  roots() {
    const seen = parseRoots(this._read('roots', 64 * 1024));
    return this.cfg.roots.map((p) => seen.find((r) => r.path === p) || { path: p, state: 'not_mounted', free: null, total: null });
  }

  trash() { return parseTrash(this._read('trash', 1024 * 1024)); }

  // ─── Aufträge ─────────────────────────────────────────────────────────
  _require() {
    if (!this.cfg.enabled) throw new TranscodeError('feature_disabled', 503);
    const svc = this.service();
    if (svc !== 'managed') throw new TranscodeError(svc === 'missing' ? 'service_missing' : 'service_absent', 409);
  }

  _job(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TranscodeError('invalid_request', 400);
    const j = this.jobs.get(id);
    if (!j) throw new TranscodeError('not_found', 404);
    return j;
  }

  /** Auftrag annehmen: { id, path, software?, quality? } → Sicht des Auftrags. */
  submit(body) {
    const b = body && typeof body === 'object' ? body : {};
    this._require();
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) throw new TranscodeError('invalid_request', 400);
    if (b.quality !== undefined && !(Number.isInteger(b.quality) && b.quality >= 16 && b.quality <= 32)) throw new TranscodeError('invalid_request', 400);
    const chk = checkPath(b.path, this.cfg.roots, 'convert');
    if (!chk.ok) throw new TranscodeError(chk.error, 400);
    const known = this.jobs.get(b.id);
    if (known) {
      // derselbe Auftrag noch einmal (Wiederholung nach einem Zeitlimit) ist kein Fehler
      if (known.path === chk.path) return this.view(known);
      throw new TranscodeError('duplicate_id', 409);
    }
    const active = [...this.jobs.values()].filter((j) => ACTIVE.has(j.state));
    if (active.some((j) => j.path === chk.path)) throw new TranscodeError('already_queued', 409);
    if (active.length >= MAX_QUEUE) throw new TranscodeError('queue_full', 429);
    const job = {
      id: b.id, path: chk.path, software: this.cfg.software && b.software !== false, quality: b.quality === undefined ? null : b.quality,
      state: 'queued', code: null, percent: 0, fps: 0, speed: 0, paused: false, handed: false,
      submittedAt: this.now(), startedAt: null, finishedAt: null, result: null,
    };
    this.jobs.set(job.id, job);
    this._changed();
    this._kick();
    return this.view(job);
  }

  cancel(id) {
    const j = this._job(id);
    if (!ACTIVE.has(j.state)) return this.view(j);
    if (j.handed) {
      // schon getauscht? Dann ist er fertig, nicht abgebrochen.
      this._sync(j);
      if (!ACTIVE.has(j.state)) return this.view(j);
      this._remove(path.join('jobs', `${j.id}.job`));
      this._remove(path.join('jobs', `${j.id}.pause`));
    }
    Object.assign(j, { state: 'cancelled', code: null, handed: false, finishedAt: this.now() });
    this._changed();
    this._kick();
    return this.view(j);
  }

  /** Anhalten: ein Auftrag (bis „fortsetzen“) oder – ohne id – alles für ttlSec („jemand schaut“, vom Server erneuert). */
  pause({ id, ttlSec } = {}) {
    if (!this.cfg.enabled) throw new TranscodeError('feature_disabled', 503);
    if (id === undefined || id === null) {
      if (ttlSec !== undefined && !(Number.isInteger(ttlSec) && ttlSec >= 10 && ttlSec <= PAUSE_MAX_S)) throw new TranscodeError('invalid_request', 400);
      this.pauseUntil = this.now() + (ttlSec === undefined ? PAUSE_DEFAULT_S : ttlSec) * 1000;
      this._install();
    } else {
      const j = this._job(id);
      if (!ACTIVE.has(j.state)) throw new TranscodeError('not_active', 409);
      j.paused = true;
      if (j.handed) try { this._write(path.join('jobs', `${j.id}.pause`), 'on\n'); } catch (e) { logger.warn({ err: e.message }, 'transcode: pause file not written'); }
    }
    this._changed();
    return this.pauseView();
  }

  resume({ id } = {}) {
    if (!this.cfg.enabled) throw new TranscodeError('feature_disabled', 503);
    if (id === undefined || id === null) { this.pauseUntil = 0; this._install(); }
    else {
      const j = this._job(id);
      j.paused = false;
      this._remove(path.join('jobs', `${j.id}.pause`));
    }
    this._changed();
    this._kick();
    return this.pauseView();
  }

  /** Erledigte Aufträge vergessen (der Server hat das Ergebnis). */
  ack(ids) {
    if (!Array.isArray(ids) || ids.length > 500) throw new TranscodeError('invalid_request', 400);
    let n = 0;
    for (const id of ids) {
      const j = typeof id === 'string' ? this.jobs.get(id) : null;
      if (j && !ACTIVE.has(j.state)) { this.jobs.delete(j.id); n++; }
    }
    if (n) { this.dirty = true; this._save(); }
    return n;
  }

  /** Ein kurzer Auftrag an den Wächter (probe, restore, purge): schreiben, auf die Antwort warten. */
  async _quick(lines) {
    this._require();
    if (this.quick >= MAX_QUICK) throw new TranscodeError('busy', 429);
    this.quick++;
    const id = 'q' + crypto.randomBytes(8).toString('hex').slice(0, 15);
    const job = path.join('jobs', `${id}.job`);
    try {
      this._write(job, lines.join('\n') + '\n');
      const until = this.now() + this.quickTimeoutMs;
      while (this.now() < until) {
        const m = STATE_RE.exec(this._read(id, 128) || '');
        if (m && m[1] === 'done') return parseResult(this._read(`${id}.res`, 64 * 1024) || '');
        if (m && m[1] === 'failed') throw new TranscodeError(m[3] === '-' ? 'failed' : m[3], 422);
        await sleep(this.pollMs);
      }
      throw new TranscodeError('timeout', 504);
    } catch (e) {
      if (e instanceof TranscodeError) throw e;
      throw new TranscodeError('service_missing', 409, e.message);
    } finally {
      this._remove(job);
      this.quick--;
    }
  }

  /** ffprobe-Befund einer Datei: { path, source: {…}, freeKb } */
  async probe(p) {
    if (!this.cfg.enabled) throw new TranscodeError('feature_disabled', 503);
    const chk = checkPath(p, this.cfg.roots, 'probe');
    if (!chk.ok) throw new TranscodeError(chk.error, 400);
    const r = await this._quick(['KIND=probe', `SRC=${chk.path}`]);
    return { path: chk.path, source: r.source, freeKb: r.freeKb };
  }

  /** Original eines umgewandelten Videos zurück an seinen Ort (die neue Datei wird ersetzt). */
  async restore(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new TranscodeError('invalid_request', 400);
    const r = await this._quick(['KIND=restore', `REF=${id}`]);
    this.reportDirty = true;
    return { id, restored: r.restored };
  }

  /** Originale endgültig löschen: eines ({ id }) oder alle ({ all: true }). */
  async purge({ id, all } = {}) {
    if (all === true) await this._quick(['KIND=purge', 'ALL=1']);
    else {
      if (typeof id !== 'string' || !ID_RE.test(id)) throw new TranscodeError('invalid_request', 400);
      await this._quick(['KIND=purge', `REF=${id}`]);
    }
    this.reportDirty = true;
    return { purged: true };
  }

  // ─── Ablauf ───────────────────────────────────────────────────────────
  _changed() { this.dirty = true; this.reportDirty = true; this._save(); }

  _kick() { if (this.started) { this.tickLoop.stop(); this.tickLoop.start(0); } }

  /** Zustand eines übergebenen Auftrags vom Wächter übernehmen. */
  _sync(j) {
    const m = STATE_RE.exec(this._read(j.id, 128) || '');
    if (!m) return;
    const [, st, , code, pct, fps, speed] = m;
    const before = `${j.state}/${j.percent}`;
    if (st === 'done' || st === 'failed') {
      const res = parseResult(this._read(`${j.id}.res`, 64 * 1024) || '');
      Object.assign(j, { state: st, code: st === 'failed' && code !== '-' ? code : null, percent: st === 'done' ? 100 : j.percent, fps: 0, speed: 0,
        handed: false, finishedAt: this.now(), result: res });
      this._remove(path.join('jobs', `${j.id}.job`));
      this._remove(path.join('jobs', `${j.id}.pause`));
      if (st === 'failed') {
        this.lastError = { code: j.code || 'failed', at: this.now() };
        logger.warn({ id: j.id, code: j.code }, 'transcode: job failed');
      } else logger.info({ id: j.id, mode: res.mode, seconds: res.seconds }, 'transcode: job done');
      this._changed();
      return;
    }
    Object.assign(j, { state: st, percent: Math.min(99, Number(pct)), fps: Number(fps), speed: Number(speed) });
    if (st === 'running' && !j.startedAt) { j.startedAt = this.now(); this.dirty = true; }
    if (before !== `${j.state}/${j.percent}`) {
      if (before.split('/')[0] !== j.state) this.reportDirty = true; else this.progressDirty = true;
    }
  }

  async tick() {
    if (!this.cfg.enabled) return;
    if (this.pauseUntil && this.pauseUntil <= this.now()) { this.pauseUntil = 0; this._changed(); }
    const usable = this._install();
    const svc = usable ? this.service() : 'missing';
    if (svc === 'managed') {
      const jobs = [...this.jobs.values()];
      let cur = jobs.find((j) => j.handed && ACTIVE.has(j.state)) || null;
      if (cur) {
        // nach einem Neustart des Hosts ist das tmpfs leer: Auftrag neu hinlegen
        if (!fs.existsSync(this._file('jobs', `${cur.id}.job`))) this._hand(cur);
        this._sync(cur);
        if (!ACTIVE.has(cur.state)) cur = null;
      }
      if (!cur) {
        const next = jobs.find((j) => j.state === 'queued' && !j.handed && !j.paused) || jobs.find((j) => ['queued', 'paused'].includes(j.state) && !j.handed);
        if (next) this._hand(next);
      }
      // abgebrochen, aber der Tausch war schon geschehen → der Auftrag ist fertig
      const inTrash = new Set(this.trash().map((t) => t.id));
      for (const j of jobs) {
        if (j.state === 'cancelled' && inTrash.has(j.id)) { Object.assign(j, { state: 'done', percent: 100, result: { ...(j.result || {}), resumed: true } }); this._changed(); }
      }
    }
    this._expire();
    if (this.dirty) this._save();
    await this._maybeReport();
  }

  _hand(j) {
    const chk = checkPath(j.path, this.cfg.roots, 'convert');
    if (!chk.ok) {
      Object.assign(j, { state: 'failed', code: chk.error, handed: false, finishedAt: this.now() });
      this._changed();
      return;
    }
    try {
      if (j.paused) this._write(path.join('jobs', `${j.id}.pause`), 'on\n');
      const lines = ['KIND=convert', `SRC=${j.path}`, `SOFTWARE=${j.software && this.cfg.software ? 1 : 0}`, `QUALITY=${j.quality || this.cfg.quality}`];
      this._write(path.join('jobs', `${j.id}.job`), lines.join('\n') + '\n');
      if (!j.handed) { j.handed = true; this._changed(); }
    } catch (e) { logger.warn({ err: e.message }, 'transcode: job file not written'); }
  }

  /** Erledigte Aufträge nach 7 Tagen und über 200 Stück vergessen. */
  _expire() {
    const done = [...this.jobs.values()].filter((j) => !ACTIVE.has(j.state));
    let drop = done.filter((j) => this.now() - (j.finishedAt || 0) > KEEP_MS);
    const rest = done.filter((j) => !drop.includes(j));
    if (rest.length > MAX_KEPT) drop = drop.concat(rest.slice(0, rest.length - MAX_KEPT));
    for (const j of drop) { this.jobs.delete(j.id); this.dirty = true; }
  }

  // ─── Sichten und Berichte ─────────────────────────────────────────────
  view(j) {
    return {
      id: j.id, path: j.path, state: j.state, error: j.code, percent: j.percent, fps: j.fps, speed: j.speed, paused: j.paused, software: j.software,
      submittedAt: iso(j.submittedAt), startedAt: iso(j.startedAt), finishedAt: iso(j.finishedAt), result: j.result,
    };
  }

  pauseView() {
    const all = this.pauseUntil > this.now();
    return { all, until: all ? iso(this.pauseUntil) : null };
  }

  /** off | service_missing | no_roots | no_device | device_denied | no_encoder | paused | running | ready */
  state() {
    if (!this.cfg.enabled) return 'off';
    if (this.service() !== 'managed') return 'service_missing';
    if (!this.cfg.roots.length) return 'no_roots';
    const c = this.caps();
    if (!c || (!c.encoders.length && !(this.cfg.software && c.software))) {
      if (c && c.device === 'denied') return 'device_denied';
      if (c && c.device === 'ok') return 'no_encoder';
      return 'no_device';
    }
    if (this.pauseUntil > this.now()) return 'paused';
    return [...this.jobs.values()].some((j) => j.handed && ACTIVE.has(j.state)) ? 'running' : 'ready';
  }

  /** features.transcode der Telemetrie (klein). */
  featureTelemetry() {
    if (!this.cfg.enabled) return { enabled: false, service: this.service() };
    const c = this.caps();
    const jobs = [...this.jobs.values()];
    const cur = jobs.find((j) => j.handed && ACTIVE.has(j.state));
    const trash = this.trash();
    return {
      enabled: true,
      service: this.service(),
      state: this.state(),
      device: c ? c.device : null,
      deviceGid: c ? c.deviceGid : null,
      driver: c ? c.driver : null,
      encoders: c ? c.encoders : [],
      software: this.cfg.software && !!(c && c.software),
      ffmpeg: c ? c.ffmpeg : null,
      roots: this.roots(),
      jobs: { queued: jobs.filter((j) => ACTIVE.has(j.state) && !j.handed).length, done: jobs.filter((j) => j.state === 'done').length, failed: jobs.filter((j) => j.state === 'failed').length },
      current: cur ? { id: cur.id, state: cur.state, percent: cur.percent } : null,
      trash: { count: trash.length, bytes: trash.reduce((a, t) => a + t.size, 0) },
      arch: process.arch,   // der Dienst umwandeln läuft nur auf x64 (Image nur amd64)
      error: this.lastError ? { code: this.lastError.code, at: iso(this.lastError.at) } : null,
    };
  }

  /** Frischer Zustand (Mgmt /api/transcode/status und Bericht). */
  status({ withTrash = true } = {}) {
    const out = {
      at: iso(this.now()),
      enabled: this.cfg.enabled,
      service: this.service(),
      state: this.state(),
      caps: this.caps(),
      roots: this.roots(),
      settings: { software: this.cfg.software, trashDays: this.cfg.trashDays, quality: this.cfg.quality, verifyDecode: this.cfg.verifyDecode, minFreeGb: this.cfg.minFreeGb, minFreePct: this.cfg.minFreePct },
      pause: this.pauseView(),
      jobs: [...this.jobs.values()].map((j) => this.view(j)),
    };
    if (withTrash) out.trash = this.trash();
    return out;
  }

  async _maybeReport() {
    if (!this.reporter) return;
    const now = this.now();
    if (now < this.reportHold) return;
    const due = this.reportDirty || (this.progressDirty && now - this.lastReport >= REPORT_PROGRESS_MS);
    if (!due) return;
    await this.report();
  }

  async report() {
    if (!this.reporter) return;
    const trash = JSON.stringify(this.trash());
    const body = this.status({ withTrash: trash !== this.lastTrashSent });
    this.lastReport = this.now();
    this.reportDirty = false;
    this.progressDirty = false;
    const r = await this.reporter.post('/api/v1/gateway/transcode/report', body);
    if (r.ok) { this.lastTrashSent = trash; return; }
    this.reportDirty = true;
    // älterer Server ohne diese Adresse: selten nachfragen
    this.reportHold = this.now() + (r.status === 404 ? REPORT_GONE_MS : REPORT_RETRY_MS);
  }
}

module.exports = { TranscodeService, TranscodeError, parseResult, parseCaps, parseRoots, parseTrash, SCRIPT, MAX_QUEUE };
