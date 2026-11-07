'use strict';

// Funk (Phase 3c, Schritt 2 – Vertrag „Funk“, docs/radio.md): Erkennung der
// Funksticks und Bluetooth-Adapter, Zigbee über deCONZ oder zigbee2mqtt (an/aus,
// Anlernen, Geräte), Thread über einen OpenThread Border Router und passives
// Bluetooth (auch verschlüsselte Sensoren mit Schlüssel aus GateControl).
// Gesteuert über features.radio aus dem Config-Pull; Zustand für die Telemetrie
// (features.radio) und die Management-API (/api/radio/*).
//
// Ein Stick bedient genau einen Funk: zuerst Zigbee (der gewählte Dienst), dann
// Thread mit einem anderen Stick. Passt nur ein Stick, meldet Thread „stick_busy“.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect } = require('./detect');
const { normalizeRadio } = require('./config');
const { Zigbee } = require('./zigbee');
const { Zigbee2Mqtt } = require('./z2m');
const { ThreadBorderRouter } = require('./thread');
const { BleScanner } = require('./ble');
const { BleKeyStore } = require('./blekeys');
const { createDeconzClient } = require('./deconz');
const { loop } = require('../features/status');
const logger = require('../logger');

const DETECT_MS = 30_000;
const ZIGBEE_MS = 60_000;
const PAIR_MS = 5_000;
const HOST_PROFILE_MAX = 8192;
const START_FLAG = 'radio-start';
const START_FLAG_EVERY_MS = 10 * 60_000;
const HOST_SERVICES = ['deconz', 'zigbee2mqtt', 'otbr'];

function readHostProfile(stateDir) {
  if (!stateDir) return null;
  try {
    const file = path.join(stateDir, 'hardware.json');
    if (fs.statSync(file).size > HOST_PROFILE_MAX) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

/** Name der LAN-Schnittstelle mit der primären LAN-Adresse (für den Border Router) oder null. */
function lanInterface() {
  try {
    const { primaryLanIp } = require('../discovery/lanInterfaces');
    const { defaultGatewayIp } = require('../health/telemetry');
    const ip = primaryLanIp(defaultGatewayIp());
    if (!ip) return null;
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      if ((addrs || []).some((a) => a.family === 'IPv4' && a.address === ip)) return name;
    }
  } catch { /* keine Schnittstelle */ }
  return null;
}

/** Welcher Stick welchen Funk bedient (ein Stick – ein Dienst). */
function assignSticks(sticks, { z2m, thread, deconzStick }) {
  const usable = (s) => s && s.tty && s.dev;
  let z2mStick = null;
  // zigbee2mqtt: zuerst Sticks, die deCONZ nicht spricht (reine Zigbee-Sticks vor Multi-Sticks), dann ConBee/RaspBee
  if (z2m) {
    z2mStick = sticks.find((s) => usable(s) && s.z2m && !s.deconz && s.kind === 'zigbee')
      || sticks.find((s) => usable(s) && s.z2m && !s.deconz) || sticks.find((s) => usable(s) && s.z2m) || null;
  }
  const zigbeeStick = deconzStick || z2mStick;
  let threadStick = null;
  let busy = false;
  if (thread) {
    const cand = sticks.filter((s) => usable(s) && s.thread);
    threadStick = cand.find((s) => s.kind === 'thread' && s !== zigbeeStick) || cand.find((s) => s !== zigbeeStick) || null;
    busy = !threadStick && cand.length > 0;
  }
  return { z2mStick, threadStick, threadBusy: busy };
}

class RadioService {
  constructor({ reporter = null, stateDir = null, ctlDir = '/gc-radio', sysRoot = '/sys', procRoot = '/proc', client = createDeconzClient(), now = Date.now, ble = null,
    z2m = null, thread = null, keys = null, serverUrl = null, apiToken = null, getInfra = lanInterface }) {
    Object.assign(this, { stateDir, sysRoot, now, getInfra });
    this.cfg = normalizeRadio(undefined);
    this.hostProfile = null;
    this.hostWants = new Set();
    this.lastStartFlag = 0;
    const askHost = (svc) => this._askHost(svc);
    this.zigbee = new Zigbee({ client, stateDir, ctlDir, now, askHost, wish: () => this._wish() });
    this.z2m = z2m || new Zigbee2Mqtt({ stateDir, ctlDir, reporter, now, askHost });
    this.thread = thread || new ThreadBorderRouter({ ctlDir, now, procRoot, askHost });
    for (const x of [this.z2m, this.thread]) if (!x.askHost) x.askHost = askHost;
    this.keys = keys || new BleKeyStore({ serverUrl, apiToken, stateDir });
    this.ble = ble || new BleScanner({ reporter, now, keys: this.keys });
    if (!this.ble.keys) this.ble.keys = this.keys;
    this.found = { sticks: [], bluetooth: [] };
    this.assigned = { z2mStick: null, threadStick: null, threadBusy: false };
    this.started = false;
    this.detectLoop = loop(() => this.refresh(), () => DETECT_MS);
    this.zigbeeLoop = loop(() => this._tick(), () => (this.zigbee.pairing() || this.z2m.pairing() ? PAIR_MS : ZIGBEE_MS));
  }

  /** Den MQTT-Broker des Gateways anhängen (für zigbee2mqtt, bootstrap.js). */
  attachMqtt(mqtt) { this.z2m.attach(mqtt); }

  _wish() {
    return { stack: this.cfg.stack, z2m: this.cfg.stack === 'zigbee2mqtt' && this.cfg.zigbee !== false, thread: this.cfg.thread === true };
  }

  /** Pi-Image: der Host soll fehlende Funk-Dienste anlegen (ein Flag, alle Dienste; höchstens alle 10 Min.). */
  _askHost(service) {
    if (!HOST_SERVICES.includes(service)) return false;
    if (!this.stateDir || !(this.hostProfile && this.hostProfile.radio_start === true)) return false;
    const before = [...this.hostWants].sort().join();
    this.hostWants.add(service);
    const list = [...this.hostWants].sort();
    if (list.join() === before && this.now() - this.lastStartFlag < START_FLAG_EVERY_MS) return true;
    try {
      const tmp = path.join(this.stateDir, `.${START_FLAG}.${process.pid}`);
      fs.writeFileSync(tmp, JSON.stringify({ zigbee: true, services: list, at: new Date(this.now()).toISOString() }) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, path.join(this.stateDir, START_FLAG));
      this.lastStartFlag = this.now();
      logger.info({ services: list }, 'radio: asked the host to start radio services');
      return true;
    } catch (e) { logger.warn({ err: e.message }, 'radio: radio-start not written'); return false; }
  }

  /** Hardware neu ansehen und alle Teile nachziehen (alle 30 s, wirft nie). */
  refresh() {
    try {
      const hostProfile = readHostProfile(this.stateDir);
      this.hostProfile = hostProfile;
      this.found = detect({ sysRoot: this.sysRoot, hostProfile });
      const z2mMode = this.cfg.stack === 'zigbee2mqtt';
      // „automatisch“ schaltet nur deCONZ von selbst ein; wer zigbee2mqtt wählt, will es (außer ausdrücklich aus)
      const z2mWant = z2mMode && this.cfg.zigbee !== false;
      this.zigbee.apply({ mode: z2mMode ? false : this.cfg.zigbee, sticks: this.found.sticks, hostProfile });
      const deconzStick = !z2mMode && this.zigbee.want() ? this.zigbee.device() : null;
      this.assigned = assignSticks(this.found.sticks, { z2m: z2mWant, thread: this.cfg.thread, deconzStick });
      this.z2m.apply({ want: z2mWant, stick: this.assigned.z2mStick });
      this.thread.apply({ want: this.cfg.thread, stick: this.assigned.threadStick, infra: this.cfg.thread ? this.getInfra() : null, busy: this.assigned.threadBusy });
      this.ble.apply({ enabled: this.cfg.ble, adapters: this.found.bluetooth });
      if (this.hostWants.size && this.stateDir && !fs.existsSync(path.join(this.stateDir, START_FLAG))) {
        // der Host hat das Flag verbraucht: nur noch fragen, was weiter fehlt
        for (const s of [...this.hostWants]) {
          const svc = s === 'deconz' ? this.zigbee.service() : (s === 'zigbee2mqtt' ? this.z2m.service() : this.thread.service());
          if (svc !== 'absent') this.hostWants.delete(s);
        }
      }
    } catch (e) { logger.warn({ err: e.message }, 'radio: detection failed'); }
  }

  async _tick() {
    await this.zigbee.tick();
    await this.thread.tick();
  }

  /** features.radio aus dem Config-Pull (undefined = älterer Server: Zigbee automatisch, Rest aus). */
  async apply(raw) {
    this.cfg = normalizeRadio(raw);
    this.refresh();
    // Schlüssel verschlüsselter Sensoren nur bei geändertem Stand holen (nie im Config-Pull selbst)
    this.keys.sync(this.cfg.ble ? this.cfg.bleKeys : null).then((fresh) => {
      if (fresh) logger.info({ sensors: this.keys.size }, 'radio: bluetooth keys loaded');
    }, (e) => logger.warn({ err: e.message }, 'radio: bluetooth keys not loaded'));
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
    this.z2m.stop();
    this.started = false;
  }

  /** Nach dem Anlernen sofort öfter fragen. */
  _kick() {
    this.zigbeeLoop.stop();
    this.zigbeeLoop.start(PAIR_MS);
  }

  _z2m() { return this.cfg.stack === 'zigbee2mqtt'; }

  async requestPair(body) {
    const seconds = body && Number.isInteger(body.seconds) ? body.seconds : 180;
    try {
      const r = this._z2m() ? await this.z2m.pair(seconds) : await this.zigbee.pair(seconds);
      if (r === 'accepted') this._kick();
      return r;
    } catch (e) { logger.warn({ err: e.message }, 'radio: pairing not started'); return 'failed'; }
  }

  async requestUnlock() {
    if (this._z2m()) return 'not_running';
    try { return await this.zigbee.unlock(); } catch (e) { logger.warn({ err: e.message }, 'radio: unlock failed'); return 'failed'; }
  }

  async requestRetry() {
    this.refresh();
    if (this._z2m()) return 'accepted';
    return this.zigbee.retry();
  }

  /** zigbee2mqtt: Gerät entfernen / schalten. */
  async requestRemove(body) {
    if (!this._z2m()) return 'not_running';
    try { return await this.z2m.remove(body && body.ieee); } catch (e) { logger.warn({ err: e.message }, 'radio: zigbee device not removed'); return 'failed'; }
  }
  async requestSet(body) {
    if (!this._z2m()) return 'not_running';
    try { return await this.z2m.set(body && body.ieee, body && body.set); } catch (e) { logger.debug({ err: e.message }, 'radio: zigbee command failed'); return 'failed'; }
  }

  /** Thread: Netz anlegen / beitreten / Datensatz. */
  async requestThreadForm(body) {
    if (!this.cfg.thread) return 'disabled';
    try { return await this.thread.form(body && body.name); } catch (e) { logger.warn({ err: e.message }, 'radio: thread network not formed'); return 'failed'; }
  }
  async requestThreadJoin(body) {
    if (!this.cfg.thread) return 'disabled';
    try { return await this.thread.join(body && body.dataset); } catch (e) { logger.warn({ code: e.code }, 'radio: thread dataset not taken over'); return 'failed'; }
  }
  async requestThreadDataset() {
    if (!this.cfg.thread) return { outcome: 'disabled' };
    try { return await this.thread.dataset(); } catch (e) { logger.warn({ code: e.code }, 'radio: thread dataset not read'); return { outcome: 'failed' }; }
  }

  /** features.radio der Telemetrie (klein halten: Heartbeat ≤ 16 KB). */
  featureTelemetry() {
    const thread = this.found.sticks.filter((s) => s.kind === 'thread' || s.kind === 'multi');
    const deconzDev = this.zigbee.want() ? this.zigbee.device() : null;
    const useOf = (s) => {
      if (s === this.assigned.z2mStick) return 'zigbee2mqtt';
      if (s === this.assigned.threadStick) return 'thread';
      return s === deconzDev ? 'deconz' : null;
    };
    return {
      enabled: this.zigbee.want() || this.z2m.wanted || this.cfg.ble || this.cfg.thread,
      stack: this.cfg.stack,
      sticks: this.found.sticks.map((s) => ({ kind: s.kind, model: s.model, bus: s.bus, tty: s.tty, deconz: s.deconz, z2m: s.z2m || null, thread: s.thread === true, use: useOf(s) }))
        .concat(this.found.bluetooth.map((b) => ({ kind: 'bluetooth', model: b.model, bus: b.bus, tty: b.name, deconz: false, z2m: null, thread: false, use: null })))
        .slice(0, 8),
      zigbee: { ...this.zigbee.telemetry(), stack: this.cfg.stack },
      zigbee2mqtt: this._z2m() ? this.z2m.telemetry() : null,
      ble: { ...this.ble.telemetry(), keys: this.keys.size },
      thread: { sticks: thread.length, models: thread.map((s) => s.model).slice(0, 4), otbr: this.cfg.thread, ...this.thread.telemetry() },
    };
  }

  /** Frischer Zustand für den Reiter „Funk“ (inkl. der Sensor- und Geräteliste). */
  async status() {
    await this._tick();
    return { ...this.featureTelemetry(), bleSensors: this.ble.list().slice(0, 24), zigbeeDevices: this._z2m() ? this.z2m.list().slice(0, 64) : [] };
  }
}

module.exports = { RadioService, readHostProfile, assignSticks, lanInterface, START_FLAG };
