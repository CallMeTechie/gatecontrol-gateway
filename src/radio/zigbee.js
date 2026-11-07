'use strict';

// Zigbee über deCONZ (Phase 3c, Schritt 2 §3/§4 – docs/radio.md).
//
// Das Gateway entscheidet, der Wächter im deCONZ-Container führt aus: Soll
// Zigbee laufen und ist ein deCONZ-Funkmodul da, schreibt das Gateway
// /gc-radio/zigbee.env (DEVICE, DEV = major:minor, BAUD); fehlt die Datei,
// beendet der Wächter deCONZ. Der Wächter meldet sich in /gc-radio/deconz.state
// („running ttyACM0 <Sekunden>“). Ohne das Volume /gc-radio (alte Compose-Datei,
// altes Pi-Image) startet das Image deCONZ selbst – dann zeigt das Gateway nur,
// was läuft, und kann trotzdem anlernen.
//
// Pi-Image: /state/radio.json (Wunsch für den nächsten Start) und
// /state/radio-start (Host legt den deCONZ-Container an, gatecontrol-radio.path).

const fs = require('node:fs');
const path = require('node:path');
const { clean } = require('./detect');
const logger = require('../logger');

const KEY_FILE = 'radio-deconz.json';
const WANT_FILE = 'radio.json';
const START_FLAG = 'radio-start';
const ALIVE_S = 60;               // Wächter schreibt alle 2 s – älter = Container läuft nicht
const START_GRACE_MS = 3 * 60_000;
const START_FLAG_EVERY_MS = 10 * 60_000;
const RECENT_MS = 30 * 60_000;
const MAX_RECENT = 5;
const PAIR_TAIL_MS = 30_000;
const MAC_RE = /^([0-9a-f]{2}:){7}[0-9a-f]{2}/i;
// „<Zustand> <Gerät|Grund|Exit-Code|-> <Unix-Sekunden>“ (Wächter im deCONZ-Dienst)
const STATE_RE = /^(idle|wait|running|exit) ([A-Za-z0-9-]{1,16}) ([0-9]{1,12})\s*$/;

function readText(file, max = 4096) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function writeAtomic(file, text, mode = 0o644) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/** Geräte-MAC aus der uniqueid („00:15:8d:…:04-01-0402“) – ein Gerät, viele Ressourcen. */
function macOf(uniqueid) {
  const m = MAC_RE.exec(String(uniqueid || ''));
  return m ? m[0].toLowerCase() : null;
}

/** Echte Zigbee-Geräte aus lights + sensors (ohne CLIP-, Daylight- und Koordinator-Einträge), je MAC einmal. */
function devicesOf(lights, sensors) {
  const out = new Map();
  const add = (r, type) => {
    if (!r || typeof r !== 'object') return;
    const mac = macOf(r.uniqueid);
    if (!mac || out.has(mac)) return;
    out.set(mac, {
      mac, type,
      name: clean(r.name, 48) || null,
      model: clean(r.modelid, 48) || null,
      manufacturer: clean(r.manufacturername, 48) || null,
    });
  };
  for (const r of Object.values(lights && typeof lights === 'object' ? lights : {})) {
    if (r && r.type !== 'Configuration tool') add(r, 'light');
  }
  for (const r of Object.values(sensors && typeof sensors === 'object' ? sensors : {})) {
    const type = String((r && r.type) || '');
    if (/^CLIP/.test(type) || type === 'Daylight' || (r && r.modelid === 'PHDL00')) continue;
    add(r, 'sensor');
  }
  return out;
}

class Zigbee {
  constructor({ client, stateDir = null, ctlDir = '/gc-radio', now = Date.now, askHost = null, wish = null }) {
    Object.assign(this, { client, stateDir, ctlDir, now });
    this.askHostFn = askHost;     // radio.js: ein Flag für alle Funk-Dienste des Pi-Hosts
    this.wish = wish;             // radio.js: zigbee2mqtt/Thread für radio.json
    this.mode = null;            // null = automatisch, true/false aus GateControl
    this.sticks = [];
    this.hostProfile = null;
    this.reachable = false;
    this.info = null;            // { channel, firmware, devicename, rfconnected }
    this.devices = new Map();    // mac → Gerät
    this.recent = [];
    this.pairUntil = 0;
    this.pairBase = null;        // MACs vor dem Anlernen
    this.wantSince = 0;
    this.lastError = null;
    this.keyState = 'unknown';   // unknown | ok | needed
    this.lastStartFlag = 0;
    this.key = this._loadKey();
  }

  // ─── Wunsch und Gerät ─────────────────────────────────────────────────
  _hostMode() {
    const radios = this.hostProfile && Array.isArray(this.hostProfile.radios) ? this.hostProfile.radios : [];
    const z = radios.find((x) => x && x.kind === 'zigbee');
    return z && typeof z.mode === 'string' ? z.mode : 'auto';
  }
  device() { return this.sticks.find((s) => s.deconz && s.tty && s.dev) || null; }
  modeName() { return this.mode === true ? 'on' : this.mode === false ? 'off' : 'auto'; }
  want() {
    if (this.mode !== null) return this.mode;
    const host = this._hostMode();          // settings.txt ZIGBEE= (Pi-Image) zählt nur bei „automatisch“
    if (host === 'off') return false;
    return host === 'on' || !!this.device();
  }

  /** Neue Einstellung / neue Hardware → Steuerdatei (und Wunsch für den Pi-Host) schreiben. */
  apply({ mode, sticks, hostProfile }) {
    if (mode !== undefined) this.mode = typeof mode === 'boolean' ? mode : null;
    if (Array.isArray(sticks)) this.sticks = sticks;
    if (hostProfile !== undefined) this.hostProfile = hostProfile;
    const want = this.want();
    if (want && !this.wantSince) this.wantSince = this.now();
    if (!want) this.wantSince = 0;
    this._writeControl(want ? this.device() : null);
    this._writeWish();
  }

  _ctlUsable() {
    try { fs.accessSync(this.ctlDir, fs.constants.W_OK); return fs.statSync(this.ctlDir).isDirectory(); } catch { return false; }
  }

  _writeControl(dev) {
    if (!this._ctlUsable()) return;
    const file = path.join(this.ctlDir, 'zigbee.env');
    try {
      if (!dev) { fs.rmSync(file, { force: true }); return; }
      const text = `DEVICE=${dev.tty}\nDEV=${dev.dev}\nBAUD=${dev.baud || 0}\n`;
      if (readText(file) === text) return;
      writeAtomic(file, text);
      logger.info({ device: dev.tty, model: dev.model }, 'radio: deCONZ switched on');
    } catch (e) { logger.warn({ err: e.message }, 'radio: zigbee.env not written'); }
  }

  _writeWish() {
    if (!this.stateDir) return;
    const file = path.join(this.stateDir, WANT_FILE);
    const text = JSON.stringify({ zigbee: this.mode, want: this.want(), ...(this.wish ? this.wish() : {}) }) + '\n';
    try { if (readText(file) !== text) writeAtomic(file, text); } catch (e) { logger.debug({ err: e.message }, 'radio: radio.json not written'); }
  }

  /** Der Wächter im deCONZ-Container: { state, tty, alive } oder null (kein Volume). */
  watcher() {
    if (!this._ctlUsable()) return null;
    const m = STATE_RE.exec(readText(path.join(this.ctlDir, 'deconz.state'), 256) || '');
    if (!m) return { state: null, tty: null, alive: false };
    const at = Number(m[3]);
    const alive = Number.isFinite(at) && Math.abs(this.now() / 1000 - at) <= ALIVE_S;
    return { state: m[1], tty: m[2] === '-' ? null : m[2], alive };
  }

  /** managed (Wächter läuft) | absent (Volume da, Container nicht) | image (deCONZ ohne Wächter) | missing */
  service() {
    const w = this.watcher();
    if (w) return w.alive ? 'managed' : 'absent';
    return this.reachable ? 'image' : 'missing';
  }

  /** Pi-Image: Host soll den deCONZ-Container anlegen (höchstens alle 10 Min.). */
  _askHost() {
    if (this.askHostFn) return this.askHostFn('deconz');
    if (!this.stateDir || !(this.hostProfile && this.hostProfile.radio_start === true)) return false;
    if (this.now() - this.lastStartFlag < START_FLAG_EVERY_MS) return true;
    try {
      writeAtomic(path.join(this.stateDir, START_FLAG), JSON.stringify({ zigbee: true, at: new Date(this.now()).toISOString() }) + '\n', 0o600);
      this.lastStartFlag = this.now();
      logger.info('radio: asked the host to start the deCONZ container');
      return true;
    } catch (e) { logger.warn({ err: e.message }, 'radio: radio-start not written'); return false; }
  }

  // ─── Schlüssel ────────────────────────────────────────────────────────
  _loadKey() {
    if (!this.stateDir) return null;
    try {
      const j = JSON.parse(readText(path.join(this.stateDir, KEY_FILE)) || 'null');
      return j && typeof j.key === 'string' ? j.key : null;
    } catch { return null; }
  }
  _saveKey(key) {
    this.key = key;
    if (!this.stateDir) return;
    try {
      const file = path.join(this.stateDir, KEY_FILE);
      if (!key) fs.rmSync(file, { force: true });
      else writeAtomic(file, JSON.stringify({ key }) + '\n', 0o600);
    } catch (e) { logger.warn({ err: e.message }, 'radio: deCONZ key not stored'); }
  }
  async _ensureKey(force = false) {
    if (this.key) return this.key;
    if (this.keyState === 'needed' && !force) return null;
    try {
      this._saveKey(await this.client.createKey());
      this.keyState = 'ok';
      logger.info('radio: got an api key from deCONZ');
      return this.key;
    } catch (e) {
      if (e.code === 'key_needed') { this.keyState = 'needed'; return null; }
      throw e;
    }
  }

  // ─── Abfrage ──────────────────────────────────────────────────────────
  /** Einmal deCONZ fragen (alle 60 s, beim Anlernen alle 5 s). Wirft nie. */
  async tick() {
    try {
      await this.client.probe();
      this.reachable = true;
    } catch (e) {
      this.reachable = false;
      this.info = null;
      if (this.want() && this.device() && this.service() === 'absent') this._askHost();
      return;
    }
    try {
      if (!await this._ensureKey()) return;
      // ein ungültiger Schlüssel bekommt unter /config nur die öffentliche Kurzinfo – /lights sagt es deutlich
      let lights;
      try { lights = await this.client.lights(this.key); } catch (e) {
        if (e.code !== 'unauthorized') throw e;
        this._saveKey(null);              // z. B. deCONZ neu aufgesetzt
        this.keyState = 'unknown';
        if (!await this._ensureKey()) return;
        lights = await this.client.lights(this.key);
      }
      this.keyState = 'ok';
      const [cfg, sensors] = await Promise.all([this.client.config(this.key), this.client.sensors(this.key)]);
      this.info = {
        channel: Number.isInteger(cfg.zigbeechannel) && cfg.zigbeechannel >= 11 && cfg.zigbeechannel <= 26 ? cfg.zigbeechannel : null,
        firmware: typeof cfg.fwversion === 'string' && /^0x[0-9a-f]{1,8}$/i.test(cfg.fwversion) && !/^0x0+$/i.test(cfg.fwversion) ? cfg.fwversion.toLowerCase() : null,
        devicename: clean(cfg.devicename, 32) || null,
        rfconnected: cfg.rfconnected === false ? false : true,
        permitjoin: Number.isInteger(cfg.permitjoin) ? cfg.permitjoin : 0,
      };
      if (this.info.permitjoin > 0) this.pairUntil = Math.max(this.pairUntil, this.now() + this.info.permitjoin * 1000);
      const devs = devicesOf(lights, sensors);
      if (this.pairBase && this.now() <= this.pairUntil + PAIR_TAIL_MS) {
        for (const [mac, d] of devs) {
          if (this.pairBase.has(mac) || this.recent.some((r) => r.mac === mac)) continue;
          this.recent.unshift({ ...d, at: new Date(this.now()).toISOString() });
          logger.info({ model: d.model, type: d.type }, 'radio: new zigbee device paired');
        }
      } else this.pairBase = null;
      this.devices = devs;
      this.lastError = null;
    } catch (e) {
      this.lastError = { at: this.now(), code: clean(String(e.code || 'error'), 32), message: clean(String(e.message || e), 160) };
    }
  }

  pairing() { return this.now() <= this.pairUntil + PAIR_TAIL_MS; }

  /** „Anlernen starten“: 'accepted' | 'not_running' | 'key_needed'. */
  async pair(seconds) {
    const s = Number.isInteger(seconds) ? Math.min(254, Math.max(60, seconds)) : 180;
    if (!this.reachable) return 'not_running';
    if (!await this._ensureKey(true)) return 'key_needed';
    this.pairBase = new Set(this.devices.keys());
    await this.client.permitJoin(this.key, s);
    this.pairUntil = this.now() + s * 1000;
    logger.info({ seconds: s }, 'radio: zigbee pairing window open');
    return 'accepted';
  }

  /** deCONZ 60 s für neue Schlüssel öffnen (Smart-Home-Plugin holt seinen eigenen). */
  async unlock() {
    if (!this.reachable) return 'not_running';
    if (!await this._ensureKey(true)) return 'key_needed';
    await this.client.unlock(this.key, 60);
    return 'accepted';
  }

  /** „Erneut versuchen“ nach key_needed. */
  async retry() {
    this.keyState = 'unknown';
    await this.tick();
    return 'accepted';
  }

  state() {
    const want = this.want();
    const svc = this.service();
    if (this.reachable) {
      if (this.keyState === 'needed' && !this.key) return 'key_needed';
      if (this.info && this.info.rfconnected === false) return 'error';
      return 'running';
    }
    if (!want) return 'off';
    if (!this.device()) return this.sticks.some((s) => s.kind !== 'thread' && !s.deconz) ? 'unsupported' : 'no_stick';
    if (svc === 'missing') return 'service_missing';
    if (svc === 'absent') return this.hostProfile && this.hostProfile.radio_start === true ? 'starting' : 'service_missing';
    const w = this.watcher();
    if (w && w.state === 'exit') return 'error';
    return this.now() - this.wantSince < START_GRACE_MS ? 'starting' : 'error';
  }

  telemetry() {
    const dev = this.device();
    const now = this.now();
    this.recent = this.recent.filter((r) => now - Date.parse(r.at) < RECENT_MS).slice(0, MAX_RECENT);
    const state = this.state();
    let error = this.lastError;
    if (state === 'error' && !error) {
      const w = this.watcher();
      error = { at: now, code: this.info && this.info.rfconnected === false ? 'rf_disconnected' : (w && w.state === 'exit' ? 'deconz_exit' : 'deconz_unreachable'), message: '' };
    }
    return {
      mode: this.modeName(),
      want: this.want(),
      service: this.service(),
      state,
      model: (this.info && this.info.devicename) || (dev ? dev.model : null),
      device: dev ? dev.tty : null,
      firmware: (this.info && this.info.firmware) || (dev && dev.firmware) || null,
      channel: this.info ? this.info.channel : null,
      devices: this.reachable && this.keyState === 'ok' ? this.devices.size : null,
      permitUntil: this.pairUntil > now ? new Date(this.pairUntil).toISOString() : null,
      recent: this.recent.map((r) => ({ ...r })),
      error: state === 'running' && !this.lastError ? null : error,
    };
  }
}

module.exports = { Zigbee, devicesOf, macOf, START_FLAG, WANT_FILE, KEY_FILE };
