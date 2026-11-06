'use strict';

// Funk (Phase 3c, Schritt 2 – Vertrag „Funk“, docs/radio.md): Erkennung der
// Funksticks und Bluetooth-Adapter, Zigbee über deCONZ (an/aus, Anlernen,
// Entsperren fürs Smart Home) und passives Bluetooth. Gesteuert über
// features.radio aus dem Config-Pull; Zustand für die Telemetrie
// (features.radio) und die Management-API (/api/radio/*).

const fs = require('node:fs');
const path = require('node:path');
const { detect } = require('./detect');
const { normalizeRadio } = require('./config');
const { Zigbee } = require('./zigbee');
const { BleScanner } = require('./ble');
const { createDeconzClient } = require('./deconz');
const { loop } = require('../features/status');
const logger = require('../logger');

const DETECT_MS = 30_000;
const ZIGBEE_MS = 60_000;
const PAIR_MS = 5_000;
const HOST_PROFILE_MAX = 8192;

function readHostProfile(stateDir) {
  if (!stateDir) return null;
  try {
    const file = path.join(stateDir, 'hardware.json');
    if (fs.statSync(file).size > HOST_PROFILE_MAX) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

class RadioService {
  constructor({ reporter = null, stateDir = null, ctlDir = '/gc-radio', sysRoot = '/sys', client = createDeconzClient(), now = Date.now, ble = null }) {
    Object.assign(this, { stateDir, sysRoot, now });
    this.cfg = normalizeRadio(undefined);
    this.zigbee = new Zigbee({ client, stateDir, ctlDir, now });
    this.ble = ble || new BleScanner({ reporter, now });
    this.found = { sticks: [], bluetooth: [] };
    this.started = false;
    this.detectLoop = loop(() => this.refresh(), () => DETECT_MS);
    this.zigbeeLoop = loop(() => this.zigbee.tick(), () => (this.zigbee.pairing() ? PAIR_MS : ZIGBEE_MS));
  }

  /** Hardware neu ansehen und beide Teile nachziehen (alle 30 s, wirft nie). */
  refresh() {
    try {
      const hostProfile = readHostProfile(this.stateDir);
      this.found = detect({ sysRoot: this.sysRoot, hostProfile });
      this.zigbee.apply({ mode: this.cfg.zigbee, sticks: this.found.sticks, hostProfile });
      this.ble.apply({ enabled: this.cfg.ble, adapters: this.found.bluetooth });
    } catch (e) { logger.warn({ err: e.message }, 'radio: detection failed'); }
  }

  /** features.radio aus dem Config-Pull (undefined = älterer Server: Zigbee automatisch, Bluetooth aus). */
  async apply(raw) {
    this.cfg = normalizeRadio(raw);
    this.refresh();
    if (!this.started) {
      this.started = true;
      this.detectLoop.start(DETECT_MS);
      this.zigbeeLoop.start(2_000);
    }
  }

  stop() {
    this.detectLoop.stop();
    this.zigbeeLoop.stop();
    this.ble.stop();
    this.started = false;
  }

  /** Nach dem Anlernen sofort öfter fragen. */
  _kick() {
    this.zigbeeLoop.stop();
    this.zigbeeLoop.start(PAIR_MS);
  }

  async requestPair(body) {
    const seconds = body && Number.isInteger(body.seconds) ? body.seconds : 180;
    try {
      const r = await this.zigbee.pair(seconds);
      if (r === 'accepted') this._kick();
      return r;
    } catch (e) { logger.warn({ err: e.message }, 'radio: pairing not started'); return 'failed'; }
  }

  async requestUnlock() {
    try { return await this.zigbee.unlock(); } catch (e) { logger.warn({ err: e.message }, 'radio: unlock failed'); return 'failed'; }
  }

  async requestRetry() {
    this.refresh();
    return this.zigbee.retry();
  }

  /** features.radio der Telemetrie (klein halten: Heartbeat ≤ 16 KB). */
  featureTelemetry() {
    const thread = this.found.sticks.filter((s) => s.kind === 'thread' || s.kind === 'multi');
    return {
      enabled: this.zigbee.want() || this.cfg.ble,
      sticks: this.found.sticks.map((s) => ({ kind: s.kind, model: s.model, bus: s.bus, tty: s.tty, deconz: s.deconz }))
        .concat(this.found.bluetooth.map((b) => ({ kind: 'bluetooth', model: b.model, bus: b.bus, tty: b.name, deconz: false })))
        .slice(0, 8),
      zigbee: this.zigbee.telemetry(),
      ble: this.ble.telemetry(),
      thread: { sticks: thread.length, models: thread.map((s) => s.model).slice(0, 4), otbr: false },
    };
  }

  /** Frischer Zustand für den Reiter „Funk“ (inkl. der Sensorliste). */
  async status() {
    await this.zigbee.tick();
    return { ...this.featureTelemetry(), bleSensors: this.ble.list().slice(0, 24) };
  }
}

module.exports = { RadioService, readHostProfile };
