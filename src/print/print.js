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
const { makePrintClient, ID_RE } = require('./serverClient');
const { isRfc1918 } = require('./config');

const DEVICES_PATH = '/api/v1/gateway/print/devices';
const JOB_PATH = (id) => `/api/v1/gateway/print/jobs/${id}`;
const SCAN_PATH = (id) => `/api/v1/gateway/print/scans/${id}`;
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
const MANUAL_IPP = [631];
const MANUAL_ESCL = [{ scheme: 'http', port: 80 }, { scheme: 'https', port: 443 }];

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
    browse = discovery.browse, ipp = ippLib, escl = esclLib, now = Date.now,
    cycleMs = CYCLE_MS, jobsMs = JOBS_MS, retryMs = RETRY_MS, jobPollMs = JOB_POLL_MS, jobWatchMs = JOB_WATCH_MS, browseMs = 4000,
  }) {
    Object.assign(this, { reporter, stateDir, getSubnets, browse, ipp, escl, now, retryMs, jobPollMs, jobWatchMs, browseMs });
    this.client = client || makePrintClient({ serverUrl, apiToken });
    this.status = new FeatureStatus(now);
    this.cfg = { enabled: false, manual: [] };
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
      ipp: d.ipp, escl: d.escl, hints: d.hints, seenAt: d.seenAt, printer: d.printer, scanner: d.scanner,
    }));
    writeJson(this.stateDir, STATE_FILE, { devices });
    const cut = this.now() - JOURNAL_MS;
    for (const [k, v] of this.journal) if (v.at < cut) this.journal.delete(k);
    writeJson(this.stateDir, JOURNAL_FILE, Object.fromEntries(this.journal));
  }

  async apply(cfg) {
    const prev = this.cfg;
    this.cfg = cfg;
    this.status.setEnabled(cfg.enabled);
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
    }
  }

  _shutdown() {
    this.cycleLoop.stop();
    this.jobsLoop.stop();
    for (const s of this.scans.values()) s.abort.abort();
    this.scans.clear();
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

  /** Mgmt „Neu suchen“ */
  requestSearch() {
    if (!this.cfg.enabled) return 'disabled';
    if (this.searching) return 'busy';
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
      for (const s of this.getSubnets()) {
        if (!s.localIp) continue;
        packets.push(...await this.browse({ ifaceIp: s.localIp, timeoutMs: this.browseMs }));
      }
      const found = discovery.mergeDevices(discovery.mapServices(packets), (ip) => this.isAllowed(ip));
      const now = this.now();
      for (const f of found) this._merge(f, 'mdns', now);
      for (const ip of this.cfg.manual) {
        if (found.some((f) => f.ip === ip)) continue;
        const m = await this._probeManual(ip);
        if (m) this._merge(m, 'manual', now);
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
    Object.assign(d, {
      id: f.id, uuid: f.uuid || null, ip: f.ip, name: f.name || (old && old.name) || f.ip, model: f.model || (old && old.model) || '',
      location: f.location || (old && old.location) || '', source, ipp: f.ipp || (old && old.ipp) || null, escl: f.escl || (old && old.escl) || null,
      hints: f.hints || {}, seenAt: now,
    });
    this.devices.set(d.id, d);
  }

  async _probeManual(ip) {
    let ipp = null;
    let escl = null;
    let info = null;
    for (const port of MANUAL_IPP) {
      for (const p of ['ipp/print', '']) {
        const ep = { scheme: 'ipp', host: ip, port, path: p };
        try { info = this.ipp.printerInfo(await this.ipp.getPrinterAttributes(ep, { timeoutMs: 5_000 })); ipp = ep; break; } catch (_e) { /* nächster */ }
      }
      if (ipp) break;
    }
    for (const c of MANUAL_ESCL) {
      const ep = { scheme: c.scheme, host: ip, port: c.port, path: 'eSCL' };
      try { await this.escl.capabilities(ep, { timeoutMs: 5_000 }); escl = ep; break; } catch (_e) { /* nächster */ }
    }
    if (!ipp && !escl) return null;
    const uuid = info && info.uuid ? discovery.normUuid(info.uuid) : null;
    return { id: discovery.deviceId(uuid, ip), uuid, ip, name: (info && info.name) || ip, model: (info && info.model) || '', location: (info && info.location) || '', ipp, escl, hints: {} };
  }

  async refreshAll() {
    for (const d of [...this.devices.values()]) {
      if (this.busy.has(d.id)) continue; // mitten im Druck/Scan nicht dazwischenfragen
      await this.refresh(d);
    }
  }

  async refresh(d) {
    let ok = false;
    if (d.ipp) {
      try {
        const info = this.ipp.printerInfo(await this.ipp.getPrinterAttributes(d.ipp, { timeoutMs: 8_000 }));
        d.printer = printerPart(info);
        if (info.model && !d.model) d.model = info.model;
        if (info.location && !d.location) d.location = info.location;
        ok = true;
      } catch (_e) {
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
      } catch (_e) {
        d.scanner = d.scanner ? { ...d.scanner, state: 'offline' } : null;
      }
    }
    d.online = ok;
    if (ok) d.seenAt = this.now();
  }

  /** Öffentliche Sicht eines Geräts (Vertrag §2) – ohne Endpunkte. */
  _view(d) {
    const p = d.printer;
    const s = d.scanner;
    return {
      id: d.id, name: d.name, model: d.model || null, ip: d.ip, location: d.location || null, source: d.source || 'mdns',
      online: !!d.online, seenAt: d.seenAt || null,
      printer: d.ipp && p ? { state: p.state, reasons: p.reasons || [], color: !!p.color, duplex: !!p.duplex, formats: p.formats || [], copiesMax: p.copiesMax || 1, markers: p.markers || [] } : null,
      scanner: d.escl && s && s.caps ? {
        state: s.state || 'idle', platen: !!s.caps.platen, feeder: !!s.caps.feeder, duplex: !!s.caps.duplex,
        color: s.caps.color, resolutions: s.caps.resolutions, formats: s.caps.formats, adf: s.adf || null,
      } : null,
    };
  }

  devicesView() { return [...this.devices.values()].filter((d) => d.ipp || d.escl).map((d) => this._view(d)); }

  async report(force = false) {
    if (!this.cfg.enabled) return;
    const devices = this.devicesView();
    const sig = JSON.stringify(devices.map((x) => ({ ...x, seenAt: null })));
    if (!force && sig === this.lastReported && this.now() - this.lastReportAt < REPORT_MS) return;
    const r = await this.reporter.post(DEVICES_PATH, { scannedAt: this.lastSearchAt, devices });
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
    const fmts = d.printer && Array.isArray(d.printer.formats) ? d.printer.formats : [];
    if (fmts.length && !fmts.includes(job.format) && !fmts.includes('application/octet-stream')) {
      return this._finish(t, { state: 'failed', error: 'format_unsupported' });
    }
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
      // erreichbar und nimmt Aufträge an? (weckt viele Drucker aus dem Standby)
      try {
        const a = this.ipp.printerInfo(await this.ipp.getPrinterAttributes(d.ipp, { timeoutMs: 15_000 }));
        d.printer = printerPart(a);
        d.online = true;
        if (!a.accepting) return this._wait(t, 'printer_not_accepting');
      } catch (err) {
        if (d.printer) d.printer.state = 'offline';
        return this._wait(t, 'printer_offline', err.code || err.message);
      }
      await this._state(job.id, { state: 'sending' });
      let res;
      try {
        res = await this.ipp.printJob(d.ipp, file, job.size, { name: job.name, user: job.user, format: job.format, copies: job.copies, duplex: d.printer.duplex ? job.duplex : undefined, color: job.color });
      } catch (err) {
        return this._wait(t, 'printer_offline', err.code || err.message);
      }
      if (this.ipp.RETRY_STATUS.has(res.status)) return this._wait(t, 'printer_busy', `IPP 0x${res.status.toString(16)}`);
      if (res.status === this.ipp.STATUS.FORMAT_NOT_SUPPORTED) return this._finish(t, { state: 'failed', error: 'format_unsupported' });
      if (res.status >= 0x0400) return this._finish(t, { state: 'failed', error: 'printer_rejected', message: `IPP 0x${res.status.toString(16)}` });
      this.journal.set(job.id, { at: this.now(), ippJobId: res.jobId });
      this._persist();
      this._dropFile(job.id);
      await this._state(job.id, { state: 'printing', ippJobId: res.jobId });
      return this._finish(t, await this._watch(d, res.jobId));
    } finally {
      t.running = false;
      this.busy.delete(d.id);
    }
  }

  /** Auf das Ende beim Drucker warten → Endzustand. Ohne Antwort: fertig, aber unbestätigt. */
  async _watch(d, jobId) {
    if (!Number.isInteger(jobId)) return { state: 'done', message: 'unconfirmed' };
    const until = this.now() + this.jobWatchMs;
    let errors = 0;
    while (this.now() < until && this.cfg.enabled) {
      await new Promise((r) => { const x = setTimeout(r, this.jobPollMs); if (x.unref) x.unref(); });
      let s;
      try { s = await this.ipp.getJobAttributes(d.ipp, jobId, { timeoutMs: 10_000 }); errors = 0; } catch (_e) {
        if (++errors >= 3) return { state: 'done', ippJobId: jobId, message: 'unconfirmed' };
        continue;
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
      const code = err.code === 'aborted' ? 'canceled' : (['scanner_busy', 'feeder_empty', 'too_large', 'timeout'].includes(err.code) ? err.code : 'scan_failed');
      logger.warn({ err: err.code || err.message, device: d.id }, 'print: scan failed');
      await report({ state: 'failed', error: code, message: String(err.message || '').slice(0, 200) });
    } finally {
      if (d.scanner) d.scanner.state = 'idle';
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
    });
  }
}

module.exports = { PrintService, DEVICES_PATH };
