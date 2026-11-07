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
// In GateControl lässt sich je Stick von Hand festlegen, wofür er dient
// (features.radio.sticks, Capability radio-stick-assign) – das geht vor.

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

const usable = (s) => !!(s && s.tty && s.dev);

/**
 * Welcher Stick welchen Funk bedient (ein Stick – ein Dienst).
 *
 * choices: Map Kennung → 'zigbee' | 'thread' | 'none' (von Hand in GateControl festgelegt,
 * features.radio.sticks). Die Wahl von Hand geht vor; „automatisch“ verteilt nur Sticks ohne
 * Wahl – und nur an einen Funk, für den kein Stick von Hand festgelegt ist. Fehlt der von Hand
 * gewählte Stick, wartet der Funk auf ihn (`…Missing`) und nimmt keinen anderen.
 *
 * @returns {{ autoSticks, zigbeeManual, zigbeePick, zigbeeMissing, z2mStick, z2mMissing,
 *   threadManual, threadStick, threadMissing, threadBusy, z2mWant?, deconzStick? }}
 */
function planSticks(sticks, choices = new Map()) {
  const choice = (s) => choices.get(s.id) || 'auto';
  const autoSticks = sticks.filter((s) => choice(s) === 'auto');
  const wanted = (use) => [...choices.values()].includes(use);
  const zigbeeManual = wanted('zigbee');
  const threadManual = wanted('thread');
  // mehrere Sticks für denselben Funk: der zuerst festgelegte, der eingesteckt ist (Reihenfolge der Einstellung, nie die ttyACM-Nummer)
  const pick = (use) => {
    for (const [id, u] of choices) {
      if (u !== use) continue;
      const s = sticks.find((x) => x.id === id);
      if (s) return s;
    }
    return null;
  };
  const zigbeePick = zigbeeManual ? pick('zigbee') : null;
  const threadPick = threadManual ? pick('thread') : null;
  return {
    autoSticks, choice, zigbeeManual, zigbeePick, zigbeeMissing: zigbeeManual && !zigbeePick,
    threadManual, threadPick, threadMissing: threadManual && !threadPick,
  };
}

/** Welcher Stick welchen Funk bedient (ein Stick – ein Dienst); deconzStick hat Zigbee schon (deCONZ). */
function assignSticks(sticks, { z2m, thread, deconzStick, choices = new Map() }) {
  const p = planSticks(sticks, choices);
  let z2mStick = null;
  if (z2m) {
    if (p.zigbeeManual) z2mStick = p.zigbeePick && usable(p.zigbeePick) && p.zigbeePick.z2m ? p.zigbeePick : null;
    else {
      // zigbee2mqtt: zuerst Sticks, die deCONZ nicht spricht (reine Zigbee-Sticks vor Multi-Sticks), dann ConBee/RaspBee
      const a = p.autoSticks;
      z2mStick = a.find((s) => usable(s) && s.z2m && !s.deconz && s.kind === 'zigbee')
        || a.find((s) => usable(s) && s.z2m && !s.deconz) || a.find((s) => usable(s) && s.z2m) || null;
    }
  }
  const zigbeeStick = deconzStick || z2mStick;
  let threadStick = null;
  let busy = false;
  if (thread) {
    if (p.threadManual) threadStick = p.threadPick && usable(p.threadPick) ? p.threadPick : null;
    else {
      const cand = p.autoSticks.filter((s) => usable(s) && s.thread);
      threadStick = cand.find((s) => s.kind === 'thread' && s !== zigbeeStick) || cand.find((s) => s !== zigbeeStick) || null;
      // der einzige passende Stick dient schon Zigbee (automatisch oder von Hand)
      busy = !threadStick && sticks.some((s) => usable(s) && s.thread && s === zigbeeStick);
    }
  }
  return {
    z2mStick, threadStick, threadBusy: busy,
    zigbeeManual: p.zigbeeManual, zigbeeMissing: p.zigbeeMissing, zigbeePick: p.zigbeePick,
    threadManual: p.threadManual, threadMissing: p.threadMissing, threadPick: p.threadPick, choice: p.choice,
  };
}

/**
 * Hinweis zu einem von Hand festgelegten Stick (null = passt):
 *   second     ein anderer Stick ist schon für diesen Funk festgelegt – dieser bleibt frei
 *   radio_off  der gewählte Funk ist aus
 *   no_adapter zigbee2mqtt kennt keinen Adapter für diesen Stick (er bleibt frei)
 *   fit        laut Erkennung passt der Stick nicht zum Dienst (er wird trotzdem genommen – Hinweis, keine Sperre)
 */
function stickNote(s, use, { a, stack, zigbeeOn, threadOn }) {
  if (use === 'zigbee') {
    if (s !== a.zigbeePick) return 'second';
    if (!zigbeeOn) return 'radio_off';
    if (stack === 'zigbee2mqtt' && !s.z2m) return 'no_adapter';
    if ((stack !== 'zigbee2mqtt' && !s.deconz) || s.kind === 'thread') return 'fit';
    return null;
  }
  if (use === 'thread') {
    if (s !== a.threadPick) return 'second';
    if (!threadOn) return 'radio_off';
    return s.thread ? null : 'fit';
  }
  return null;
}

class RadioService {
  constructor({ reporter = null, stateDir = null, ctlDir = '/gc-radio', sysRoot = '/sys', devRoot = '/dev', procRoot = '/proc', client = createDeconzClient(), now = Date.now, ble = null,
    z2m = null, thread = null, keys = null, serverUrl = null, apiToken = null, getInfra = lanInterface }) {
    Object.assign(this, { stateDir, sysRoot, devRoot, now, getInfra });
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
    this.assigned = assignSticks([], { z2m: false, thread: false, deconzStick: null });
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
      this.found = detect({ sysRoot: this.sysRoot, devRoot: this.devRoot, hostProfile });
      const z2mMode = this.cfg.stack === 'zigbee2mqtt';
      // „automatisch“ schaltet nur deCONZ von selbst ein; wer zigbee2mqtt wählt, will es (außer ausdrücklich aus)
      const z2mWant = z2mMode && this.cfg.zigbee !== false;
      const choices = new Map(this.cfg.sticks.map((e) => [e.id, e.use]));
      const plan = planSticks(this.found.sticks, choices);
      // deCONZ: von Hand gewählt → genau dieser Stick, sonst der erste ConBee/RaspBee unter den automatischen
      this.zigbee.apply({ mode: z2mMode ? false : this.cfg.zigbee, sticks: plan.autoSticks, hostProfile, manual: !z2mMode && plan.zigbeeManual ? { stick: plan.zigbeePick } : null });
      const deconzStick = !z2mMode && this.zigbee.want() ? this.zigbee.device() : null;
      this.assigned = assignSticks(this.found.sticks, { z2m: z2mWant, thread: this.cfg.thread, deconzStick, choices });
      const a = this.assigned;
      this.z2m.apply({ want: z2mWant, stick: a.zigbeeManual ? (usable(a.zigbeePick) ? a.zigbeePick : null) : a.z2mStick, missing: a.zigbeeMissing });
      this.thread.apply({ want: this.cfg.thread, stick: a.threadStick, infra: this.cfg.thread ? this.getInfra() : null, busy: a.threadBusy, manual: a.threadManual, missing: a.threadMissing });
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
    const a = this.assigned;
    const useOf = (s) => {
      if (s === a.z2mStick) return 'zigbee2mqtt';
      if (s === a.threadStick) return 'thread';
      return s === deconzDev ? 'deconz' : null;
    };
    const ctx = { a, stack: this.cfg.stack, zigbeeOn: this._z2m() ? this.z2m.wanted : this.zigbee.want(), threadOn: this.cfg.thread };
    const stick = (s) => {
      const choice = a.choice ? a.choice(s) : 'auto';
      return {
        id: s.id, idKind: s.idKind, kind: s.kind, model: s.model, bus: s.bus, tty: s.tty, deconz: s.deconz, z2m: s.z2m || null, thread: s.thread === true,
        use: useOf(s), choice, note: stickNote(s, choice, ctx),
      };
    };
    return {
      enabled: this.zigbee.want() || this.z2m.wanted || this.cfg.ble || this.cfg.thread,
      stack: this.cfg.stack,
      sticks: this.found.sticks.map(stick)
        .concat(this.found.bluetooth.map((b) => ({ kind: 'bluetooth', model: b.model, bus: b.bus, tty: b.name, deconz: false, z2m: null, thread: false, use: null })))
        .slice(0, 8),
      // von Hand festgelegte Sticks, die gerade nicht eingesteckt sind
      missing: this.cfg.sticks.filter((e) => e.use !== 'none' && !this.found.sticks.some((s) => s.id === e.id)).slice(0, 8).map((e) => ({ id: e.id, use: e.use })),
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

module.exports = { RadioService, readHostProfile, assignSticks, planSticks, stickNote, lanInterface, START_FLAG };
