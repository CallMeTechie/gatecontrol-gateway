'use strict';

// Anwesenheit über das Heimnetz (Vertrag Phase 3a, Abschnitt 3): die vom
// Server freigegebenen MACs jede Minute gezielt prüfen und Übergänge melden.
// Lebenszeichen: Eintrag REACHABLE in der Nachbartabelle, sonst kurze
// Unicast-Prüfung der bekannten Adresse (mDNS-Anfrage → Kernel prüft per
// Unicast-ARP nach; schlafende iPhones antworten darauf meist, auf Ping
// nicht). Ohne bekannte Adresse höchstens alle 10 Min. ein Sweep.
// „offline“ erst nach `awayAfterSec` (Standard 600 s) ohne Lebenszeichen.

const logger = require('../logger');
const { FeatureStatus, loop } = require('../features/status');
const { hostsFor } = require('../netwatch/netwatch');

const INTERVAL_MS = 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;
const MAX_QUEUE = 256;
const REPORT_PATH = '/api/v1/gateway/presence';

class Presence {
  constructor({
    scanner, reporter, knownIp = () => null, getSubnets = () => [], maxPrefix = 22, ownSweep = () => true,
    now = Date.now, intervalMs = INTERVAL_MS, sweepEveryMs = SWEEP_EVERY_MS,
  }) {
    Object.assign(this, { scanner, reporter, knownIp, getSubnets, maxPrefix, ownSweep, now, sweepEveryMs });
    this.status = new FeatureStatus(now);
    this.cfg = { enabled: false, macs: [], awayAfterSec: 600 };
    this.state = new Map();   // mac → { online: bool|null, lastSeen: ms|null, since: ms }
    this.ipCache = new Map(); // mac → ip (zuletzt gesehen)
    this.queue = [];
    this.lastSweepAt = 0;
    this.busy = false;
    this.loop = loop(() => this.tick(), () => intervalMs);
  }

  apply({ enabled, macs = [], awayAfterSec = 600 }) {
    const was = this.cfg.enabled;
    this.cfg = { enabled: !!enabled, macs: enabled ? macs.slice() : [], awayAfterSec };
    this.status.setEnabled(this.cfg.enabled);
    const want = new Set(this.cfg.macs);
    for (const mac of [...this.state.keys()]) if (!want.has(mac)) { this.state.delete(mac); this.ipCache.delete(mac); }
    for (const mac of want) if (!this.state.has(mac)) this.state.set(mac, { online: null, lastSeen: null, since: this.now() });
    if (!this.cfg.enabled) this.queue = []; // abgeschaltet: nichts mehr melden
    if (this.cfg.enabled && !was) this.loop.start(5_000);
    else if (!this.cfg.enabled && was) this.loop.stop();
  }

  stop() { this.loop.stop(); }

  async _detect(macs) {
    const seen = new Set();
    const tracked = new Set(macs);
    const neigh = await this.scanner.readNeighbors();
    const ipsByMac = new Map();
    for (const e of neigh) {
      if (!e.mac || !tracked.has(e.mac)) continue;
      if (e.state === 'REACHABLE') seen.add(e.mac);
      if (!ipsByMac.has(e.mac)) ipsByMac.set(e.mac, new Set());
      ipsByMac.get(e.mac).add(e.ip);
      this.ipCache.set(e.mac, e.ip);
    }
    const probeIps = new Set();
    for (const mac of macs) {
      if (seen.has(mac)) continue;
      const ips = ipsByMac.get(mac) || new Set();
      for (const ip of [this.ipCache.get(mac), this.knownIp(mac)]) if (ip) ips.add(ip);
      for (const ip of ips) probeIps.add(ip);
    }
    if (probeIps.size) {
      const r = await this.scanner.probe([...probeIps]);
      for (const [ip, mac] of r.online) if (tracked.has(mac)) { seen.add(mac); this.ipCache.set(mac, ip); }
    }
    const missing = macs.filter((m) => !seen.has(m));
    // Eigener Sweep nur, wenn der Netzwerk-Wächter nicht ohnehin alle 5 Min. sucht (knownIp ist dann frisch).
    if (missing.length && this.ownSweep() && this.now() - this.lastSweepAt >= this.sweepEveryMs) {
      this.lastSweepAt = this.now();
      for (const sn of this.getSubnets() || []) {
        const hosts = hostsFor(sn.cidr, { maxPrefix: this.maxPrefix, localIp: sn.localIp });
        if (!hosts.length) continue;
        const r = await this.scanner.sweep(hosts, { bindIp: sn.localIp || undefined });
        for (const [ip, mac] of r.online) if (tracked.has(mac)) { seen.add(mac); this.ipCache.set(mac, ip); }
      }
    }
    return seen;
  }

  /** Zustände fortschreiben → neue Ereignisse. Rein (ohne Netz), für Tests. */
  transitions(seen, now) {
    const events = [];
    const awayMs = this.cfg.awayAfterSec * 1000;
    for (const [mac, st] of this.state) {
      if (seen.has(mac)) {
        st.lastSeen = now;
        if (st.online !== true) { st.online = true; events.push({ mac, online: true, at: now, lastSeen: now }); }
      } else if (st.online !== false && now - (st.lastSeen ?? st.since) >= awayMs) {
        st.online = false;
        events.push({ mac, online: false, at: now, lastSeen: st.lastSeen });
      }
    }
    return events;
  }

  async _flush() {
    if (!this.queue.length) return;
    const batch = this.queue.slice(0, MAX_QUEUE);
    const res = await this.reporter.post(REPORT_PATH, { events: batch });
    if (!res.ok) throw new Error(`report failed${res.status ? `: HTTP ${res.status}` : `: ${res.error}`}`);
    this.queue.splice(0, batch.length);
  }

  async tick() {
    if (!this.cfg.enabled || this.busy) return;
    this.busy = true;
    this.status.start();
    try {
      const macs = [...this.state.keys()];
      const seen = macs.length ? await this._detect(macs) : new Set();
      const events = this.transitions(seen, this.now());
      if (events.length) {
        this.queue.push(...events);
        if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
      }
      await this._flush();
      this.status.ok();
    } catch (err) {
      this.status.fail(err);
      logger.warn({ err: err.message }, 'presence: check failed');
    } finally {
      this.busy = false;
    }
  }

  telemetry() {
    let home = 0;
    for (const st of this.state.values()) if (st.online === true) home++;
    return this.status.snapshot({ running: this.busy, tracked: this.state.size, home, pending: this.queue.length });
  }
}

module.exports = { Presence, REPORT_PATH };
