'use strict';

// Bluetooth-Sensoren passiv mithören (Phase 3c, Schritt 2 §5 – docs/radio.md).
// Startet gc-blescan (natives Hilfsprogramm im Image, HCI-Raw-Socket, nur
// passiver Scan), liest dessen Zeilen, behält bekannte Sensoren (BTHome v2,
// ATC1441/pvvx, MiBeacon erkannt) und meldet sie dem Server:
//   POST /api/v1/gateway/radio/ble { scannedAt, adapter, sensors: [...] }
// bei Änderung höchstens alle 30 s, sonst alle 5 Min. Höchstens 64 Sensoren.

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { parseAdvert } = require('./bleparse');
const logger = require('../logger');

const BIN = process.env.GC_BLESCAN_BIN || '/usr/local/bin/gc-blescan';
const MAX_SENSORS = 64;
const FORGET_MS = 30 * 60_000;
const REPORT_MIN_MS = 30_000;
const REPORT_MAX_MS = 5 * 60_000;
const RESTART_MS = [5_000, 30_000, 120_000, 600_000];
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const LINE_RE = /^A ([0-9A-F:]{17}) ([0-9]{1,3}) (-?[0-9]{1,3}) ([0-9a-f]{0,510})$/;
// errno → Grund für die Oberfläche
const ERRNO = { 97: 'no_bluetooth', 19: 'no_adapter', 1: 'no_permission', 13: 'no_permission', 16: 'busy' };

class BleScanner {
  constructor({ reporter, now = Date.now, bin = BIN, spawnFn = spawn }) {
    Object.assign(this, { reporter, now, bin, spawnFn });
    this.enabled = false;
    this.adapter = null;      // { name, bus, model }
    this.child = null;
    this.state = 'off';       // off | no_adapter | starting | running | error
    this.mode = null;
    this.error = null;
    this.sensors = new Map(); // mac → Sensor
    this.dirty = false;
    this.lastReport = 0;
    this.lastAt = null;
    this.failures = 0;
    this.restartTimer = null;
    this.reportTimer = null;
  }

  /** an/aus und welcher Adapter (aus der Erkennung). */
  apply({ enabled, adapters }) {
    this.enabled = enabled === true;
    const next = Array.isArray(adapters) && adapters.length ? adapters[0] : null;
    const changed = (next && next.name) !== (this.adapter && this.adapter.name);
    this.adapter = next;
    if (!this.enabled) { this._stop(); this.state = 'off'; this.error = null; this._stopReports(); return; }
    if (!this.adapter) { this._stop(); this.state = 'no_adapter'; this.error = null; return; }
    if (changed) this._stop();
    if (!this.child && !this.restartTimer) this._start();
    this._startReports();
  }

  _start() {
    this.restartTimer = null;
    if (!this.enabled || !this.adapter) return;
    const idx = Number(String(this.adapter.name).replace(/^hci/, '')) || 0;
    this.state = 'starting';
    let child;
    try {
      child = this.spawnFn(this.bin, [String(idx)], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { this._failed('spawn_failed', e.message); return; }
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this._line(line));
    child.on('error', (e) => { if (this.child === child) this._failed(e.code === 'ENOENT' ? 'helper_missing' : 'spawn_failed', e.message); });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.enabled) return;
      if (this.state !== 'error') this._failed('helper_exit', `exit ${code}`);
    });
  }

  _failed(code, message) {
    this.state = 'error';
    this.error = { at: this.now(), code, message: String(message || '').slice(0, 160) };
    if (this.child) { try { this.child.kill('SIGTERM'); } catch (_e) { /* schon weg */ } this.child = null; }
    const wait = RESTART_MS[Math.min(this.failures, RESTART_MS.length - 1)];
    this.failures++;
    logger.warn({ code, retryInMs: wait }, 'radio: bluetooth scan stopped');
    if (this.enabled && !this.restartTimer) {
      this.restartTimer = setTimeout(() => this._start(), wait);
      if (this.restartTimer.unref) this.restartTimer.unref();
    }
  }

  _line(line) {
    if (line.startsWith('S ready ')) {
      this.state = 'running';
      this.mode = line.split(' ')[2] || null;
      this.error = null;
      this.failures = 0;
      logger.info({ adapter: this.adapter && this.adapter.name, mode: this.mode }, 'radio: bluetooth scan running');
      return;
    }
    if (line.startsWith('E ')) {
      const [, step, num] = line.split(' ');
      this._failed(ERRNO[Number(num)] || (step === 'scan' ? 'scan_refused' : 'helper_error'), line.slice(2, 80));
      return;
    }
    const m = LINE_RE.exec(line);
    if (m) this.advert(m[1], Number(m[3]), Buffer.from(m[4], 'hex'));
  }

  /** Ein Werbepaket (auch für Tests). */
  advert(mac, rssi, data) {
    if (!MAC_RE.test(mac)) return;
    const p = parseAdvert(mac, data);
    if (!p) return;
    const now = this.now();
    const cur = this.sensors.get(mac);
    if (!cur && this.sensors.size >= MAX_SENSORS) this._dropOldest();
    const s = cur || { mac, format: p.format, firstSeen: now, packets: 0 };
    const before = cur ? JSON.stringify(cur.values) : null;
    s.format = p.format;
    s.encrypted = p.encrypted;
    if (p.name) s.name = p.name;
    s.values = { ...(cur && cur.values), ...p.values };
    s.rssi = Number.isFinite(rssi) && rssi < 20 ? rssi : null;
    s.lastSeen = now;
    s.packets++;
    this.sensors.set(mac, s);
    this.lastAt = now;
    if (!cur || before !== JSON.stringify(s.values)) this.dirty = true;
  }

  _dropOldest() {
    let old = null;
    for (const s of this.sensors.values()) if (!old || s.lastSeen < old.lastSeen) old = s;
    if (old) this.sensors.delete(old.mac);
  }

  list() {
    const now = this.now();
    for (const [mac, s] of this.sensors) if (now - s.lastSeen > FORGET_MS) this.sensors.delete(mac);
    return [...this.sensors.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_SENSORS).map((s) => ({
      mac: s.mac,
      format: s.format,
      encrypted: !!s.encrypted,
      name: s.name || null,
      values: s.values,
      rssi: s.rssi,
      firstSeen: new Date(s.firstSeen).toISOString(),
      seenAt: new Date(s.lastSeen).toISOString(),
    }));
  }

  /** Bericht an den Server, wenn fällig (wirft nie). */
  async report(force = false) {
    if (!this.reporter || !this.enabled) return null;
    const now = this.now();
    const due = force || (this.dirty && now - this.lastReport >= REPORT_MIN_MS) || now - this.lastReport >= REPORT_MAX_MS;
    if (!due) return null;
    this.dirty = false;
    this.lastReport = now;
    const r = await this.reporter.post('/api/v1/gateway/radio/ble', {
      scannedAt: new Date(now).toISOString(),
      adapter: this.adapter ? { name: this.adapter.name, bus: this.adapter.bus } : null,
      sensors: this.list(),
    });
    if (!r.ok && r.status !== 404) logger.debug({ status: r.status, err: r.error }, 'radio: bluetooth report failed');
    return r;
  }

  _startReports() {
    if (this.reportTimer) return;
    this.reportTimer = setInterval(() => { this.report().catch(() => {}); }, 10_000);
    if (this.reportTimer.unref) this.reportTimer.unref();
  }
  _stopReports() { if (this.reportTimer) clearInterval(this.reportTimer); this.reportTimer = null; }

  _stop() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const c = this.child;
    this.child = null;
    if (c) { try { c.kill('SIGTERM'); } catch (_e) { /* schon weg */ } }
  }

  stop() { this.enabled = false; this._stop(); this._stopReports(); this.state = 'off'; }

  telemetry() {
    return {
      enabled: this.enabled,
      state: this.state,
      mode: this.mode,
      adapter: this.adapter ? { name: this.adapter.name, bus: this.adapter.bus, model: this.adapter.model || null } : null,
      sensors: this.sensors.size,
      lastAt: this.lastAt ? new Date(this.lastAt).toISOString() : null,
      error: this.error,
    };
  }
}

module.exports = { BleScanner, MAX_SENSORS };
