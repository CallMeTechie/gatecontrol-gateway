'use strict';

// Office-Dateien drucken (docs/print.md „Office-Dateien“): Word, Excel,
// PowerPoint, OpenDocument und RTF werden vor dem Drucken zu PDF – mit
// LibreOffice im eigenen Dienst „office“ (≈ 500 MB, nur geladen, wenn
// „Office-Dateien drucken“ für dieses Gateway an ist; ohne Netz, ohne Rechte).
//
// Das Gateway entscheidet, der Wächter im Dienst führt aus (wie bei den
// Kameras): soll er arbeiten, liegt /gc-office/run im Volume office-ctl; das
// Gateway legt dort auch das Skript office.sh ab (die Logik kommt so mit jedem
// Gateway-Update). Auftrag: in/<id>.<ext> + in/<id>.go → out/<id>.pdf +
// out/<id>.done oder out/<id>.err. Der Wächter meldet sich in office.state.
// Pi-Image: /state/office.json (Wunsch für den nächsten Start) und
// /state/office-start (Host legt den Container an, gatecontrol-office.path).

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');
const { readHostProfile } = require('../radio/radio');

const SCRIPT = path.join(__dirname, 'office.sh');
const STATE_RE = /^(running|idle) ([0-9]{1,12})\s*$/;
const ALIVE_S = 60;
const WANT_FILE = 'office.json';
const START_FLAG = 'office-start';
const START_FLAG_EVERY_MS = 10 * 60_000;
const CONVERT_TIMEOUT_MS = 200_000;
const POLL_MS = 1_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Was LibreOffice für den Druck umwandelt (MIME → Endung); Text macht der Server selbst zu PDF
const TYPES = Object.freeze({
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
});

class OfficeError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function readText(file, max = 4096) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function writeAtomic(file, data, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

class OfficeService {
  constructor({ ctlDir = '/gc-office', stateDir = null, now = Date.now, pollMs = POLL_MS, timeoutMs = CONVERT_TIMEOUT_MS } = {}) {
    Object.assign(this, { ctlDir, stateDir, now, pollMs, timeoutMs });
    this.enabled = false;
    this.lastStartFlag = 0;
    this.chain = Promise.resolve();
    this.hostProfile = null;
  }

  _ctlUsable() {
    try { fs.accessSync(this.ctlDir, fs.constants.W_OK); return fs.statSync(this.ctlDir).isDirectory(); } catch { return false; }
  }

  /** features.print.office: an → Skript und run-Datei, aus → run-Datei weg (der Wächter ruht). */
  apply(enabled) {
    this.enabled = enabled === true;
    this.hostProfile = readHostProfile(this.stateDir);
    this._writeWish();
    if (!this._ctlUsable()) return;
    const run = path.join(this.ctlDir, 'run');
    try {
      if (this.enabled) {
        this._installScript();
        if (!fs.existsSync(run)) writeAtomic(run, 'on\n', 0o600);
      } else fs.rmSync(run, { force: true });
    } catch (e) { logger.warn({ err: e.message }, 'print: office control file not written'); }
    if (this.enabled && this.service() === 'absent') this._askHost();
  }

  _installScript() {
    try {
      const src = fs.readFileSync(SCRIPT);
      const dst = path.join(this.ctlDir, 'office.sh');
      let cur = null;
      try { cur = fs.readFileSync(dst); } catch { cur = null; }
      if (!cur || !cur.equals(src)) writeAtomic(dst, src, 0o600);
      for (const d of ['in', 'out']) fs.mkdirSync(path.join(this.ctlDir, d), { recursive: true, mode: 0o700 });
    } catch (e) { logger.warn({ err: e.message }, 'print: office watcher script not installed'); }
  }

  _writeWish() {
    if (!this.stateDir) return;
    const file = path.join(this.stateDir, WANT_FILE);
    const text = JSON.stringify({ want: this.enabled }) + '\n';
    try { if (readText(file) !== text) writeAtomic(file, text, 0o644); } catch (e) { logger.debug({ err: e.message }, 'print: office.json not written'); }
  }

  /** Pi-Image: der Host soll den Dienst office anlegen (höchstens alle 10 Min.). */
  _askHost() {
    if (!this.stateDir || !(this.hostProfile && this.hostProfile.office_start === true)) return;
    if (this.now() - this.lastStartFlag < START_FLAG_EVERY_MS) return;
    try {
      writeAtomic(path.join(this.stateDir, START_FLAG), JSON.stringify({ office: true, at: new Date(this.now()).toISOString() }) + '\n', 0o600);
      this.lastStartFlag = this.now();
      logger.info('print: asked the host to start the office container');
    } catch (e) { logger.warn({ err: e.message }, 'print: office-start not written'); }
  }

  /** managed (Wächter lebt) | absent (Volume da, Dienst fehlt oder lädt noch) | missing (keine Compose-Unterstützung) */
  service() {
    if (!this._ctlUsable()) return 'missing';
    const m = STATE_RE.exec(readText(path.join(this.ctlDir, 'office.state'), 64) || '');
    if (!m) return 'absent';
    return Math.abs(this.now() / 1000 - Number(m[2])) <= ALIVE_S ? 'managed' : 'absent';
  }

  /** Office-Dateien gehen jetzt: eingeschaltet und der Dienst arbeitet. */
  ready() { return this.enabled && this.service() === 'managed'; }

  /** Für die Telemetrie: { enabled, service } */
  snapshot() {
    const service = this.service();
    if (this.enabled && service === 'absent') this._askHost();
    return { enabled: this.enabled, service };
  }

  /**
   * Eine Office-Datei → PDF (dst). Nacheinander (ein LibreOffice zugleich).
   * mime: einer aus TYPES. Fehler: office_off, office_missing, office_type, office_failed, office_timeout.
   */
  toPdf(id, src, mime, dst, { signal = null } = {}) {
    const run = this.chain.then(() => this._toPdf(id, src, mime, dst, signal));
    this.chain = run.catch(() => {});
    return run;
  }

  async _toPdf(id, src, mime, dst, signal) {
    if (!ID_RE.test(id)) throw new OfficeError('office_failed', 'bad id');
    const ext = TYPES[mime];
    if (!ext) throw new OfficeError('office_type', 'not an office type');
    if (!this.enabled) throw new OfficeError('office_off');
    if (!this.ready()) throw new OfficeError('office_missing');
    const inDir = path.join(this.ctlDir, 'in');
    const outDir = path.join(this.ctlDir, 'out');
    fs.mkdirSync(inDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const clean = () => {
      for (const f of [path.join(inDir, `${id}.${ext}`), path.join(inDir, `${id}.go`), path.join(outDir, `${id}.pdf`), path.join(outDir, `${id}.done`), path.join(outDir, `${id}.err`)]) {
        try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
      }
    };
    clean();
    fs.copyFileSync(src, path.join(inDir, `${id}.${ext}`));
    writeAtomic(path.join(inDir, `${id}.go`), ext + '\n', 0o600);
    const until = this.now() + this.timeoutMs;
    try {
      while (this.now() < until) {
        if (signal && signal.aborted) throw new OfficeError('aborted');
        if (fs.existsSync(path.join(outDir, `${id}.done`))) {
          fs.copyFileSync(path.join(outDir, `${id}.pdf`), dst);
          return { file: dst, size: fs.statSync(dst).size };
        }
        const err = readText(path.join(outDir, `${id}.err`), 64);
        if (err != null) throw new OfficeError(err.trim() === 'timeout' ? 'office_timeout' : 'office_failed', err.trim().slice(0, 40));
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
      throw new OfficeError('office_timeout', 'no answer of the office service');
    } finally { clean(); }
  }
}

module.exports = { OfficeService, OfficeError, TYPES, SCRIPT };
