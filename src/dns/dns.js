'use strict';

// DNS-Filter fürs Heimnetz (Vertrag Phase 3b §1): eigener DNS-Server auf den
// LAN-Adressen, Profile per MAC, Listen, Zeiten, Pausen, sichere Suche,
// Weiterleitung per DoH mit Rückfall Router, Statistik alle 5 Min.

const fs = require('node:fs');
const logger = require('../logger');
const { FeatureStatus, loop } = require('../features/status');
const { normalizeMac } = require('../features/macs');
const { cleanDomain } = require('./domainSet');
const { Policy } = require('./policy');
const { Resolver, MAX_LOG } = require('./resolver');
const { Upstream } = require('./upstream');
const { NeighborCache } = require('./neighbors');
const { DnsStats } = require('./stats');
const { DnsListener, lanListenAddresses } = require('./server');
const { ListManager } = require('./lists');
const { ResponseCache } = require('./responseCache');

const REPORT_PATH = '/api/v1/gateway/dns';
const REPORT_MS = 5 * 60_000;
const LISTEN_MS = 60_000;
const LISTS_MS = 10 * 60_000;

/** Suchdomänen aus /etc/resolv.conf (z. B. fritz.box) – gelten als lokal. */
function searchDomains(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(search|domain)\s+(\S.*)$/.exec(line);
    if (!m) continue;
    for (const d of m[2].trim().split(/\s+/)) {
      const c = cleanDomain(d, { allowSingleLabel: true });
      if (c && out.length < 8) out.push(c);
    }
  }
  return out;
}

function readSearchDomains() {
  try { return searchDomains(fs.readFileSync('/etc/resolv.conf', 'utf8')); } catch (_e) { return []; }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_e) { return null; }
}

class DnsFilter {
  constructor({
    reporter, stateDir, serverUrl = null, routerIp = () => null, tunnelIp = null,
    port = 53, addresses = null, neighbors = new NeighborCache(), lists = null, upstreamFactory = null,
    now = Date.now, localSuffixes = readSearchDomains(), reportMs = REPORT_MS, listenMs = LISTEN_MS, listsMs = LISTS_MS,
  }) {
    Object.assign(this, { reporter, stateDir, routerIp, now, neighbors });
    this.serverHost = hostOf(serverUrl);
    this.localSuffixes = localSuffixes;
    this.status = new FeatureStatus(now);
    this.cfg = { enabled: false };
    this.stats = new DnsStats({ now });
    this.cache = new ResponseCache({ now });
    this.lists = lists || new ListManager({ stateDir, now, onChange: () => this._rebuildPolicy() });
    if (lists) lists.onChange = () => this._rebuildPolicy();
    this.upstreamFactory = upstreamFactory || ((up) => new Upstream({ upstream: up, routerIp }));
    this.upstream = null;
    this.upstreamKey = null;
    this.policy = new Policy({ alwaysAllow: [], categories: {}, profiles: [], defaultProfile: null, pauses: [], extensions: [] });
    this.resolver = new Resolver({
      getPolicy: () => this.policy,
      upstream: { query: (w, o) => this.upstream.query(w, o), local: (w, o) => this.upstream.local(w, o) },
      neighbors,
      stats: this.stats,
      now,
      cache: this.cache,
      blockResponse: () => this.cfg.blockResponse || 'zero',
      logEnabled: () => this.cfg.enabled && this.cfg.logQueries === true,
    });
    const exclude = tunnelIp ? [tunnelIp] : [];
    this.listener = new DnsListener({
      handle: (m, o) => this.resolver.handle(m, o),
      port,
      addresses: addresses || (() => lanListenAddresses({ exclude })),
    });
    this.listen = { state: 'off', listen: [], busy: [], failed: {}, port };
    this.lastReportAt = null;
    this.reportError = null;
    this.listenLoop = loop(() => this._reconcile(), () => listenMs);
    this.listsLoop = loop(() => this._refreshLists(), () => listsMs);
    this.reportLoop = loop(() => this.report(), () => reportMs);
  }

  _rebuildPolicy() {
    if (!this.cfg.enabled) return;
    this.policy = new Policy(this.cfg, {
      lists: this.lists.lists,
      extraAllow: this.serverHost ? [this.serverHost] : [],
      localSuffixes: this.localSuffixes,
    });
  }

  async apply(cfg) {
    const was = this.cfg.enabled;
    this.cfg = cfg;
    this.status.setEnabled(cfg.enabled);
    if (!cfg.enabled) {
      if (was) this._shutdown();
      return;
    }
    if (!cfg.logQueries) this.resolver.clearLog();
    const key = JSON.stringify(cfg.upstream);
    if (key !== this.upstreamKey) {
      if (this.upstream) this.upstream.close();
      this.upstream = this.upstreamFactory(cfg.upstream);
      this.upstreamKey = key;
      this.cache.clear();
    }
    this._rebuildPolicy();
    const used = new Set(cfg.profiles.flatMap((p) => p.lists));
    try { await this.lists.setWanted(cfg.lists, used); } catch (err) { logger.warn({ err: err.message }, 'dns: lists'); }
    this._rebuildPolicy();
    if (!was) {
      this.listen.state = 'starting';
      this.listenLoop.start(0);
      this.listsLoop.start(5_000);
      this.reportLoop.start(REPORT_MS);
    } else {
      this.listsLoop.start(1_000);
    }
  }

  _shutdown() {
    this.listenLoop.stop();
    this.listsLoop.stop();
    this.reportLoop.stop();
    this.listener.close();
    if (this.upstream) this.upstream.close();
    this.upstream = null;
    this.upstreamKey = null;
    this.cache.clear();
    this.resolver.clearLog();
    this.listen = { state: 'off', listen: [], busy: [], failed: {}, port: this.listener.port };
    void this.report();
  }

  stop() {
    if (this.cfg.enabled) {
      this.listenLoop.stop();
      this.listsLoop.stop();
      this.reportLoop.stop();
      this.listener.close();
      if (this.upstream) this.upstream.close();
    }
  }

  async _reconcile() {
    if (!this.cfg.enabled) return;
    const prev = this.listen.state;
    this.listen = await this.listener.reconcile();
    if (this.listen.state !== prev) logger.info({ state: this.listen.state, listen: this.listen.listen, busy: this.listen.busy }, 'dns: listener');
  }

  async _refreshLists() {
    if (!this.cfg.enabled) return;
    this.status.start();
    await this.lists.refreshDue();
    const errs = Object.entries(this.lists.telemetry()).filter(([, v]) => v.error && !v.loaded);
    if (errs.length) this.status.fail(`list ${errs[0][0]}: ${errs[0][1].error.code}`); else this.status.ok();
  }

  /** 5-Min.-Bericht; scheitert er, kommt der Zeitraum in den nächsten. */
  async report() {
    const { body, period } = this.stats.take();
    if (!body.queries && !this.cfg.enabled) return;
    const r = await this.reporter.post(REPORT_PATH, body);
    if (r.ok) { this.lastReportAt = this.now(); this.reportError = null; } else {
      this.reportError = { at: this.now(), status: r.status };
      this.stats.giveBack(period);
    }
  }

  /** POST /api/dns/test → { profileId, action, reason, … } oder { error } */
  test(domain, mac) {
    const d = cleanDomain(String(domain || ''), { allowSingleLabel: true });
    if (!d) return { error: 'invalid_domain' };
    let m = null;
    if (mac !== undefined && mac !== null && mac !== '') {
      m = normalizeMac(mac);
      if (!m) return { error: 'invalid_mac' };
    }
    const r = this.policy.decide(d, m, this.now());
    const out = { domain: d, profileId: r.profileId, action: r.action, reason: r.reason };
    if (r.list) out.list = r.list;
    if (r.category) out.category = r.category;
    if (r.safeSearch) out.safeSearch = r.safeSearch;
    return out;
  }

  /** GET /api/dns/log → neueste zuerst. */
  queryLog({ limit = 100, mac = null } = {}) {
    const n = Math.max(1, Math.min(MAX_LOG, Number.isInteger(limit) ? limit : 100));
    const want = mac ? normalizeMac(mac) : null;
    const out = [];
    for (let i = this.resolver.log.length - 1; i >= 0 && out.length < n; i--) {
      const e = this.resolver.log[i];
      if (!want || e.mac === want) out.push(e);
    }
    return out;
  }

  featureTelemetry() {
    // Server liest Zustand, Adressen und Listen von hier (Vertrag 3b, Server-Seite 5)
    if (!this.cfg.enabled) return this.status.snapshot({ state: 'off', listen: [], lists: {}, lastReportAt: this.lastReportAt });
    return this.status.snapshot({
      state: this.listen.state,
      listen: this.listen.listen,
      busy: this.listen.busy,
      lists: Object.fromEntries(Object.entries(this.lists.telemetry()).map(([id, v]) => [id, { entries: v.entries, updatedAt: v.updatedAt, error: v.error }])),
      lastReportAt: this.lastReportAt,
    });
  }

  /** Telemetrie `dns` (null wenn aus). */
  telemetry() {
    if (!this.cfg.enabled) return null;
    const up = this.upstream ? this.upstream.state : null;
    return {
      state: this.listen.state,
      port: this.listen.port,
      listen: this.listen.listen,
      busy: this.listen.busy,
      upstream: up ? {
        provider: up.provider, fallbackRouter: this.cfg.upstream.fallbackRouter,
        lastOkAt: up.lastOkAt, lastError: up.lastError, lastFallbackAt: up.lastFallbackAt, fallbacks: up.fallbacks,
        dohDown: up.dohDownUntil > this.now(),
      } : null,
      lists: this.lists.telemetry(),
      listsBytes: this.lists.memoryBytes(),
      cacheEntries: this.cache.size,
      totals: { ...this.stats.total },
      logQueries: this.cfg.logQueries === true,
      lastReportAt: this.lastReportAt,
      reportError: this.reportError,
    };
  }
}

module.exports = { DnsFilter, searchDomains, REPORT_PATH };
