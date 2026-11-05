'use strict';

// Internetqualität (Vertrag Phase 3a, Abschnitt 4): jede Minute Router,
// öffentliche Ziele und Server messen, 5-Min.-Werte bilden, Ausfälle mit
// Ursache erkennen, Speedtests nach Plan oder auf Zuruf. Alles, was noch
// nicht beim Server angekommen ist, liegt in /state/inetq-buffer.json und
// übersteht damit Ausfall und Neustart (bis 7 Tage).

const logger = require('../logger');
const { FeatureStatus, loop } = require('../features/status');
const { readJson, writeJson } = require('../features/persist');
const { nextSpeedtest } = require('../features/schedule');
const { Aggregator, OutageDetector } = require('./aggregate');
const { createPinger, measure: measureReal } = require('./probe');
const { runSpeedtest: runSpeedtestReal } = require('./speedtest');

const STATE_FILE = 'inetq-buffer.json';
const INTERVAL_MS = 60_000;
const FAST_MS = 10_000;
const MAX_SAMPLES = 2016;     // 7 Tage à 5 Min.
const MAX_OUTAGES = 200;
const MAX_SPEEDTESTS = 50;
const SAMPLES_PER_REPORT = 600;
const RETRY_MS = 60_000;
const REPORT_PATH = '/api/v1/gateway/inetq';

const sigOutage = (o) => `${o.start}|${o.end}|${o.cause}`;

function serverTarget(serverUrl) {
  try {
    const u = new URL(serverUrl);
    return { host: u.hostname, port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443) };
  } catch (_e) {
    return null;
  }
}

class InetQuality {
  constructor({
    reporter, serverUrl, apiToken, stateDir, routerIp = () => null,
    measure = measureReal, pinger = createPinger(), speedtest = runSpeedtestReal,
    now = Date.now, rand = Math.random, intervalMs = INTERVAL_MS, fastMs = FAST_MS,
  }) {
    Object.assign(this, { reporter, serverUrl, apiToken, stateDir, routerIp, measure, pinger, speedtest, now, rand });
    this.server = serverTarget(serverUrl);
    this.status = new FeatureStatus(now);
    this.cfg = { enabled: false, speedtest: 'off', targets: [] };
    this.agg = new Aggregator();
    this.samples = [];
    this.outages = new Map(); // start → { start, end, cause } (noch nicht bestätigt)
    this.speedtests = [];
    this.detector = new OutageDetector();
    this.loaded = false;
    this.last = null;
    this.lastSpeedtest = null;
    this.nextSpeedtestAt = null;
    this.speedtestRunning = false;
    this.reporting = false;
    this.lastReportTryAt = 0;
    this.lastReportAt = null;
    this.reportError = null;
    this.dirty = false;
    this.loop = loop(() => this.tick(), () => (this.detector.active ? fastMs : intervalMs));
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    const s = readJson(this.stateDir, STATE_FILE);
    if (!s) return;
    const num = (v) => (Number.isFinite(v) ? v : null);
    if (Array.isArray(s.samples)) {
      this.samples = s.samples.filter((x) => x && Number.isFinite(x.t)).slice(-MAX_SAMPLES).map((x) => ({
        t: x.t, rttRouterMs: num(x.rttRouterMs), rttInetMs: num(x.rttInetMs),
        lossInetPct: num(x.lossInetPct), rttServerMs: num(x.rttServerMs), n: num(x.n) || 0,
      }));
    }
    if (Array.isArray(s.outages)) {
      for (const o of s.outages.slice(-MAX_OUTAGES)) {
        if (o && Number.isFinite(o.start)) this.outages.set(o.start, { start: o.start, end: num(o.end), cause: o.cause === 'router' ? 'router' : 'isp' });
      }
    }
    if (Array.isArray(s.speedtests)) this.speedtests = s.speedtests.filter((x) => x && Number.isFinite(x.at)).slice(-MAX_SPEEDTESTS);
    if (s.open) this.detector = new OutageDetector({ open: s.open });
    if (s.lastSpeedtest && Number.isFinite(s.lastSpeedtest.at)) this.lastSpeedtest = s.lastSpeedtest;
  }

  _persist() {
    if (!this.dirty) return;
    this.dirty = false;
    writeJson(this.stateDir, STATE_FILE, {
      v: 1,
      samples: this.samples,
      outages: [...this.outages.values()],
      speedtests: this.speedtests,
      open: this.detector.open,
      lastSpeedtest: this.lastSpeedtest,
    });
  }

  apply({ enabled, speedtest = 'off', targets = [] }) {
    const was = this.cfg.enabled;
    const planChanged = speedtest !== this.cfg.speedtest;
    this.cfg = { enabled: !!enabled, speedtest, targets: targets.slice() };
    this.status.setEnabled(this.cfg.enabled);
    if (this.cfg.enabled && (planChanged || !was)) this.nextSpeedtestAt = nextSpeedtest(speedtest, this.now(), this.rand);
    if (this.cfg.enabled && !was) {
      this._load();
      this.loop.start(10_000);
    } else if (!this.cfg.enabled && was) {
      this.loop.stop();
      this.dirty = true;
      this._persist();
    }
  }

  stop() {
    this.loop.stop();
    if (this.loaded) { this.dirty = true; this._persist(); }
  }

  _addSample(s) {
    if (!s) return;
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    this.dirty = true;
  }

  _addOutage(o) {
    if (!o) return;
    this.outages.set(o.start, o);
    if (this.outages.size > MAX_OUTAGES) this.outages.delete(this.outages.keys().next().value);
    this.dirty = true;
  }

  /** Eine Runde: messen, aggregieren, Ausfall prüfen, ggf. Speedtest und Bericht anstoßen. */
  async tick() {
    if (!this.cfg.enabled) return;
    this._load();
    const now = this.now();
    let reportNow = false;
    if (!this.speedtestRunning) {
      this.status.start();
      try {
        const m = await this.measure({
          pinger: this.pinger, routerIp: this.routerIp(), targets: this.cfg.targets, server: this.server, now: this.now,
        });
        this.last = m;
        const closed = this.agg.add(m);
        if (closed) { this._addSample(closed); reportNow = true; }
        const changed = this.detector.observe(m);
        if (changed) {
          this._addOutage(changed);
          if (changed.end !== null) reportNow = true;
          logger.info({ outage: changed }, 'inetq: outage state changed');
        }
        this.status.ok();
      } catch (err) {
        this.status.fail(err);
        logger.warn({ err: err.message }, 'inetq: measurement failed');
      }
    } else {
      const closed = this.agg.flush(now);
      if (closed) { this._addSample(closed); reportNow = true; }
    }
    if (this.nextSpeedtestAt !== null && now >= this.nextSpeedtestAt && !this.speedtestRunning) {
      this.nextSpeedtestAt = nextSpeedtest(this.cfg.speedtest, now, this.rand);
      if (!this.detector.active) this._startSpeedtest('schedule');
    }
    this._persist();
    if (reportNow || (this._pending() && now - this.lastReportTryAt >= RETRY_MS)) this._reportAsync();
  }

  _pending() {
    return this.samples.length > 0 || this.outages.size > 0 || this.speedtests.length > 0;
  }

  /** „Jetzt messen“ (Mgmt-API). → 'accepted' | 'busy' | 'disabled' */
  requestSpeedtest() {
    if (!this.cfg.enabled) return 'disabled';
    if (this.speedtestRunning) return 'busy';
    this._startSpeedtest('manual');
    return 'accepted';
  }

  _startSpeedtest(reason) {
    this.speedtestRunning = true;
    const run = async () => {
      let r;
      try {
        r = await this.speedtest({ serverUrl: this.serverUrl, apiToken: this.apiToken, now: this.now });
      } catch (err) {
        r = { at: this.now(), downMbps: null, upMbps: null, bytes: 0, error: String(err.message || err).slice(0, 40) };
      }
      this.lastSpeedtest = r;
      this.speedtests.push(r);
      if (this.speedtests.length > MAX_SPEEDTESTS) this.speedtests.shift();
      this.dirty = true;
      logger.info({ reason, result: r }, 'inetq: speedtest done');
      this.speedtestRunning = false;
      this._persist();
      this._reportAsync();
    };
    run().catch(() => { this.speedtestRunning = false; });
  }

  _reportAsync() {
    if (this.reporting) return;
    this.reporting = true;
    this.report().catch(() => {}).finally(() => { this.reporting = false; });
  }

  /** Gepufferte Werte senden; bestätigte aus dem Puffer nehmen. */
  async report() {
    if (!this._pending()) return true;
    this.lastReportTryAt = this.now();
    const samples = this.samples.slice(0, SAMPLES_PER_REPORT);
    const outages = [...this.outages.values()];
    const speedtests = this.speedtests.slice();
    const res = await this.reporter.post(REPORT_PATH, { samples, outages, speedtests });
    if (!res.ok) {
      this.reportError = { at: this.now(), message: `report failed${res.status ? `: HTTP ${res.status}` : `: ${res.error}`}`.slice(0, 200) };
      return false;
    }
    this.reportError = null;
    this.lastReportAt = this.now();
    const sentT = new Set(samples.map((s) => s.t));
    this.samples = this.samples.filter((s) => !sentT.has(s.t));
    for (const o of outages) {
      const cur = this.outages.get(o.start);
      if (cur && sigOutage(cur) === sigOutage(o)) this.outages.delete(o.start);
    }
    this.speedtests = this.speedtests.filter((s) => !speedtests.includes(s));
    this.dirty = true;
    this._persist();
    if (this.samples.length) return this.report(); // Rest in weiteren Berichten
    return true;
  }

  telemetry() {
    const m = this.last;
    const o = this.detector.open;
    return this.status.snapshot({
      now: m ? {
        at: m.at,
        rttRouterMs: m.rttRouterMs,
        rttInetMs: m.rttInetMs,
        lossInetPct: m.sent > 0 ? Math.round(((m.sent - m.received) / m.sent) * 1000) / 10 : null,
        rttServerMs: m.rttServerMs,
      } : null,
      outage: o ? { start: o.start, cause: o.cause } : null,
      lastReportAt: this.lastReportAt,
      reportError: this.reportError,
      buffered: { samples: this.samples.length, outages: this.outages.size, speedtests: this.speedtests.length },
      speedtestRunning: this.speedtestRunning,
      nextSpeedtestAt: this.cfg.enabled ? this.nextSpeedtestAt : null,
      lastSpeedtest: this.lastSpeedtest,
      probeMode: this.pinger && this.pinger.mode ? this.pinger.mode() : null,
    });
  }
}

module.exports = { InetQuality, serverTarget, REPORT_PATH };
