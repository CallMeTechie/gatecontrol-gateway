'use strict';

// „Drucken & Scannen“ im Gateway-Prozess (Vertrag Phase 3c, docs/print.md):
// Geräte im LAN finden und ihren Zustand (Tinte, bereit/Standby) melden,
// Druckaufträge des Servers per IPP an den Drucker geben (bis der Server sie
// nach 24 h aufgibt), Scans per eSCL holen und seitenweise hochladen.
// Verbunden wird nur mit selbst gefundenen Geräten im eigenen privaten LAN
// oder mit den `manual`-Adressen (RFC 1918) – Server und Plugins nennen nur
// Geräte-Ids.

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');
const { FeatureStatus, loop } = require('../features/status');
const { readJson, writeJson } = require('../features/persist');
const { ipInCidr } = require('../discovery/lanInterfaces');
const discovery = require('./discovery');
const ippLib = require('./ipp');
const esclLib = require('./escl');
const convertLib = require('./convert');
const ocrLib = require('./ocr');
const { OfficeService, TYPES: OFFICE_TYPES } = require('./office');
const { makePrintClient, ID_RE } = require('./serverClient');
const { isRfc1918, cleanText } = require('./config');
const { inspectLeafCertificate } = require('../proxy/tlsPin');

const DEVICES_PATH = '/api/v1/gateway/print/devices';
const JOB_PATH = (id) => `/api/v1/gateway/print/jobs/${id}`;
const SCAN_PATH = (id) => `/api/v1/gateway/print/scans/${id}`;
const OCR_PATH = (id) => `/api/v1/gateway/print/ocr/${id}`;
const STATE_FILE = 'print-devices.json';
const JOURNAL_FILE = 'print-journal.json';

const CYCLE_MS = 5 * 60_000;          // Zustand (Tinte, bereit) alle 5 Min.
const SEARCH_EVERY = 2;               // mDNS-Suche jeden 2. Durchlauf (10 Min.)
const REPORT_MS = 15 * 60_000;        // Gerätebericht spätestens alle 15 Min.
const JOBS_MS = 60_000;               // Warteschlange jede Minute (ETag)
const RETRY_MS = 2 * 60_000;          // Drucker nicht erreichbar → in 2 Min. wieder
const JOB_WATCH_MS = 10 * 60_000;     // so lange auf „fertig“ des Druckers warten
const JOB_POLL_MS = 5_000;
const FORGET_MS = 30 * 86400_000;     // Geräte, 30 Tage nicht gesehen, vergessen
const JOURNAL_MS = 2 * 86400_000;
// `manual`-Adressen: IPP ohne TLS auf 631 (Pfade der gängigen Hersteller), dann IPPS auf 443; eSCL auf 80, dann 443
const MANUAL_IPP_PATHS = ['ipp/print', 'ipp', ''];
const MANUAL_IPPS = { scheme: 'ipps', port: 443, path: 'ipp/print' };
const MANUAL_ESCL = [{ scheme: 'http', port: 80 }, { scheme: 'https', port: 443 }];
const PROBE_MS = 5_000;
const NET_CODES = new Set(['network', 'timeout']);

const TLS_SCHEMES = new Set(['ipps', 'https']);
const PIN_RE = /^[0-9a-f]{64}$/;

const OCR_QUEUE_MAX = 3;               // so viele Texterkennungen warten höchstens (eine läuft)
const OCR_BEAT_MS = 60_000;           // „läuft noch“ an den Server (er gibt nach 3 Min. Stille auf)

// Was der Drucker während des Drucks meldet und die Apps zeigen (printer-state-reasons ohne -error/-warning/-report)
const STOP_REASONS = ['media-empty', 'media-needed', 'media-jam', 'door-open', 'cover-open', 'toner-empty', 'marker-supply-empty', 'input-tray-missing', 'output-area-full', 'paused'];

const SCAN_MODES = ['bw', 'gray', 'color'];
const SCAN_FORMATS = ['image/jpeg', 'application/pdf'];

/** Der Drucker-Teil eines Geräts aus printerInfo (ohne Name/Modell/Ort/UUID – die stehen am Gerät). */
function printerPart(info) {
  const out = { ...info };
  for (const k of ['model', 'name', 'location', 'uuid']) delete out[k];
  return out;
}

class PrintService {
  constructor({
    reporter, client = null, serverUrl, apiToken, stateDir, getSubnets = () => [],
    browse = discovery.browse, ipp = ippLib, escl = esclLib, converter = convertLib, ocr = ocrLib, office = null, now = Date.now, inspect = inspectLeafCertificate,
    cycleMs = CYCLE_MS, jobsMs = JOBS_MS, retryMs = RETRY_MS, jobPollMs = JOB_POLL_MS, jobWatchMs = JOB_WATCH_MS, browseMs = 4000, ocrBeatMs = OCR_BEAT_MS,
  }) {
    Object.assign(this, { reporter, stateDir, getSubnets, browse, ipp, escl, converter, ocr, now, inspect, retryMs, jobPollMs, jobWatchMs, browseMs, ocrBeatMs });
    // Office-Dateien → PDF im Dienst office (office.js)
    this.office = office || new OfficeService({ stateDir });
    this.ocrQueue = [];            // wartende Texterkennungen { id, pages, dpi, abort }
    this.ocrRunning = null;        // die laufende
    this.converting = Promise.resolve(); // Umwandlungen nacheinander (_convert)
    this.client = client || makePrintClient({ serverUrl, apiToken });
    this.status = new FeatureStatus(now);
    this.cfg = { enabled: false, manual: [], convert: true, ocr: false, office: false };
    this.devices = new Map();
    this.jobs = new Map();          // id → { job, nextTryAt, running, final }
    this.journal = new Map();       // id → { at, ippJobId }  an den Drucker gegeben (gegen Doppeldruck nach Neustart)
    this.scans = new Map();         // scanId → { abort, deviceId }
    this.busy = new Set();          // Geräte mit laufendem Druck/Scan
    this.etag = null;
    this.searching = null;
    this.polling = null;
    this.cycles = 0;
    this.lastSearchAt = null;
    this.lastSearch = null;         // Diagnose der letzten Suche (an den Server, docs/print.md)
    this.lastReportAt = 0;
    this.lastReported = null;
    this.serverMissing = false;
    this.cycleLoop = loop(() => this.cycle(), () => cycleMs);
    this.jobsLoop = loop(() => this.pollJobs(), () => jobsMs);
  }

  _tmpDir() { return path.join(this.stateDir || '/tmp', 'print-tmp'); }

  _restore() {
    if (!this.stateDir) return;
    const s = readJson(this.stateDir, STATE_FILE);
    if (s && Array.isArray(s.devices)) {
      for (const d of s.devices.slice(0, discovery.MAX_DEVICES)) {
        if (!d || typeof d.id !== 'string' || !isRfc1918(d.ip)) continue;
        this.devices.set(d.id, { ...d, online: false, printer: d.printer || null, scanner: d.scanner || null });
      }
    }
    const j = readJson(this.stateDir, JOURNAL_FILE);
    if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) if (ID_RE.test(k) && v && Number.isSafeInteger(v.at)) this.journal.set(k, v);
  }

  _persist() {
    if (!this.stateDir) return;
    const devices = [...this.devices.values()].map((d) => ({
      id: d.id, uuid: d.uuid, ip: d.ip, name: d.name, model: d.model, location: d.location, source: d.source,
      ipp: d.ipp, escl: d.escl, hints: d.hints, seenAt: d.seenAt, printer: d.printer, scanner: d.scanner, problem: d.problem || null, seenSha256: d.seenSha256 || null,
    }));
    writeJson(this.stateDir, STATE_FILE, { devices });
    const cut = this.now() - JOURNAL_MS;
    for (const [k, v] of this.journal) if (v.at < cut) this.journal.delete(k);
    writeJson(this.stateDir, JOURNAL_FILE, Object.fromEntries(this.journal));
  }

  async apply(cfg) {
    const prev = this.cfg;
    this.cfg = { ...cfg, convert: cfg.convert !== false, ocr: cfg.ocr === true, office: cfg.office === true };
    this.status.setEnabled(cfg.enabled);
    this.office.apply(this.cfg.enabled && this.cfg.office);
    if (!cfg.enabled) { if (prev.enabled) this._shutdown(); return; }
    if (!prev.enabled) {
      this._restore();
      try { fs.mkdirSync(this._tmpDir(), { recursive: true, mode: 0o700 }); } catch (_e) { /* beim Auftrag gemeldet */ }
      this.cycles = 0;
      this.cycleLoop.start(2_000);
      this.jobsLoop.start(10_000);
    } else if (JSON.stringify(prev.manual) !== JSON.stringify(cfg.manual)) {
      this.cycles = 0;
      this.cycleLoop.start(1_000);
    } else if (prev.convert !== this.cfg.convert || prev.office !== this.cfg.office) {
      // „PDF umwandeln“ / „Office-Dateien drucken“ umgeschaltet: der Server erfährt gleich, was die Drucker jetzt nehmen
      this.report(true).catch((e) => logger.debug({ err: e.message }, 'print: report failed'));
    }
    if (!this.cfg.ocr) this._dropOcr('ocr_off');
  }

  _shutdown() {
    this.cycleLoop.stop();
    this.jobsLoop.stop();
    for (const s of this.scans.values()) s.abort.abort();
    this.scans.clear();
    this._dropOcr('disabled');
    this._persist();
    this.jobs.clear();
    this.etag = null;
  }

  stop() { if (this.cfg.enabled) this._shutdown(); }

  /** Liegt die Adresse in einem eigenen privaten LAN-Subnetz oder in `manual`? */
  isAllowed(ip) {
    if (!isRfc1918(ip)) return false;
    if (this.cfg.manual.includes(ip)) return true;
    return this.getSubnets().some((s) => {
      const [network, prefix] = String(s.cidr).split('/');
      return ipInCidr(ip, network, Number(prefix));
    });
  }

  // ─── Geräte ───────────────────────────────────────────────────────────

  async cycle() {
    if (!this.cfg.enabled) return;
    const search = this.cycles % SEARCH_EVERY === 0;
    this.cycles += 1;
    if (search) await this.search();
    else { await this.refreshAll(); await this.report(); }
  }

  /**
   * Mgmt „Neu suchen“. `retrust`: die Geräte-Id, deren geändertes Zertifikat
   * ein Administrator bestätigt hat – ihr gespeicherter Fingerabdruck wird
   * verworfen und beim nächsten Kontakt neu gelernt.
   */
  requestSearch({ retrust = null } = {}) {
    if (!this.cfg.enabled) return 'disabled';
    if (this.searching) return 'busy';
    const d = typeof retrust === 'string' ? this.devices.get(retrust) : null;
    if (d) {
      for (const ep of [d.ipp, d.escl]) if (ep) delete ep.pin;
      d.problem = null;
      d.seenSha256 = null;
      logger.info({ device: d.id }, 'print: certificate pin dropped on request');
    }
    void this.search();
    return 'accepted';
  }

  search() {
    if (this.searching) return this.searching;
    this.searching = this._search().finally(() => { this.searching = null; });
    return this.searching;
  }

  async _search() {
    this.status.start();
    try {
      const packets = [];
      const diag = { errors: [], responders: new Set() };
      let interfaces = 0;
      for (const s of this.getSubnets()) {
        if (!s.localIp) continue;
        interfaces += 1;
        packets.push(...await this.browse({ ifaceIp: s.localIp, timeoutMs: this.browseMs, diag }));
      }
      const { devices: found, stats } = discovery.analyze(packets, (ip) => this.isAllowed(ip));
      const now = this.now();
      for (const f of found) this._merge(f, 'mdns', now);
      // die `manual`-Adressen direkt fragen (gleichzeitig; eine, die mDNS schon fand, nicht noch einmal)
      const manual = await Promise.all(this.cfg.manual.map(async (ip) => {
        if (found.some((f) => f.ip === ip)) return { ip, found: true, via: 'mdns' };
        const r = await this._probeManual(ip);
        if (r.device) { this._merge(r.device, 'manual', now); return { ip, found: true, via: 'manual' }; }
        return { ip, found: false, error: r.error };
      }));
      if (!interfaces) diag.errors.unshift('no_lan');
      this.lastSearch = {
        at: now, interfaces, responses: stats.responses, responders: diag.responders.size, services: stats.services,
        devices: found.length, dropped: stats.dropped, hosts: stats.hosts, manual, errors: diag.errors.slice(0, 8),
      };
      if (found.length || Object.keys(stats.dropped).length || manual.length) {
        logger.info({ interfaces, responses: stats.responses, services: stats.services, devices: found.length, dropped: stats.dropped, manual: manual.filter((m) => m.found).length }, 'print: search done');
      }
      // Geräte an Adressen, die nicht mehr erlaubt sind (Subnetz weg, manual entfernt), und alte Einträge gehen
      for (const [id, d] of this.devices) {
        if (!this.isAllowed(d.ip) || (d.seenAt && now - d.seenAt > FORGET_MS)) this.devices.delete(id);
      }
      this.lastSearchAt = now;
      await this.refreshAll();
      this.status.ok();
    } catch (err) {
      this.status.fail(err.code || err.message);
      logger.warn({ err: err.message }, 'print: search failed');
    }
    this._persist();
    await this.report(true);
  }

  _merge(f, source, now) {
    // eine neue UUID für ein bisher nur per Adresse bekanntes Gerät: den alten Eintrag ablösen
    const old = this.devices.get(f.id) || [...this.devices.values()].find((d) => d.ip === f.ip && (!d.uuid || d.uuid === f.uuid));
    if (old && old.id !== f.id) this.devices.delete(old.id);
    const d = old || { printer: null, scanner: null };
    // ein gelernter Fingerabdruck bleibt, solange es derselbe Endpunkt ist
    const keepPin = (fresh, prev) => {
      if (!fresh) return prev || null;
      const same = prev && prev.scheme === fresh.scheme && prev.host === fresh.host && prev.port === fresh.port;
      return same && prev.pin ? { ...fresh, pin: prev.pin } : fresh;
    };
    Object.assign(d, {
      id: f.id, uuid: f.uuid || null, ip: f.ip, name: f.name || (old && old.name) || f.ip, model: f.model || (old && old.model) || '',
      location: f.location || (old && old.location) || '', source, ipp: keepPin(f.ipp, old && old.ipp), escl: keepPin(f.escl, old && old.escl),
      hints: f.hints || {}, seenAt: now,
    });
    this.devices.set(d.id, d);
  }

  /**
   * Trust on first use für ipps/https: Drucker und Scanner im LAN haben selbst
   * signierte Zertifikate. Beim ersten Kontakt wird der SHA-256 des
   * Leaf-Zertifikats gelernt (nur TLS-Handshake, kein Byte Anwendungsdaten –
   * src/proxy/tlsPin.js), danach gilt jede Verbindung nur mit genau diesem
   * Zertifikat. Ein anderes → `cert_changed`, bis ein Administrator es bestätigt.
   */
  async _learnPins(d) {
    for (const ep of [d.ipp, d.escl]) {
      if (!ep || !TLS_SCHEMES.has(ep.scheme) || (typeof ep.pin === 'string' && PIN_RE.test(ep.pin))) continue;
      try {
        const c = await this.inspect({ host: ep.host, port: ep.port, timeoutMs: 5_000 });
        if (c && typeof c.sha256 === 'string' && PIN_RE.test(c.sha256)) {
          ep.pin = c.sha256;
          logger.info({ device: d.id, port: ep.port }, 'print: certificate pinned on first contact');
        }
      } catch (_e) { /* nicht erreichbar – beim nächsten Durchlauf wieder */ }
    }
  }

  _certProblem(d, err) {
    if (!err || err.code !== 'cert_changed') return false;
    if (d.problem !== 'cert_changed') logger.warn({ device: d.id, seen: err.seenSha256 }, 'print: certificate of the device changed — not used until confirmed');
    d.problem = 'cert_changed';
    d.seenSha256 = err.seenSha256 || null;
    return true;
  }

  /** Den Fingerabdruck eines TLS-Endpunkts lernen (trust on first use) → pin oder null. */
  async _pinOf(host, port) {
    try {
      const c = await this.inspect({ host, port, timeoutMs: PROBE_MS });
      return c && typeof c.sha256 === 'string' && PIN_RE.test(c.sha256) ? c.sha256 : null;
    } catch (_e) { return null; }
  }

  /**
   * Eine `manual`-Adresse direkt fragen: IPP `Get-Printer-Attributes` auf 631
   * (/ipp/print, /ipp, /), sonst IPPS auf 443 (Zertifikat beim ersten Kontakt
   * gelernt); eSCL `ScannerCapabilities` auf 80, sonst 443.
   * → { device } oder { error: 'unreachable' | 'no_service' }
   */
  async _probeManual(ip) {
    let ipp = null;
    let attrs = null;
    let escl = null;
    let caps = null;
    let answered = false; // irgendetwas hat geantwortet (HTTP-Status, Zertifikat) – dann ist es nur kein Drucker/Scanner
    const tryIpp = async (ep) => {
      try { attrs = await this.ipp.getPrinterAttributes(ep, { timeoutMs: PROBE_MS }); ipp = ep; return 'ok'; } catch (e) {
        if (!NET_CODES.has(e && e.code)) answered = true;
        return NET_CODES.has(e && e.code) ? 'down' : 'other';
      }
    };
    for (const p of MANUAL_IPP_PATHS) {
      const r = await tryIpp({ scheme: 'ipp', host: ip, port: 631, path: p });
      if (r !== 'other') break; // gefunden, oder 631 gar nicht erreichbar → kein weiterer Pfad
    }
    const pins = new Map();
    const pinFor = async (port) => {
      if (!pins.has(port)) pins.set(port, await this._pinOf(ip, port));
      if (pins.get(port)) answered = true;
      return pins.get(port);
    };
    if (!ipp) {
      const pin = await pinFor(MANUAL_IPPS.port);
      if (pin) await tryIpp({ scheme: MANUAL_IPPS.scheme, host: ip, port: MANUAL_IPPS.port, path: MANUAL_IPPS.path, pin });
    }
    for (const c of MANUAL_ESCL) {
      const ep = { scheme: c.scheme, host: ip, port: c.port, path: 'eSCL' };
      if (TLS_SCHEMES.has(ep.scheme)) {
        const pin = await pinFor(c.port);
        if (!pin) continue;
        ep.pin = pin;
      }
      try { caps = await this.escl.capabilities(ep, { timeoutMs: PROBE_MS }); escl = ep; break; } catch (e) {
        if (!NET_CODES.has(e && e.code)) answered = true;
      }
    }
    if (!ipp && !escl) return { error: answered ? 'no_service' : 'unreachable' };
    const info = attrs ? this.ipp.printerInfo(attrs) : null;
    const first = (k) => (attrs && Array.isArray(attrs[k]) && typeof attrs[k][0] === 'string' ? cleanText(attrs[k][0], 120) : '');
    const model = (info && info.model) || (caps && caps.model) || '';
    const uuid = info && info.uuid ? discovery.normUuid(info.uuid) : null;
    const device = {
      id: discovery.deviceId(uuid, ip), uuid, ip,
      // „HP OfficeJet Pro 8720“ (printer-info) vor dem Modell vor „HP_OfficeJet_Pro_8720“ (printer-name)
      name: first('printer-info') || model || first('printer-name') || ip,
      model, location: (info && info.location) || '', ipp, escl, hints: {},
    };
    return { device };
  }

  async refreshAll() {
    for (const d of [...this.devices.values()]) {
      if (this.busy.has(d.id)) continue; // mitten im Druck/Scan nicht dazwischenfragen
      await this.refresh(d);
    }
  }

  async refresh(d) {
    let ok = false;
    await this._learnPins(d);
    if (d.ipp) {
      try {
        const info = this.ipp.printerInfo(await this.ipp.getPrinterAttributes(d.ipp, { timeoutMs: 8_000 }));
        d.printer = printerPart(info);
        if (info.model && !d.model) d.model = info.model;
        if (info.location && !d.location) d.location = info.location;
        ok = true;
      } catch (e) {
        this._certProblem(d, e);
        d.printer = d.printer ? { ...d.printer, state: 'offline', reasons: [] } : { state: 'offline', accepting: false, reasons: [], color: !!d.hints?.color, duplex: !!d.hints?.duplex, formats: d.hints?.formats || [], copiesMax: 1, markers: [] };
      }
    }
    if (d.escl) {
      try {
        const caps = d.scanner && d.scanner.caps ? d.scanner.caps : await this.escl.capabilities(d.escl, { timeoutMs: 8_000 });
        let st = { state: 'idle', adf: null };
        try { st = await this.escl.status(d.escl, { timeoutMs: 8_000 }); } catch (_e) { /* manche Geräte kennen kein ScannerStatus */ }
        d.scanner = { caps, state: st.state, adf: st.adf };
        ok = true;
      } catch (e) {
        this._certProblem(d, e);
        d.scanner = d.scanner ? { ...d.scanner, state: 'offline' } : null;
      }
    }
    d.online = ok;
    if (ok) d.seenAt = this.now();
    if (ok && d.problem === 'cert_changed' && [d.ipp, d.escl].every((ep) => !ep || !TLS_SCHEMES.has(ep.scheme))) d.problem = null;
  }

  /** Öffentliche Sicht eines Geräts (Vertrag §2) – ohne Endpunkte. */
  _view(d) {
    const p = d.printer;
    const s = d.scanner;
    return {
      id: d.id, name: d.name, model: d.model || null, ip: d.ip, location: d.location || null, source: d.source || 'mdns',
      online: !!d.online, seenAt: d.seenAt || null,
      // `cert_changed`: ipps/https antwortet mit einem anderen Zertifikat als beim ersten Kontakt
      problem: d.problem || null, ...(d.problem === 'cert_changed' ? { seenSha256: d.seenSha256 || null } : {}),
      printer: d.ipp && p ? {
        state: p.state, reasons: p.reasons || [], color: !!p.color, duplex: !!p.duplex, formats: p.formats || [], copiesMax: p.copiesMax || 1, markers: p.markers || [],
        // nimmt er kein PDF: das Format, in das das Gateway PDF umwandelt (null: geht nicht – aus, kein Werkzeug, kein passendes Format)
        convert: this._convertTarget(p),
        // Office-Dateien druckbar: „Office-Dateien drucken“ an, Dienst office arbeitet, und PDF geht (direkt oder umgewandelt)
        office: this.office.ready() && (!(p.formats || []).length || (p.formats || []).includes(convertLib.PDF) || !!this._convertTarget(p)),
        // Papier und Fächer (docs/print.md „Papier und Fach“)
        media: p.media || { sizes: [], default: null, sources: [], sourceDefault: null, ready: [] },
      } : null,
      scanner: d.escl && s && s.caps ? {
        state: s.state || 'idle', platen: !!s.caps.platen, feeder: !!s.caps.feeder, duplex: !!s.caps.duplex,
        color: s.caps.color, resolutions: s.caps.resolutions, formats: s.caps.formats, adf: s.adf || null,
      } : null,
    };
  }

  _convertTarget(p) {
    const fmts = Array.isArray(p.formats) ? p.formats : [];
    if (!fmts.length || fmts.includes(convertLib.PDF) || !this.cfg.convert || !this.converter.available()) return null;
    return this.converter.targetOf(p);
  }

  devicesView() { return [...this.devices.values()].filter((d) => d.ipp || d.escl).map((d) => this._view(d)); }

  async report(force = false) {
    if (!this.cfg.enabled) return;
    const devices = this.devicesView();
    const sig = JSON.stringify(devices.map((x) => ({ ...x, seenAt: null })));
    if (!force && sig === this.lastReported && this.now() - this.lastReportAt < REPORT_MS) return;
    const r = await this.reporter.post(DEVICES_PATH, { scannedAt: this.lastSearchAt, devices, ...(this.lastSearch ? { search: this.lastSearch } : {}) });
    if (r.ok) { this.lastReported = sig; this.lastReportAt = this.now(); this.serverMissing = false; } else if (r.status === 404) this.serverMissing = true;
  }

  // ─── Druckaufträge ────────────────────────────────────────────────────

  /** Mgmt „Aufträge jetzt abholen“ */
  requestJobs() {
    if (!this.cfg.enabled) return 'disabled';
    void this.pollJobs();
    return 'accepted';
  }

  pollJobs() {
    if (this.polling) return this.polling;
    this.polling = this._pollJobs().finally(() => { this.polling = null; });
    return this.polling;
  }

  async _pollJobs() {
    if (!this.cfg.enabled) return;
    let list;
    try {
      const r = await this.client.jobs(this.etag);
      if (r.changed) { this.etag = r.etag; list = r.jobs; }
    } catch (err) {
      if (err.code !== 'not_supported') logger.debug({ err: err.code || err.message }, 'print: job list failed');
      this.etag = null;
      return;
    }
    if (list) {
      const ids = new Set(list.map((j) => j.id));
      for (const [id, t] of this.jobs) {
        if (!ids.has(id) && !t.running) { this.jobs.delete(id); this._dropFile(id); }
      }
      for (const j of list) {
        const t = this.jobs.get(j.id);
        if (t) t.job = j; else this.jobs.set(j.id, { job: j, nextTryAt: 0, running: false, final: null });
      }
    }
    const now = this.now();
    const runs = [];
    for (const t of this.jobs.values()) {
      if (t.running || t.nextTryAt > now) continue;
      if (t.final) { runs.push(this._sendFinal(t)); continue; }
      if (this.busy.has(t.job.deviceId)) continue;
      runs.push(this._run(t));
    }
    await Promise.all(runs);
  }

  _file(id) { return path.join(this._tmpDir(), id + '.job'); }
  _dropFile(id) { try { fs.rmSync(this._file(id), { force: true }); } catch (_e) { /* best effort */ } }

  async _state(id, body) {
    const r = await this.reporter.post(JOB_PATH(id), body);
    return r.ok;
  }

  /** Endzustand melden; klappt das nicht, bleibt er stehen und geht beim nächsten Abruf noch einmal raus. */
  async _sendFinal(t) {
    t.running = true;
    try {
      if (await this._state(t.job.id, t.final)) { this.jobs.delete(t.job.id); this._dropFile(t.job.id); this.etag = null; } else t.nextTryAt = this.now() + 30_000;
    } finally { t.running = false; }
  }

  _finish(t, body) {
    t.final = body;
    if (body.state === 'done' || body.state === 'failed') this.journal.delete(t.job.id);
    this._persist();
    return this._sendFinal(t);
  }

  async _wait(t, code, message) {
    t.nextTryAt = this.now() + this.retryMs;
    await this._state(t.job.id, { state: 'waiting', error: code, ...(message ? { message: String(message).slice(0, 200) } : {}) });
  }

  /**
   * Wie eine Datei des Formats `format` auf den Drucker kommt: { asIs } (er nennt
   * das Format, nennt gar keins oder nimmt application/octet-stream), { plan }
   * (PDF, das das Gateway umwandelt – convert.js) oder { fail: Grund }.
   */
  _way(d, format, color, media = null) {
    const fmts = d.printer && Array.isArray(d.printer.formats) ? d.printer.formats : [];
    if (!fmts.length || fmts.includes(format)) return { asIs: true };
    const plan = format === convertLib.PDF ? this._plan(d, color, media) : null;
    if (plan) return { plan };
    if (fmts.includes('application/octet-stream')) return { asIs: true };
    return { fail: format === convertLib.PDF ? this._whyNot(d) : 'printer_formats' };
  }

  /** Der Umwandel-Plan für PDF auf diesem Drucker – null: aus, kein Werkzeug oder kein passendes Format. */
  _plan(d, color, media = null) {
    if (!this.cfg.convert || !d.printer || !this.converter.available()) return null;
    return this.converter.plan(d.printer, { color: !!color && !!d.printer.color, media });
  }

  _whyNot(d) {
    if (!this.cfg.convert) return 'convert_off';
    if (!this.converter.available()) return 'no_converter';
    return d && d.printer ? 'no_raster_format' : 'printer_formats';
  }

  /** Umwandeln, eins nach dem anderen (schont schwache Geräte wie den Raspberry Pi). */
  _convert(src, dst, plan, opts) {
    const run = this.converting.then(() => this.converter.convert(src, dst, plan, opts));
    this.converting = run.catch(() => {});
    return run;
  }

  _dropConverted(id) {
    try {
      for (const f of fs.readdirSync(this._tmpDir())) if (f.startsWith(id + '.conv')) fs.rmSync(path.join(this._tmpDir(), f), { force: true });
    } catch (_e) { /* best effort */ }
  }

  async _run(t) {
    const job = t.job;
    // schon an den Drucker gegeben (Neustart dazwischen): nicht noch einmal drucken
    const sent = this.journal.get(job.id);
    if (sent) return this._finish(t, { state: 'done', ippJobId: sent.ippJobId || null, message: 'unconfirmed' });
    const d = this.devices.get(job.deviceId);
    if (!d || !d.ipp) {
      if (d && d.escl && !d.ipp) return this._finish(t, { state: 'failed', error: 'not_a_printer' });
      return this._wait(t, 'device_not_found');
    }
    if (!this.isAllowed(d.ip)) return this._finish(t, { state: 'failed', error: 'device_not_allowed' });
    const officeJob = !!OFFICE_TYPES[job.format];
    if (officeJob && !this.cfg.office) return this._finish(t, { state: 'failed', error: 'format_unsupported', message: 'office_off' });
    const early = officeJob ? { asIs: true } : this._way(d, job.format, job.color, job.media);
    // „application/octet-stream“ (unbekannt): erst der Inhalt entscheidet (sniff nach dem Laden)
    if (early.fail && job.format !== 'application/octet-stream') return this._finish(t, { state: 'failed', error: 'format_unsupported', message: early.fail });
    t.running = true;
    this.busy.add(d.id);
    try {
      const file = this._file(job.id);
      let have = -1;
      try { have = fs.statSync(file).size; } catch (_e) { have = -1; }
      if (have !== job.size) {
        try {
          fs.mkdirSync(this._tmpDir(), { recursive: true, mode: 0o700 });
          await this.client.file(job.id, job.sha256, job.size, file);
        } catch (err) {
          this._dropFile(job.id);
          if (err.code === 'not_found') { this.jobs.delete(job.id); return undefined; }
          return this._wait(t, 'download_failed', err.code || err.message);
        }
      }
      // das Format am Inhalt, nicht am Etikett (ein PDF als octet-stream, ein JPEG als PDF …)
      const seen = this.converter.sniffFile(file);
      let format = seen && seen !== job.format ? seen : job.format;
      if (format !== job.format) logger.info({ job: job.id, said: job.format, seen }, 'print: format taken from the content');
      // erreichbar und nimmt Aufträge an? (weckt viele Drucker aus dem Standby)
      try {
        const a = this.ipp.printerInfo(await this.ipp.getPrinterAttributes(d.ipp, { timeoutMs: 15_000 }));
        d.printer = printerPart(a);
        d.online = true;
        if (!a.accepting) return this._wait(t, 'printer_not_accepting');
      } catch (err) {
        if (this._certProblem(d, err)) return this._wait(t, 'cert_changed');
        if (err.code === 'no_pin') { await this._learnPins(d); return this._wait(t, 'printer_offline', 'no_pin'); }
        if (d.printer) d.printer.state = 'offline';
        return this._wait(t, 'printer_offline', err.code || err.message);
      }
      // eine Office-Datei: erst zu PDF (Dienst office), dann wie jedes PDF
      let src = file;
      let pages = null;
      if (OFFICE_TYPES[format]) {
        if (!this.office.ready()) return this._wait(t, 'office_starting');
        await this._state(job.id, { state: 'sending', message: 'converting_office' });
        const pdfFile = path.join(this._tmpDir(), job.id + '.conv-office.pdf');
        try {
          await this.office.toPdf(job.id, file, format, pdfFile);
        } catch (err) {
          this._dropConverted(job.id);
          if (err.code === 'office_missing') return this._wait(t, 'office_starting');
          if (err.code === 'office_off') return this._finish(t, { state: 'failed', error: 'format_unsupported', message: 'office_off' });
          return this._finish(t, { state: 'failed', error: err.code === 'office_timeout' ? 'office_timeout' : 'office_failed', message: String(err.message || '').slice(0, 200) || null });
        }
        src = pdfFile;
        format = convertLib.PDF;
        try { pages = (await this.converter.pageSizes(src, { timeoutMs: 30_000 })).length; } catch (_e) { pages = null; }
      }
      const way = this._way(d, format, job.color, job.media);
      if (way.fail) return this._finish(t, { state: 'failed', error: 'format_unsupported', message: way.fail });
      let parts = [{ file: src, size: fs.statSync(src).size }];
      let sendAs = format;
      let plan = way.plan || null;
      for (let round = 0; round < 2; round++) {
        if (plan) {
          await this._state(job.id, { state: 'sending', message: 'converting' });
          try {
            const out = await this._convert(src, path.join(this._tmpDir(), job.id + '.conv'), plan, { duplex: job.duplex === true && !!d.printer.duplex });
            parts = out.files;
            sendAs = out.format;
          } catch (err) {
            this._dropConverted(job.id);
            if (err.code === 'no_converter') return this._finish(t, { state: 'failed', error: 'format_unsupported', message: 'no_converter' });
            return this._finish(t, { state: 'failed', error: err.code === 'convert_too_large' ? 'convert_too_large' : 'convert_failed', message: String(err.message || '').slice(0, 200) || null });
          }
        }
        if (round === 0) await this._state(job.id, { state: 'sending' });
        const color = plan ? job.color === true && plan.type === 'srgb_8' && !plan.mono : job.color;
        const r = await this._sendParts(t, d, parts, sendAs, color);
        if (r.formatRefused && !plan && format === convertLib.PDF) {
          // der Drucker nennt PDF, nimmt es aber nicht: einmal umgewandelt versuchen (das PDF der Office-Datei bleibt dafür liegen)
          plan = this._plan(d, job.color, job.media);
          if (plan && round === 0 && !r.converted) { logger.info({ job: job.id }, 'print: printer refused the PDF, converting'); continue; }
        }
        this._dropConverted(job.id);
        if (r.formatRefused) {
          if (!plan && format === convertLib.PDF) plan = this._plan(d, job.color, job.media);
          if (plan && round === 0 && !r.converted) { logger.info({ job: job.id }, 'print: printer refused the PDF, converting'); continue; }
          return this._finish(t, { state: 'failed', error: 'format_unsupported', message: 'printer_refused' });
        }
        if (r.done) return undefined;
        this.journal.set(job.id, { at: this.now(), ippJobId: r.jobId });
        this._persist();
        this._dropFile(job.id);
        await this._state(job.id, { state: 'printing', ippJobId: r.jobId, ...(pages ? { pages } : {}) });
        return this._finish(t, await this._watch(d, r.jobId, job.id));
      }
      return this._finish(t, { state: 'failed', error: 'format_unsupported', message: 'printer_refused' });
    } finally {
      t.running = false;
      this.busy.delete(d.id);
      this._dropConverted(job.id);
    }
  }

  /**
   * Die Teile an den Drucker (meist einer; JPEG aus PDF: je Seite ein Auftrag).
   * → { jobId } (der letzte) | { done } (schon gemeldet: wartet/fehlgeschlagen) | { formatRefused } (IPP 0x040a)
   */
  async _sendParts(t, d, parts, format, color) {
    const job = t.job;
    let jobId = null;
    for (let i = 0; i < parts.length; i++) {
      const name = parts.length > 1 ? `${job.name} (${i + 1}/${parts.length})` : job.name;
      let res;
      try {
        res = await this.ipp.printJob(d.ipp, parts[i].file, parts[i].size, {
          name, user: job.user, format: this.converter.ippFormat ? this.converter.ippFormat(format) : format, copies: job.copies,
          duplex: d.printer.duplex && parts.length === 1 ? job.duplex : undefined, color, ...this._mediaOf(d, job),
        });
      } catch (err) {
        if (i > 0) { await this._finish(t, { state: 'failed', error: 'printer_rejected', message: `page ${i + 1}: ${err.code || err.message}`.slice(0, 200) }); return { done: true }; }
        if (this._certProblem(d, err)) await this._wait(t, 'cert_changed');
        else await this._wait(t, 'printer_offline', err.code || err.message);
        return { done: true };
      }
      if (i === 0 && this.ipp.RETRY_STATUS.has(res.status)) { await this._wait(t, 'printer_busy', `IPP 0x${res.status.toString(16)}`); return { done: true }; }
      if (i === 0 && res.status === this.ipp.STATUS.FORMAT_NOT_SUPPORTED) return { formatRefused: true, converted: format !== convertLib.PDF };
      if (res.status >= 0x0400) {
        await this._finish(t, { state: 'failed', error: 'printer_rejected', message: `IPP 0x${res.status.toString(16)}${i ? ` (page ${i + 1})` : ''}` });
        return { done: true };
      }
      jobId = res.jobId;
      if (i === 0 && parts.length > 1) { this.journal.set(job.id, { at: this.now(), ippJobId: jobId }); this._persist(); }
    }
    return { jobId };
  }

  /** Papier und Fach des Auftrags, soweit der Drucker sie nennt (sonst nichts: er nimmt sein Standardpapier). */
  _mediaOf(d, job) {
    const m = (d.printer && d.printer.media) || {};
    const out = {};
    if (job.media && (m.sizes || []).includes(job.media)) out.media = job.media;
    if (job.source && (m.sources || []).includes(job.source)) out.source = job.source;
    return out;
  }

  /** Was der Drucker gerade hindert (Papier leer, Klappe offen …) → Schlüsselwort oder null. */
  async _stopReason(d) {
    try {
      const a = this.ipp.printerInfo(await this.ipp.getPrinterAttributes(d.ipp, { timeoutMs: 8_000 }));
      for (const r of a.reasons || []) {
        const k = String(r).replace(/-(error|warning|report)$/, '');
        if (STOP_REASONS.includes(k)) return k;
      }
      return a.state === 'stopped' ? 'stopped' : null;
    } catch (_e) { return null; }
  }

  /**
   * Auf das Ende beim Drucker warten → Endzustand. Ohne Antwort: fertig, aber unbestätigt.
   * Hält der Drucker an (Papier leer, Klappe offen, angehalten), geht der Grund als
   * `printing` + message an den Server – die Apps zeigen ihn (docs/print.md „Zustände“).
   */
  async _watch(d, jobId, id = null) {
    if (!Number.isInteger(jobId)) return { state: 'done', message: 'unconfirmed' };
    const until = this.now() + this.jobWatchMs;
    let errors = 0;
    let said = null;
    while (this.now() < until && this.cfg.enabled) {
      await new Promise((r) => { const x = setTimeout(r, this.jobPollMs); if (x.unref) x.unref(); });
      let s;
      try { s = await this.ipp.getJobAttributes(d.ipp, jobId, { timeoutMs: 10_000 }); errors = 0; } catch (_e) {
        if (++errors >= 3) return { state: 'done', ippJobId: jobId, message: 'unconfirmed' };
        continue;
      }
      if (id && (s.state === 'stopped' || s.state === 'held' || s.state === 'processing')) {
        const why = s.state === 'held' ? 'held' : (s.state === 'stopped' || (s.reasons || []).some((r) => /stopped/.test(r)) ? await this._stopReason(d) : null);
        if (why !== said) {
          said = why;
          await this._state(id, { state: 'printing', ippJobId: jobId, ...(why ? { message: why } : {}) });
        }
      }
      if (s.state === 'completed') return { state: 'done', ippJobId: jobId };
      if (s.state === 'canceled') return { state: 'failed', ippJobId: jobId, error: 'canceled_at_printer' };
      if (s.state === 'aborted') return { state: 'failed', ippJobId: jobId, error: 'aborted_at_printer', message: (s.reasons || []).join(', ').slice(0, 200) || null };
    }
    return { state: 'done', ippJobId: jobId, message: 'unconfirmed' };
  }

  // ─── Scans ────────────────────────────────────────────────────────────

  /** Mgmt „Scannen“ → 'accepted' | 'invalid' | 'unknown_device' | 'busy' | 'disabled' */
  requestScan(b) {
    if (!this.cfg.enabled) return 'disabled';
    const o = b && typeof b === 'object' ? b : {};
    if (typeof o.scanId !== 'string' || !ID_RE.test(o.scanId) || typeof o.deviceId !== 'string') return 'invalid';
    const d = this.devices.get(o.deviceId);
    if (!d || !d.escl || !this.isAllowed(d.ip)) return 'unknown_device';
    if (this.busy.has(d.id) || this.scans.has(o.scanId)) return 'busy';
    const opts = {
      source: o.source === 'feeder' ? 'feeder' : 'platen',
      color: SCAN_MODES.includes(o.color) ? o.color : 'gray',
      resolution: Number.isInteger(o.resolution) && o.resolution >= 75 && o.resolution <= 1200 ? o.resolution : 300,
      format: SCAN_FORMATS.includes(o.format) ? o.format : 'image/jpeg',
      duplex: o.duplex === true,
    };
    const abort = new AbortController();
    this.scans.set(o.scanId, { abort, deviceId: d.id });
    this.busy.add(d.id);
    void this._scan(o.scanId, d, opts, abort).finally(() => { this.scans.delete(o.scanId); this.busy.delete(d.id); });
    return 'accepted';
  }

  cancelScan(scanId) {
    const s = this.scans.get(scanId);
    if (!s) return 'accepted';
    s.abort.abort();
    return 'accepted';
  }

  /** Was der Scanner kann → die passenden Einstellungen. */
  static settingsFor(caps, opts) {
    const source = opts.source === 'feeder' && caps.feeder ? 'feeder' : (caps.platen ? 'platen' : 'feeder');
    const order = { bw: ['bw', 'gray', 'color'], gray: ['gray', 'color', 'bw'], color: ['color', 'gray', 'bw'] }[opts.color];
    let color = order.find((c) => caps.color.includes(c)) || 'color';
    // JPEG kennt kein Schwarz-Weiß mit 1 Bit
    if (color === 'bw' && opts.format === 'image/jpeg' && caps.color.includes('gray')) color = 'gray';
    const res = caps.resolutions.slice().sort((a, b) => a - b);
    const resolution = res.filter((r) => r <= opts.resolution).pop() || res[0] || 300;
    const format = caps.formats.includes(opts.format) ? opts.format : (caps.formats.includes('image/jpeg') ? 'image/jpeg' : caps.formats[0] || 'image/jpeg');
    return { source, color, resolution, format, duplex: source === 'feeder' && caps.duplex && opts.duplex, maxW: caps.maxW, maxH: caps.maxH };
  }

  async _scan(scanId, d, opts, abort) {
    const report = (body) => this.reporter.post(SCAN_PATH(scanId), body);
    try {
      fs.mkdirSync(this._tmpDir(), { recursive: true, mode: 0o700 });
      const caps = d.scanner && d.scanner.caps ? d.scanner.caps : await this.escl.capabilities(d.escl, { timeoutMs: 10_000 });
      d.scanner = { ...(d.scanner || {}), caps, state: 'processing' };
      const settings = PrintService.settingsFor(caps, opts);
      await report({ state: 'scanning', pages: 0, source: settings.source, color: settings.color, resolution: settings.resolution });
      const tmp = (n) => path.join(this._tmpDir(), `${scanId}-${n}.page`);
      const r = await this.escl.scan(d.escl, settings, {
        signal: abort.signal,
        tmpFile: tmp,
        onPage: async (file, { n, mime, bytes }) => {
          try { await this.client.page(scanId, n, file, mime, bytes); } finally { fs.rmSync(file, { force: true }); }
          await report({ state: 'scanning', pages: n });
        },
      });
      if (!r.pages) await report({ state: 'failed', pages: 0, error: settings.source === 'feeder' ? 'feeder_empty' : 'no_pages' });
      else await report({ state: 'done', pages: r.pages });
    } catch (err) {
      this._certProblem(d, err);
      const code = err.code === 'aborted' ? 'canceled' : (['scanner_busy', 'feeder_empty', 'too_large', 'timeout', 'cert_changed'].includes(err.code) ? err.code : 'scan_failed');
      logger.warn({ err: err.code || err.message, device: d.id }, 'print: scan failed');
      await report({ state: 'failed', error: code, message: String(err.message || '').slice(0, 200) });
    } finally {
      if (d.scanner) d.scanner.state = 'idle';
    }
  }

  // ─── Texterkennung (durchsuchbares PDF) ───────────────────────────────

  /**
   * Mgmt „Texterkennung“ { ocrId, pages, dpi? } → 'accepted' | 'invalid' | 'busy' | 'unavailable' | 'disabled'.
   * Die Seiten holt das Gateway beim Server (GET …/ocr/<id>/pages/<n>), das Ergebnis geht als PDF und Text zurück.
   */
  requestOcr(b) {
    if (!this.cfg.enabled || !this.cfg.ocr) return 'disabled';
    const o = b && typeof b === 'object' ? b : {};
    if (typeof o.ocrId !== 'string' || !ID_RE.test(o.ocrId) || !Number.isInteger(o.pages) || o.pages < 1 || o.pages > 100) return 'invalid';
    if (!this.ocr.available()) return 'unavailable';
    if ((this.ocrRunning && this.ocrRunning.id === o.ocrId) || this.ocrQueue.some((x) => x.id === o.ocrId)) return 'accepted';
    if (this.ocrQueue.length >= OCR_QUEUE_MAX) return 'busy';
    const dpi = Number.isInteger(o.dpi) && o.dpi >= 70 && o.dpi <= 1200 ? o.dpi : 300;
    this.ocrQueue.push({ id: o.ocrId, pages: o.pages, dpi, abort: new AbortController() });
    void this._ocrPump();
    return 'accepted';
  }

  cancelOcr(id) {
    const q = this.ocrQueue.findIndex((x) => x.id === id);
    if (q >= 0) this.ocrQueue.splice(q, 1);
    if (this.ocrRunning && this.ocrRunning.id === id) this.ocrRunning.abort.abort();
    return 'accepted';
  }

  _dropOcr(code) {
    for (const x of this.ocrQueue.splice(0)) void this.reporter.post(OCR_PATH(x.id), { state: 'failed', error: code });
    if (this.ocrRunning) this.ocrRunning.abort.abort();
  }

  /** Eine nach der anderen (schont schwache Geräte wie den Raspberry Pi). */
  async _ocrPump() {
    if (this.ocrRunning) return;
    while (this.ocrQueue.length && this.cfg.enabled) {
      this.ocrRunning = this.ocrQueue.shift();
      try { await this._ocrRun(this.ocrRunning); } finally { this.ocrRunning = null; }
    }
  }

  async _ocrRun(job) {
    const report = (body) => this.reporter.post(OCR_PATH(job.id), body);
    const dir = path.join(this._tmpDir(), `ocr-${job.id}`);
    let page = 0;
    const beat = setInterval(() => { void report({ state: 'running', page, pages: job.pages }); }, this.ocrBeatMs);
    if (beat.unref) beat.unref();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      await report({ state: 'running', page: 0, pages: job.pages });
      const files = [];
      for (let n = 1; n <= job.pages; n++) {
        if (job.abort.signal.aborted) throw Object.assign(new Error('canceled'), { code: 'canceled' });
        const f = path.join(dir, `page-${n}.img`);
        try { await this.client.ocrPage(job.id, n, f); } catch (err) {
          throw Object.assign(new Error(err.message), { code: err.code === 'not_found' ? 'canceled' : 'download_failed' });
        }
        files.push(f);
      }
      const r = await this.ocr.recognize(files, {
        dir, dpi: job.dpi, signal: job.abort.signal,
        onPage: async (n) => { page = n; await report({ state: 'running', page: n, pages: job.pages }); },
      });
      try {
        await this.client.ocrResult(job.id, 'document', r.pdf, 'application/pdf');
        if (r.text) {
          const tf = path.join(dir, 'ocr.txt');
          fs.writeFileSync(tf, r.text, { mode: 0o600 });
          await this.client.ocrResult(job.id, 'text', tf, 'text/plain; charset=utf-8');
        }
      } catch (err) {
        throw Object.assign(new Error(err.message), { code: err.code === 'not_found' ? 'canceled' : 'upload_failed' });
      }
      await report({ state: 'done', page: r.pages, pages: r.pages });
      logger.info({ ocr: job.id, pages: r.pages, chars: r.text.length }, 'print: text recognised');
    } catch (err) {
      const code = ['canceled', 'ocr_timeout', 'ocr_unavailable', 'download_failed', 'upload_failed'].includes(err.code) ? err.code : 'ocr_failed';
      if (code !== 'canceled') logger.warn({ ocr: job.id, err: err.code || err.message }, 'print: text recognition failed');
      await report({ state: 'failed', error: code, page, pages: job.pages });
    } finally {
      clearInterval(beat);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ─── Telemetrie ───────────────────────────────────────────────────────

  featureTelemetry() {
    const list = [...this.devices.values()];
    return this.status.snapshot({
      state: this.cfg.enabled ? 'running' : 'off',
      devices: list.filter((d) => d.ipp || d.escl).length,
      printers: list.filter((d) => d.ipp).length,
      scanners: list.filter((d) => d.escl).length,
      queue: this.jobs.size,
      lastSearchAt: this.lastSearchAt,
      search: this.lastSearch,
      // PDF für Drucker ohne PDF umwandeln: eingeschaltet (features.print.convert) und Werkzeug im Image
      convert: { enabled: this.cfg.convert !== false, available: this.converter.available() },
      // Texterkennung (features.print.ocr): tesseract und Sprachen im Image, läuft / wartet
      ocr: { enabled: this.cfg.ocr === true, available: this.ocr.available(), langs: this.ocr.probe().langs, running: !!this.ocrRunning, queued: this.ocrQueue.length },
      // Office-Dateien drucken (features.print.office): Dienst office managed | absent | missing
      office: this.office.snapshot(),
    });
  }
}

module.exports = { PrintService, DEVICES_PATH };
