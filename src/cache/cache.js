'use strict';

// Zwischenspeicher im Heimnetz (Vertrag Phase 3b §2): Vorrat vom Server
// holen, fehlende Blobs laden (eine Datei zur Zeit), LRU bis `maxBytes`,
// signierte Abgabe per HTTPS im LAN, Bestand/Statistik an den Server.

const path = require('node:path');
const { setImmediate: tick, setTimeout: sleep } = require('node:timers/promises');
const logger = require('../logger');
const { FeatureStatus, loop } = require('../features/status');
const { BlobStore, SLICE_MS } = require('./store');
const { makeCacheClient, retryAfterMs } = require('./fetcher');
const { makeHandler, LanBlobServer } = require('./lanServer');
const { loadOrCreate } = require('./selfsigned');
const { lanListenAddresses } = require('../dns/server');

const REPORT_PATH = '/api/v1/gateway/cache';
const SYNC_MS = 15 * 60_000;
const REPORT_MS = 5 * 60_000;
const FULL_EVERY_MS = 6 * 3600_000;
const LISTEN_MS = 60_000;
const RESERVE_BYTES = 512 * 1024 * 1024;   // auf dem Datenträger frei lassen
const MAX_HAVE = 5_000;          // je Bericht und Liste (Server-Grenze)
// Höchstens ~10 Blob-Anfragen je Sekunde (≈ 9 000 je 15 Min., unter dem
// Server-Budget GC_RATE_LIMIT_GATEWAY_CACHE von 10 000): tausende kleine
// Vorschaubilder sollen den Server nicht fluten.
const BLOB_GAP_MS = 100;

const zeroCounters = () => ({ hits: 0, misses: 0, bytesServed: 0, bytesFetched: 0, denied: 0 });

class HomeCache {
  constructor({
    reporter, client = null, serverUrl, apiToken, stateDir, tunnelIp = null,
    addresses = null, now = Date.now, tls = null, syncMs = SYNC_MS, reportMs = REPORT_MS, listenMs = LISTEN_MS, freeBytes = null,
    blobGapMs = BLOB_GAP_MS,
  }) {
    Object.assign(this, { reporter, stateDir, now, blobGapMs });
    this.pausedUntil = 0;          // nach 429: bis dahin kein Abgleich/Bericht
    this.lastBlobAt = 0;
    this.client = client || makeCacheClient({ serverUrl, apiToken });
    this.status = new FeatureStatus(now);
    this.cfg = { enabled: false, requested: false, problem: null };
    this.store = null;
    this.tlsOverride = tls;
    this.tls = null;
    this.freeBytesFn = freeBytes;
    this.counters = zeroCounters();
    this.periodFrom = now();
    this.state = 'off';
    this.error = null;
    this.want = [];
    this.downloading = null;
    this.lastSyncAt = null;
    this.lastReportAt = null;
    this.lastFullAt = 0;
    this.needFull = true;
    this.syncing = null;
    this.abort = null;
    const exclude = tunnelIp ? [tunnelIp] : [];
    this.addresses = addresses || (() => lanListenAddresses({ exclude, linkLocal: false }));
    this.server = null;
    this.listen = { state: 'off', listen: [], busy: [], port: null };
    this.syncLoop = loop(() => this.sync(), () => syncMs);
    this.reportLoop = loop(() => this.report(), () => reportMs);
    this.listenLoop = loop(() => this._reconcile(), () => listenMs);
  }

  _tls() {
    if (!this.tls) this.tls = this.tlsOverride || loadOrCreate(path.join(this.stateDir, 'cache-tls'), { commonName: 'GateControl Gateway Cache' });
    return this.tls;
  }

  async apply(cfg) {
    const prev = this.cfg;
    this.cfg = cfg;
    this.status.setEnabled(cfg.enabled);
    if (!cfg.enabled) {
      if (prev.enabled) this._shutdown();
      this.state = cfg.requested ? cfg.problem : 'off';
      return;
    }
    const moved = !prev.enabled || prev.path !== cfg.path;
    const portChanged = prev.port !== cfg.port;
    if (moved) {
      if (this.abort) this.abort.abort();
      if (this.store) this.store.persist();
      this.store = null;
      try {
        const s = new BlobStore({ dir: cfg.path, now: this.now });
        await s.open();
        this.store = s;
        this.needFull = true;
      } catch (err) {
        this.state = 'path_unwritable';
        this.error = { at: this.now(), code: 'path_unwritable', message: String(err.code || err.message).slice(0, 100) };
        this.status.fail('path_unwritable');
        logger.warn({ path: cfg.path, err: err.message }, 'cache: path not usable');
        this._stopServing();
        return;
      }
    }
    try { this._tls(); } catch (err) {
      this.state = 'error';
      this.error = { at: this.now(), code: 'tls', message: err.message.slice(0, 100) };
      return;
    }
    if (!this.server || portChanged) {
      if (this.server) this.server.close();
      this.server = new LanBlobServer({
        handler: makeHandler({ secret: () => this.cfg.secret, store: { has: (s) => !!this.store && this.store.has(s), filePath: (s) => this.store.filePath(s), touch: (s) => this.store && this.store.touch(s) }, now: this.now, counters: this.counters }),
        tls: this._tls(),
        port: cfg.port,
        addresses: this.addresses,
      });
      this.listenLoop.start(0);
    }
    this.state = 'running';
    this.error = null;
    if (!prev.enabled || moved) {
      this.syncLoop.start(5_000);
      this.reportLoop.start(60_000);
    } else {
      this.syncLoop.start(1_000); // Arten/Größe geändert → neu abgleichen
    }
  }

  _stopServing() {
    this.listenLoop.stop();
    if (this.server) this.server.close();
    this.server = null;
    this.listen = { state: 'off', listen: [], busy: [], port: null };
  }

  _shutdown() {
    this.syncLoop.stop();
    this.reportLoop.stop();
    if (this.abort) this.abort.abort();
    this._stopServing();
    if (this.store) this.store.persist();
    this.store = null;
    this.downloading = null;
  }

  stop() {
    if (this.cfg.enabled) this._shutdown();
  }

  async _reconcile() {
    if (!this.server) return;
    const prev = this.listen.state;
    this.listen = await this.server.reconcile();
    if (this.listen.state !== prev) logger.info({ state: this.listen.state, listen: this.listen.listen }, 'cache: LAN endpoint');
  }

  freeBytes() {
    if (this.freeBytesFn) return this.freeBytesFn();
    return this.store ? this.store.freeBytes() : null;
  }

  /** Höchstens belegen: maxBytes, aber nie mehr als der Datenträger hergibt (Reserve bleibt frei). */
  effectiveMax() {
    const free = this.freeBytes();
    const used = this.store ? this.store.usedBytes : 0;
    if (free === null) return this.cfg.maxBytes;
    return Math.max(0, Math.min(this.cfg.maxBytes, used + free - RESERVE_BYTES));
  }

  /** Vorrat holen und fehlende Blobs laden. */
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this._sync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  /** 429 vom Server: Zwischenspeicher-Verkehr bis Retry-After ruhen lassen. */
  _backoff(ms) {
    this.pausedUntil = this.now() + ms;
    this.status.fail('rate_limited');
    logger.warn({ retryAfterS: Math.round(ms / 1000) }, 'cache: server rate limit (429), pausing cache sync');
  }

  _paused() { return this.now() < this.pausedUntil; }

  async _sync() {
    if (!this.cfg.enabled || !this.store || this._paused()) return;
    const store = this.store;
    this.status.start();
    try {
      const all = await this.client.want();
      const kinds = this.cfg.kinds;
      this.want = all.filter((w) => kinds[w.kind] === true).sort((a, b) => b.priority - a.priority);
      this.lastSyncAt = this.now();
      const prio = new Map(this.want.map((w) => [w.sha256, w.priority]));
      // Zuerst raus: nicht (mehr) im Vorrat (LRU), dann niedrigere Priorität (LRU); gleich/höher bleibt.
      // Reihenfolge einmal je Abgleich – nicht je gewolltem Blob (bei 20 000 Einträgen
      // und vollem Speicher sonst O(n² log n) am Stück, das Gateway antwortet minutenlang nicht).
      await tick();
      const plan = store.evictionPlan((sha) => (prio.has(sha) ? prio.get(sha) : -Infinity));
      await tick();
      let fetchedAny = false;
      const failures = [];
      let limit = this.effectiveMax();
      let sliceAt = performance.now();
      for (const w of this.want) {
        // Ereignisschleife regelmäßig freigeben (Heartbeat, Proxy, Probe, LAN-Abgabe).
        if (performance.now() - sliceAt >= SLICE_MS) {
          await tick();
          sliceAt = performance.now();
          if (this.store === store && this.cfg.enabled) limit = this.effectiveMax();
        }
        if (this.store !== store || !this.cfg.enabled) break;
        if (store.has(w.sha256)) continue;
        if (w.size > limit) continue;
        if (!(await plan.makeRoom(w.size, limit, w.priority))) continue;
        this.downloading = { sha256: w.sha256, size: w.size, bytes: 0, kind: w.kind };
        this.abort = new AbortController();
        try {
          const wait = this.lastBlobAt + this.blobGapMs - Date.now();
          if (wait > 0) await sleep(wait);
          this.lastBlobAt = Date.now();
          const r = await this.client.blob(w.sha256, w.size, store.partPath(w.sha256), {
            signal: this.abort.signal,
            onProgress: (b) => { if (this.downloading) this.downloading.bytes = b; },
          });
          this.counters.bytesFetched += r.fetched;
          await store.commit(w.sha256, w.size, w.kind);
          fetchedAny = true;
        } catch (err) {
          if (err.code === 'aborted') break;
          if (err.code === 'rate_limited') { this._backoff(err.retryAfterMs); break; }
          failures.push(err.code || 'error');
          logger.warn({ sha256: w.sha256.slice(0, 12), err: err.code || err.message }, 'cache: download failed');
          if (failures.length >= 3) break;
        } finally {
          this.downloading = null;
          this.abort = null;
        }
        limit = this.effectiveMax();
        sliceAt = performance.now();
      }
      await store.save();
      if (failures.length) this.status.fail(`download: ${failures[0]}`); else if (!this._paused()) this.status.ok();
      if (fetchedAny) await this.report();
    } catch (err) {
      if (err.code === 'rate_limited') { this._backoff(err.retryAfterMs); return; }
      this.status.fail(err.code || err.message);
      logger.debug({ err: err.code || err.message }, 'cache: sync failed');
    }
  }

  /**
   * Bestand/Statistik melden (Delta; full nach Start/Fehler/alle 6 h).
   * Mehr als MAX_HAVE Einträge gehen in Folgeberichten (Delta) hinterher.
   */
  async report() {
    if (!this.cfg.enabled || !this.store || this._paused()) return;
    const store = this.store;
    const full = this.needFull || this.now() - this.lastFullAt >= FULL_EVERY_MS;
    const added = full ? [...store.items.keys()] : [...store.added];
    const removed = full ? [] : [...store.removed];
    const counters = { ...this.counters };
    // Zähler an Ort und Stelle zurücksetzen (der LAN-Handler hält dasselbe Objekt)
    Object.assign(this.counters, zeroCounters());
    const from = this.periodFrom;
    const to = this.now();
    this.periodFrom = to;
    const chunks = Math.max(1, Math.ceil(added.length / MAX_HAVE), Math.ceil(removed.length / MAX_HAVE));
    let ok = true;
    for (let i = 0; i < chunks && ok; i++) {
      const first = i === 0;
      const body = {
        full: full && first,
        have: added.slice(i * MAX_HAVE, (i + 1) * MAX_HAVE),
        gone: removed.slice(i * MAX_HAVE, (i + 1) * MAX_HAVE),
        usedBytes: store.usedBytes,
        maxBytes: this.cfg.maxBytes,
        effectiveMaxBytes: this.effectiveMax(),
        items: store.count,
        hits: first ? counters.hits : 0,
        misses: first ? counters.misses : 0,
        bytesServed: first ? counters.bytesServed : 0,
        bytesFetched: first ? counters.bytesFetched : 0,
        period: { from, to },
      };
      const r = await this.reporter.post(REPORT_PATH, body);
      ok = r.ok;
      if (r.status === 429) this._backoff(retryAfterMs(r.retryAfter));
      if (!ok && first) {
        for (const k of Object.keys(counters)) this.counters[k] += counters[k];
        this.periodFrom = from;
      }
    }
    if (ok) {
      if (full) { this.needFull = false; this.lastFullAt = to; store.added.clear(); store.removed.clear(); } else {
        for (const s of added) store.added.delete(s);
        for (const s of removed) store.removed.delete(s);
      }
      this.lastReportAt = to;
    } else {
      this.needFull = true;
    }
    await store.save();
  }

  /** Mgmt „Zwischenspeicher leeren“. */
  async clear() {
    if (!this.cfg.enabled || !this.store) return 'disabled';
    if (this.abort) this.abort.abort();
    await this.store.clear();
    this.needFull = true;
    void this.report();
    return 'accepted';
  }

  requestSync() {
    if (!this.cfg.enabled || !this.store) return 'disabled';
    if (this.syncing) return 'busy';
    void this.sync();
    return 'accepted';
  }

  /** IPv4 zuerst – daraus baut der Server die `lan.url`. */
  _urls() {
    const listen = [...(this.listen.listen || [])].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')));
    return listen.map((a) => (a.includes(':') ? `https://[${a}]:${this.cfg.port}` : `https://${a}:${this.cfg.port}`));
  }

  _state() {
    return this.state === 'running' && this.listen.state !== 'running' && this.listen.state !== 'off' ? this.listen.state : this.state;
  }

  /** Server liest port/tlsSha256/url/usedBytes von hier (Vertrag 3b, Server-Seite 5). */
  featureTelemetry() {
    const on = this.cfg.enabled && !!this.store;
    const urls = on ? this._urls() : [];
    return this.status.snapshot({
      state: this.cfg.enabled || this.cfg.requested ? this._state() : 'off',
      port: this.cfg.enabled ? this.cfg.port : null,
      tlsSha256: on && this.tls ? this.tls.sha256 : null,
      url: urls[0] || null,
      usedBytes: on ? this.store.usedBytes : 0,
      error: this.error,
      lastSyncAt: this.lastSyncAt,
      lastReportAt: this.lastReportAt,
    });
  }

  /** Telemetrie `cache` (null wenn weder an noch angefordert). */
  telemetry() {
    if (!this.cfg.enabled && !this.cfg.requested) return null;
    const s = this.store;
    return {
      state: this._state(),
      port: this.cfg.port || null,
      listen: this.listen.listen || [],
      urls: this._urls(),
      tlsSha256: this.tls ? this.tls.sha256 : null,
      path: this.cfg.path || null,
      usedBytes: s ? s.usedBytes : 0,
      maxBytes: this.cfg.maxBytes || null,
      effectiveMaxBytes: s ? this.effectiveMax() : null,
      freeBytes: s ? this.freeBytes() : null,
      items: s ? s.count : 0,
      want: this.want.length,
      downloading: this.downloading ? { ...this.downloading } : null,
      lastSyncAt: this.lastSyncAt,
      lastReportAt: this.lastReportAt,
      error: this.error,
    };
  }
}

module.exports = { HomeCache, REPORT_PATH, RESERVE_BYTES };
