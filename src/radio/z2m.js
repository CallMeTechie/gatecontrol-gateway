'use strict';

// Zigbee über zigbee2mqtt (docs/radio.md „zigbee2mqtt“) – für Sticks, die deCONZ
// nicht spricht (Sonoff ZBDongle-E/-P, SkyConnect/ZBT-1, CC2652, EFR32).
//
// Wie bei deCONZ entscheidet das Gateway und der Wächter im Dienst zigbee2mqtt
// führt aus: Soll zigbee2mqtt laufen, ist ein passender Stick da und läuft der
// MQTT-Broker des Gateways (Edge + MQTT in GateControl an), schreibt das Gateway
// /gc-radio/z2m.env (DEVICE, DEV = major:minor, ADAPTER, BAUD, MQTT_USER,
// MQTT_PASS; 0600); fehlt die Datei, beendet der Wächter zigbee2mqtt. Er meldet
// sich in /gc-radio/z2m.state („running ttyUSB0 <Sekunden>“).
//
// MQTT: eigenes Konto gc-zigbee2mqtt (nur zigbee2mqtt/#, Passwort in /state,
// 0600) am Broker des Gateways; das Gateway liest mit seinem internen Konto
// zigbee2mqtt/bridge/* (Zustand, Geräteliste, Ereignisse) und die Zustände der
// Geräte, lernt an (bridge/request/permit_join), entfernt Geräte und schaltet
// sie (zigbee2mqtt/<Name>/set). Die Geräte gehen an den Server:
//   POST /api/v1/gateway/radio/zigbee { stack, devices: [...] }
// bei Änderung höchstens alle 5 s, sonst alle 5 Min. Höchstens 128 Geräte.
// Alles von zigbee2mqtt ist Eingabe von außen: Längen geprüft, Namen gekürzt.
//
// Mehrkanal-Geräte (2-/3-fach-Schalter: state_l1, state_l2 …): caps.channels
// ['l1', 'l2'], values.ch { l1: true, … }, geschaltet mit { on, channel }.
// Thermostate (exposes „climate“): kind 'climate', caps.setpoint { min, max,
// step } und caps.modes, values temperature / setpoint / mode / heating /
// valve, gesetzt mit { setpoint } / { mode }. OTA: caps.ota (definition.
// supports_ota), values.ota { state, progress, installed, latest, checked,
// error } aus dem Feld „update“ des Geräts; { ota: 'check' | 'update' } geht
// an bridge/request/device/ota_update/…, die Antwort kommt über
// bridge/response/device/ota_update/….

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { clean } = require('./detect');
const { hashPassword } = require('../edge/mqtt/broker');
const logger = require('../logger');

const BASE = 'zigbee2mqtt';
const USER = 'gc-zigbee2mqtt';
const ACCOUNT_FILE = 'radio-z2m.json';
const MAX_DEVICES = 128;
const ALIVE_S = 60;
const START_GRACE_MS = 3 * 60_000;
const REPORT_MIN_MS = 5_000;
const REPORT_MAX_MS = 5 * 60_000;
const RECENT_MS = 30 * 60_000;
const MAX_RECENT = 5;
const PAIR_TAIL_MS = 30_000;
const IEEE_RE = /^0x[0-9a-f]{16}$/;
const STATE_RE = /^(idle|wait|running|exit) ([A-Za-z0-9-]{1,16}) ([0-9]{1,12})\s*$/;
const ADAPTERS = ['ember', 'zstack', 'deconz'];
const CHANNEL_RE = /^[a-z0-9_]{1,8}$/;
const MAX_CHANNELS = 8;
const CLIMATE_MODES = ['off', 'heat', 'auto', 'cool', 'fan_only', 'dry'];
const SETPOINT_PROPS = ['occupied_heating_setpoint', 'current_heating_setpoint'];
const OTA_STATES = ['idle', 'available', 'updating', 'scheduled'];
const OTA_TOPIC = 'bridge/response/device/ota_update/';
const SENSOR_PROPS = ['temperature', 'humidity', 'pressure', 'illuminance', 'illuminance_lux', 'co2', 'contact', 'occupancy', 'presence', 'water_leak', 'smoke', 'pm25', 'soil_moisture'];

function readText(file, max = 4096) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/** „0x00158d0001a2b3c4“ → „00:15:8d:00:01:a2:b3:c4“ (wie die MACs von deCONZ). */
function macOfIeee(ieee) {
  const s = String(ieee || '').toLowerCase();
  if (!IEEE_RE.test(s)) return null;
  return s.slice(2).match(/../g).join(':');
}
/** Umkehrung: „00:15:…“ oder „0x0015…“ → „0x0015…“ oder null. */
function ieeeOf(v) {
  const s = String(v || '').toLowerCase();
  if (IEEE_RE.test(s)) return s;
  if (/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/.test(s)) return '0x' + s.replace(/:/g, '');
  return null;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Was ein Gerät kann, aus definition.exposes: { kind, caps }. Helligkeit und Farbe nur vom ersten Kanal; mehrere
 * geschaltete Endpunkte (state_l1, state_l2 …) als caps.channels, ein Thermostat als kind 'climate'.
 */
function summarize(def) {
  const types = new Set();
  const props = new Map();
  const chProps = {};
  // Endpunkte mit eigenem Schaltzustand: { type: 'switch' | 'light', endpoint: 'l1', features: [{ property: 'state_l1' }] }
  for (const e of (def && Array.isArray(def.exposes) ? def.exposes : []).slice(0, 64)) {
    if (!e || typeof e !== 'object' || (e.type !== 'switch' && e.type !== 'light') || !Array.isArray(e.features) || typeof e.endpoint !== 'string') continue;
    const id = e.endpoint.toLowerCase();
    const st = e.features.find((f) => f && f.name === 'state' && typeof f.property === 'string' && /^state_[A-Za-z0-9_]{1,12}$/.test(f.property));
    if (st && CHANNEL_RE.test(id) && !(id in chProps) && Object.keys(chProps).length < MAX_CHANNELS) chProps[id] = st.property;
  }
  const walk = (list, depth) => {
    if (!Array.isArray(list) || depth > 4) return;
    for (const e of list.slice(0, 64)) {
      if (!e || typeof e !== 'object') continue;
      if (Array.isArray(e.features)) {
        // zusammengesetzte Werte (color_xy / color_hs unter „color“) zählen als Eigenschaft
        if (e.type === 'composite' && typeof e.name === 'string' && e.name.length <= 40 && !props.has(e.name)) props.set(e.name, e);
        if (typeof e.type === 'string' && e.type !== 'composite' && !e.endpoint) types.add(e.type);
        if (e.endpoint && !['light', 'switch', 'cover'].some((t) => types.has(t)) && typeof e.type === 'string') types.add(e.type + ':' + String(e.endpoint).slice(0, 8));
        walk(e.features, depth + 1);
      } else if (typeof e.property === 'string' && e.property.length <= 40) {
        if (!props.has(e.property)) props.set(e.property, e);
        if (typeof e.name === 'string' && e.name !== e.property && !props.has(e.name)) props.set(e.name, e);
      }
    }
  };
  walk(def && def.exposes, 0);
  const has = (p) => props.has(p);
  const stateProp = has('state') ? 'state' : ([...props.keys()].find((p) => /^state_[a-z0-9]{1,8}$/.test(p)) || null);
  const setpointProp = SETPOINT_PROPS.find(has) || null;
  let kind = 'other';
  if (types.has('climate') && setpointProp) kind = 'climate';
  else if (types.has('light')) kind = 'light';
  else if (types.has('cover')) kind = 'cover';
  else if (types.has('switch') || (stateProp && !SENSOR_PROPS.some(has))) kind = 'plug';
  else if (SENSOR_PROPS.some(has)) kind = 'sensor';
  else if (has('action')) kind = 'remote';
  const caps = {};
  if (kind === 'light' || kind === 'plug') caps.stateProp = stateProp || 'state';
  if (kind === 'light') {
    if (has('brightness')) caps.bri = true;
    if (has('color_temp')) caps.ct = true;
    if (has('color_xy')) caps.color = 'xy';
    else if (has('color_hs')) caps.color = 'hs';
  }
  if (kind === 'cover' && has('position')) caps.position = true;
  if ((kind === 'light' || kind === 'plug') && Object.keys(chProps).length >= 2) {
    caps.channels = Object.keys(chProps);
    caps.chProps = chProps;
    // `on` ohne Kanal bleibt der erste (ältere Server kennen keine Kanäle)
    caps.stateProp = chProps[caps.channels[0]];
  }
  if (kind === 'climate') {
    const sp = props.get(setpointProp) || {};
    const min = finite(sp.value_min);
    const max = finite(sp.value_max);
    const step = finite(sp.value_step);
    caps.setpointProp = setpointProp;
    caps.setpoint = { min: min != null && min >= 0 && min <= 40 ? min : 5, max: 30, step: step != null && step >= 0.1 && step <= 5 ? step : 0.5 };
    caps.setpoint.max = max != null && max > caps.setpoint.min && max <= 50 ? max : Math.max(30, caps.setpoint.min + 1);
    const mode = props.get('system_mode');
    const modes = mode && Array.isArray(mode.values) ? CLIMATE_MODES.filter((m) => mode.values.includes(m)) : [];
    if (modes.length) caps.modes = modes;
  }
  if (has('power')) caps.power = true;
  if (has('battery')) caps.battery = true;
  if (def && def.supports_ota === true) caps.ota = true;
  return { kind, caps };
}

/** Das Feld „update“ eines Geräts (zigbee2mqtt ≥ 1.33; davor update_available) → { state, progress, installed, latest }. */
function otaOf(p) {
  const u = p.update && typeof p.update === 'object' ? p.update : null;
  if (!u) return typeof p.update_available === 'boolean' ? { state: p.update_available ? 'available' : 'idle' } : null;
  const o = { state: OTA_STATES.includes(u.state) ? u.state : 'idle' };
  if (o.state === 'updating' && finite(u.progress) != null) o.progress = Math.max(0, Math.min(100, Math.round(u.progress)));
  for (const [k, from] of [['installed', u.installed_version], ['latest', u.latest_version]]) {
    if (finite(from) != null || (typeof from === 'string' && /^[\w.+-]{1,32}$/.test(from))) o[k] = String(from);
  }
  return o;
}

/** Zustand von zigbee2mqtt/<Name> → die Werte, die an den Server gehen (Namen wie bei den Bluetooth-Sensoren). */
function valuesOf(p, caps = {}) {
  const v = {};
  if (!p || typeof p !== 'object') return v;
  const sp = caps.stateProp || 'state';
  if (p[sp] === 'ON' || p[sp] === 'OFF') v.on = p[sp] === 'ON';
  if (finite(p.brightness) != null) v.bri = Math.max(0, Math.min(100, Math.round(p.brightness / 2.54)));
  if (finite(p.color_temp) != null) v.ct = Math.round(p.color_temp);
  if (finite(p.position) != null) v.pos = Math.max(0, Math.min(100, Math.round(p.position)));
  for (const k of ['temperature', 'humidity', 'pressure', 'co2', 'pm25', 'power', 'energy', 'voltage', 'battery']) if (finite(p[k]) != null) v[k] = round(p[k]);
  if (finite(p.soil_moisture) != null) v.moisture = round(p.soil_moisture);
  const lux = finite(p.illuminance_lux) != null ? p.illuminance_lux : finite(p.illuminance);
  if (lux != null) v.illuminance = round(lux, 0);
  if (typeof p.contact === 'boolean') v.opening = !p.contact;
  if (typeof p.occupancy === 'boolean') v.motion = p.occupancy;
  if (typeof p.presence === 'boolean') v.presence = p.presence;
  if (typeof p.water_leak === 'boolean') v.moisture_wet = p.water_leak;
  for (const k of ['smoke', 'tamper', 'vibration', 'battery_low']) if (typeof p[k] === 'boolean') v[k] = p[k];
  if (finite(p.linkquality) != null) v.linkquality = Math.round(p.linkquality);
  if (typeof p.action === 'string' && /^[a-z0-9_-]{1,32}$/i.test(p.action)) v.action = p.action;
  if (caps.chProps) {
    const ch = {};
    for (const [id, prop] of Object.entries(caps.chProps)) if (p[prop] === 'ON' || p[prop] === 'OFF') ch[id] = p[prop] === 'ON';
    if (Object.keys(ch).length) v.ch = ch;
  }
  if (caps.setpointProp) {
    // ein Thermostat: gemessen (local_temperature), Soll, Modus, heizt gerade, Ventil
    if (finite(p.local_temperature) != null) v.temperature = round(p.local_temperature, 1);
    if (finite(p[caps.setpointProp]) != null) v.setpoint = round(p[caps.setpointProp], 1);
    if (typeof p.system_mode === 'string' && CLIMATE_MODES.includes(p.system_mode)) v.mode = p.system_mode;
    if (finite(p.pi_heating_demand) != null) v.valve = Math.max(0, Math.min(100, Math.round(p.pi_heating_demand)));
    if (typeof p.running_state === 'string') v.heating = p.running_state === 'heat';
    else if (v.valve != null) v.heating = v.valve > 0;
  }
  if (caps.ota) {
    const ota = otaOf(p);
    if (ota) v.ota = ota;
  }
  return v;
}

/**
 * Ein Befehl des Servers ({ on, bri 0…100, ct, xy, hue 0…65535, sat 0…254, pos }, ein Kanal { on, channel },
 * ein Thermostat { setpoint, mode }) → Nutzlast für <Name>/set oder null.
 */
function setPayload(dev, set) {
  const s = set && typeof set === 'object' ? set : {};
  const c = dev.caps || {};
  const out = {};
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  if ('channel' in s) {
    // ein Kanal eines Mehrkanal-Geräts: nur an/aus, nur ein Kanal, den das Gerät hat
    const prop = c.chProps && typeof s.channel === 'string' && Object.prototype.hasOwnProperty.call(c.chProps, s.channel) ? c.chProps[s.channel] : null;
    return prop && typeof s.on === 'boolean' ? { [prop]: s.on ? 'ON' : 'OFF' } : null;
  }
  if (dev.kind === 'climate') {
    if (num(s.setpoint) && c.setpoint && c.setpointProp) {
      const { min, max, step } = c.setpoint;
      out[c.setpointProp] = round(Math.max(min, Math.min(max, Math.round(s.setpoint / step) * step)), 1);
    }
    if (typeof s.mode === 'string' && Array.isArray(c.modes) && c.modes.includes(s.mode)) out.system_mode = s.mode;
    return Object.keys(out).length ? out : null;
  }
  if ((dev.kind === 'light' || dev.kind === 'plug') && typeof s.on === 'boolean') out[c.stateProp || 'state'] = s.on ? 'ON' : 'OFF';
  if (dev.kind === 'light' && c.bri && num(s.bri)) {
    out.brightness = Math.round(Math.max(0, Math.min(100, s.bri)) * 2.54);
    if (out.brightness > 0 && !(c.stateProp in out)) out[c.stateProp || 'state'] = 'ON';
  }
  if (dev.kind === 'light' && c.ct && num(s.ct)) out.color_temp = Math.round(Math.max(150, Math.min(500, s.ct)));
  if (dev.kind === 'light' && c.color) {
    if (Array.isArray(s.xy) && s.xy.length === 2 && s.xy.every(num)) out.color = { x: round(Math.max(0, Math.min(1, s.xy[0])), 4), y: round(Math.max(0, Math.min(1, s.xy[1])), 4) };
    else if (num(s.hue) || num(s.sat)) out.color = { hue: Math.round((Math.max(0, Math.min(65535, num(s.hue) ? s.hue : 0)) * 360) / 65535), saturation: Math.round((Math.max(0, Math.min(254, num(s.sat) ? s.sat : 254)) * 100) / 254) };
    if (out.color && 'color_temp' in out) delete out.color_temp;
  }
  if (dev.kind === 'cover') {
    if (s.cover === 'open' || s.cover === 'close' || s.cover === 'stop') out.state = s.cover.toUpperCase();
    else if (c.position && num(s.pos)) out.position = Math.round(Math.max(0, Math.min(100, s.pos)));
  }
  return Object.keys(out).length ? out : null;
}

/** Ein Eintrag aus zigbee2mqtt/bridge/devices → Gerät oder null (ohne Koordinator). */
function deviceOf(d) {
  if (!d || typeof d !== 'object' || d.type === 'Coordinator') return null;
  const ieee = String(d.ieee_address || '').toLowerCase();
  if (!IEEE_RE.test(ieee) || typeof d.friendly_name !== 'string' || !d.friendly_name || d.friendly_name.length > 128) return null;
  const def = d.definition && typeof d.definition === 'object' ? d.definition : null;
  const { kind, caps } = summarize(def);
  return {
    ieee,
    mac: macOfIeee(ieee),
    topic: d.friendly_name,
    name: clean(d.friendly_name, 64) || null,
    model: def ? clean(def.model, 48) || null : clean(d.model_id, 48) || null,
    vendor: def ? clean(def.vendor, 48) || null : clean(d.manufacturer, 48) || null,
    description: def ? clean(def.description, 80) || null : null,
    type: d.type === 'Router' ? 'router' : 'end_device',
    power: clean(d.power_source, 24) || null,
    supported: d.supported !== false && !!def,
    interview: d.interviewing ? 'running' : (d.interview_completed === false ? 'failed' : 'done'),
    disabled: d.disabled === true,
    kind, caps,
  };
}

class Zigbee2Mqtt {
  constructor({ stateDir = null, ctlDir = '/gc-radio', reporter = null, now = Date.now, askHost = null }) {
    Object.assign(this, { stateDir, ctlDir, reporter, now, askHost });
    this.mqtt = null;            // MqttManager des Gateways (Edge-Volume), sonst null
    this.offSub = null;
    this.wanted = false;
    this.stick = null;
    this.wantSince = 0;
    this.bridge = null;          // 'online' | 'offline' | null
    this.info = null;            // { version, coordinator, channel, panId }
    this.devices = new Map();    // ieee → Gerät
    this.byTopic = new Map();    // friendly_name → ieee
    this.values = new Map();     // ieee → Werte
    this.seen = new Map();       // ieee → ms
    this.available = new Map();  // ieee → true|false
    this.otaInfo = new Map();    // ieee → { checked: ms, error: 'check_failed' | 'update_failed' }
    this.recent = [];
    this.pairUntil = 0;
    this.lastError = null;
    this.dirty = false;
    this.lastReport = 0;
    this.reportTimer = null;
    this.account = null;
  }

  /** Den MQTT-Broker des Gateways anhängen (src/edge/gatewayLink.js, nur mit dem Edge-Volume). */
  attach(mqtt) {
    this.mqtt = mqtt || null;
    this._syncMqtt();
  }

  // ─── Konto am Broker ──────────────────────────────────────────────────
  _loadAccount() {
    if (this.account) return this.account;
    let a = null;
    if (this.stateDir) {
      try {
        const j = JSON.parse(readText(path.join(this.stateDir, ACCOUNT_FILE)) || 'null');
        if (j && typeof j.password === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(j.password) && typeof j.hash === 'string' && j.hash.startsWith('$7$')) a = { password: j.password, hash: j.hash };
      } catch { a = null; }
    }
    if (!a) {
      const password = crypto.randomBytes(24).toString('base64url');
      a = { password, hash: hashPassword(password) };
      if (this.stateDir) {
        try { writeAtomic(path.join(this.stateDir, ACCOUNT_FILE), JSON.stringify(a) + '\n', 0o600); } catch (e) { logger.warn({ err: e.message }, 'radio: zigbee2mqtt account not stored'); }
      }
    }
    this.account = a;
    return a;
  }

  _syncMqtt() {
    if (!this.mqtt) return;
    if (!this.wanted) {
      if (this.offSub) { this.offSub(); this.offSub = null; }
      this.mqtt.setLocal({ accounts: [], topics: [] });
      return;
    }
    const a = this._loadAccount();
    this.mqtt.setLocal({ accounts: [{ user: USER, hash: a.hash, acl: [{ access: 'readwrite', topic: BASE + '/#' }] }], topics: [BASE + '/#'] });
    if (!this.offSub) this.offSub = this.mqtt.localSubscribe(BASE + '/#', (t, p) => this.onMessage(t, p));
  }

  brokerState() {
    if (!this.mqtt || !this.mqtt.available()) return 'mqtt_missing';
    if (!this.mqtt.brokerEnabled()) return 'mqtt_off';
    return 'ok';
  }

  // ─── Wunsch und Gerät ─────────────────────────────────────────────────
  /** { want, stick } aus radio.js (der Stick ist schon zugeteilt); missing = der von Hand gewählte Stick fehlt. */
  apply({ want, stick, missing = false }) {
    const before = this.wanted;
    this.wanted = want === true;
    this.stick = stick && stick.tty && stick.dev && ADAPTERS.includes(stick.z2m) ? stick : null;
    // von Hand gewählt, aber zigbee2mqtt kennt keinen Adapter dafür
    this.unsupported = !this.stick && !!(stick && stick.tty && stick.dev);
    this.missing = !this.stick && missing === true;
    if (this.wanted && !this.wantSince) this.wantSince = this.now();
    if (!this.wanted) { this.wantSince = 0; this.bridge = null; this.info = null; }
    this._syncMqtt();
    this._writeControl(this.wanted && this.stick && this.brokerState() === 'ok' ? this.stick : null);
    if (this.wanted && !before) this._startReports();
    if (!this.wanted && before) this._stopReports();
  }

  _ctlUsable() {
    try { fs.accessSync(this.ctlDir, fs.constants.W_OK); return fs.statSync(this.ctlDir).isDirectory(); } catch { return false; }
  }

  _writeControl(dev) {
    if (!this._ctlUsable()) return;
    const file = path.join(this.ctlDir, 'z2m.env');
    try {
      if (!dev) { fs.rmSync(file, { force: true }); return; }
      const a = this._loadAccount();
      const text = `DEVICE=${dev.tty}\nDEV=${dev.dev}\nADAPTER=${dev.z2m}\nBAUD=${dev.z2mBaud || 0}\nMQTT_USER=${USER}\nMQTT_PASS=${a.password}\n`;
      if (readText(file) === text) return;
      writeAtomic(file, text, 0o600);
      logger.info({ device: dev.tty, model: dev.model, adapter: dev.z2m }, 'radio: zigbee2mqtt switched on');
    } catch (e) { logger.warn({ err: e.message }, 'radio: z2m.env not written'); }
  }

  /** Der Wächter im Dienst zigbee2mqtt: { state, tty, alive } oder null (kein Volume). */
  watcher() {
    if (!this._ctlUsable()) return null;
    const m = STATE_RE.exec(readText(path.join(this.ctlDir, 'z2m.state'), 256) || '');
    if (!m) return { state: null, tty: null, alive: false };
    const at = Number(m[3]);
    return { state: m[1], tty: m[2] === '-' ? null : m[2], alive: Number.isFinite(at) && Math.abs(this.now() / 1000 - at) <= ALIVE_S };
  }

  /** managed (Wächter läuft) | absent (Volume da, Dienst nicht) | missing (alte Compose-Datei ohne /gc-radio) */
  service() {
    const w = this.watcher();
    if (!w) return 'missing';
    return w.alive ? 'managed' : 'absent';
  }

  // ─── MQTT ─────────────────────────────────────────────────────────────
  onMessage(topic, payload) {
    if (typeof topic !== 'string' || !topic.startsWith(BASE + '/')) return;
    const rest = topic.slice(BASE.length + 1);
    let text;
    try { text = payload.toString('utf8'); } catch { return; }
    if (rest === 'bridge/state') {
      let s = text;
      try { const j = JSON.parse(text); if (j && typeof j.state === 'string') s = j.state; } catch { /* älteres Format: Text */ }
      this.bridge = s === 'online' ? 'online' : 'offline';
      if (this.bridge === 'online') this.lastError = null;
      return;
    }
    if (rest === 'bridge/info') return this._info(text);
    if (rest === 'bridge/devices') return this._devices(text);
    if (rest === 'bridge/event') return this._event(text);
    if (rest.startsWith(OTA_TOPIC)) return this._otaResponse(rest.slice(OTA_TOPIC.length), text);
    if (rest.startsWith('bridge/')) return;
    let name = rest;
    let avail = false;
    if (name.endsWith('/availability')) { name = name.slice(0, -13); avail = true; }
    if (/\/(set|get)(\/.*)?$/.test(name)) return;
    const ieee = this.byTopic.get(name);
    if (!ieee) return;
    if (avail) {
      let s = text;
      try { const j = JSON.parse(text); if (j && typeof j.state === 'string') s = j.state; } catch { /* Text */ }
      this.available.set(ieee, s === 'online');
      this.dirty = true;
      return;
    }
    let j;
    try { j = JSON.parse(text); } catch { return; }
    const dev = this.devices.get(ieee);
    const before = JSON.stringify(this.values.get(ieee) || {});
    const fresh = valuesOf(j, dev && dev.caps);
    // ein Kanal meldet oft nur sich selbst (state_l2): die anderen bleiben
    if (fresh.ch) fresh.ch = { ...((this.values.get(ieee) || {}).ch || {}), ...fresh.ch };
    const next = { ...(this.values.get(ieee) || {}), ...fresh };
    this.values.set(ieee, next);
    this.seen.set(ieee, this.now());
    if (JSON.stringify(next) !== before) this.dirty = true;
  }

  _info(text) {
    let j;
    try { j = JSON.parse(text); } catch { return; }
    if (!j || typeof j !== 'object') return;
    const net = j.network && typeof j.network === 'object' ? j.network : {};
    const co = j.coordinator && typeof j.coordinator === 'object' ? j.coordinator : {};
    const meta = co.meta && typeof co.meta === 'object' ? co.meta : {};
    this.info = {
      version: typeof j.version === 'string' && /^[0-9][0-9a-z.+-]{0,23}$/i.test(j.version) ? j.version : null,
      coordinator: clean(String(co.type || ''), 24) || null,
      firmware: clean(String(meta.revision || meta.version || ''), 32) || null,
      channel: Number.isInteger(net.channel) && net.channel >= 11 && net.channel <= 26 ? net.channel : null,
      panId: Number.isInteger(net.pan_id) && net.pan_id >= 0 && net.pan_id <= 0xffff ? net.pan_id : null,
    };
    // 2.x: permit_join_end (ms); 1.x: permit_join_timeout (s)
    if (j.permit_join === true) {
      const end = Number.isFinite(j.permit_join_end) ? j.permit_join_end : (Number.isFinite(j.permit_join_timeout) ? this.now() + j.permit_join_timeout * 1000 : this.now() + 60_000);
      this.pairUntil = Math.max(this.pairUntil, Math.min(end, this.now() + 255_000));
    } else if (j.permit_join === false && this.pairUntil > this.now()) this.pairUntil = this.now();
  }

  _devices(text) {
    let list;
    try { list = JSON.parse(text); } catch { return; }
    if (!Array.isArray(list)) return;
    const next = new Map();
    for (const d of list) {
      const dev = deviceOf(d);
      if (!dev || next.has(dev.ieee)) continue;
      next.set(dev.ieee, dev);
      if (next.size >= MAX_DEVICES) break;
    }
    this.devices = next;
    this.byTopic = new Map([...next.values()].map((d) => [d.topic, d.ieee]));
    for (const k of [...this.values.keys()]) if (!next.has(k)) { this.values.delete(k); this.seen.delete(k); this.available.delete(k); }
    for (const k of [...this.otaInfo.keys()]) if (!next.has(k)) this.otaInfo.delete(k);
    this.dirty = true;
  }

  /** Antwort auf bridge/request/device/ota_update/check|update: { data: { id }, status: 'ok' | 'error' }. */
  _otaResponse(action, text) {
    if (action !== 'check' && action !== 'update') return;
    let j;
    try { j = JSON.parse(text); } catch { return; }
    const data = j && j.data && typeof j.data === 'object' ? j.data : {};
    const ieee = ieeeOf(data.id) || this.byTopic.get(String(data.id || '')) || null;
    if (!ieee || !this.devices.has(ieee)) return;
    const info = { ...(this.otaInfo.get(ieee) || {}) };
    if (j.status === 'ok') {
      delete info.error;
      if (action === 'check') {
        info.checked = this.now();
        const v = this.values.get(ieee) || {};
        if (typeof data.update_available === 'boolean' && (v.ota || {}).state !== 'updating') {
          this.values.set(ieee, { ...v, ota: { ...(v.ota || {}), state: data.update_available ? 'available' : 'idle' } });
        }
      }
    } else {
      info.error = action === 'check' ? 'check_failed' : 'update_failed';
      const v = this.values.get(ieee) || {};
      // ein Update, das nicht anläuft: nicht weiter „läuft“ zeigen (zigbee2mqtt meldet den Zustand gleich selbst)
      if (action === 'update' && (v.ota || {}).state === 'updating') this.values.set(ieee, { ...v, ota: { state: 'available' } });
      logger.info({ action, err: clean(String(j.error || ''), 120) }, 'radio: zigbee ota request failed');
    }
    this.otaInfo.set(ieee, info);
    this.dirty = true;
  }

  _event(text) {
    let j;
    try { j = JSON.parse(text); } catch { return; }
    if (!j || typeof j !== 'object' || !j.data || typeof j.data !== 'object') return;
    const mac = macOfIeee(j.data.ieee_address);
    if (!mac) return;
    if (j.type === 'device_joined' || (j.type === 'device_interview' && j.data.status === 'successful')) {
      const def = j.data.definition && typeof j.data.definition === 'object' ? j.data.definition : {};
      const entry = { mac, type: 'device', name: clean(j.data.friendly_name, 48) || null, model: clean(def.model, 48) || null,
        manufacturer: clean(def.vendor, 48) || null, at: new Date(this.now()).toISOString() };
      const i = this.recent.findIndex((r) => r.mac === mac);
      if (i >= 0) this.recent[i] = { ...this.recent[i], ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v)) };
      else { this.recent.unshift(entry); logger.info({ model: entry.model }, 'radio: new zigbee device (zigbee2mqtt)'); }
      this.recent = this.recent.slice(0, MAX_RECENT);
    }
    if (j.type === 'device_leave') this.recent = this.recent.filter((r) => r.mac !== mac);
  }

  async _publish(topic, body) {
    if (!this.mqtt) throw Object.assign(new Error('no broker'), { code: 'not_running' });
    await this.mqtt.localPublish(topic, Buffer.from(JSON.stringify(body)), { qos: 0, retain: false });
  }

  running() { return this.wanted && this.bridge === 'online' && !!(this.mqtt && this.mqtt.localReady()); }
  pairing() { return this.now() <= this.pairUntil + PAIR_TAIL_MS; }

  /** „Anlernen starten“: 'accepted' | 'not_running'. */
  async pair(seconds) {
    const s = Number.isInteger(seconds) ? Math.min(254, Math.max(60, seconds)) : 180;
    if (!this.running()) return 'not_running';
    await this._publish(BASE + '/bridge/request/permit_join', { time: s });
    this.pairUntil = this.now() + s * 1000;
    logger.info({ seconds: s }, 'radio: zigbee pairing window open (zigbee2mqtt)');
    return 'accepted';
  }

  /** Gerät entfernen (aus dem Zigbee-Netz abmelden): 'accepted' | 'not_running' | 'not_found'. */
  async remove(id) {
    const ieee = ieeeOf(id);
    if (!ieee || !this.devices.has(ieee)) return 'not_found';
    if (!this.running()) return 'not_running';
    await this._publish(BASE + '/bridge/request/device/remove', { id: ieee, force: false });
    return 'accepted';
  }

  /** Gerät schalten (Smart Home über den Server): 'accepted' | 'not_running' | 'not_found' | 'invalid'. */
  async set(id, set) {
    const ieee = ieeeOf(id);
    const dev = ieee && this.devices.get(ieee);
    if (!dev) return 'not_found';
    if (set && typeof set === 'object' && 'ota' in set) return this._ota(dev, set.ota);
    const body = setPayload(dev, set);
    if (!body) return 'invalid';
    if (!this.running()) return 'not_running';
    await this._publish(`${BASE}/${dev.topic}/set`, body);
    // sofort mitführen; zigbee2mqtt meldet den echten Zustand gleich danach
    const v = { ...(this.values.get(ieee) || {}) };
    if (body[dev.caps.stateProp || 'state'] === 'ON' || body[dev.caps.stateProp || 'state'] === 'OFF') v.on = body[dev.caps.stateProp || 'state'] === 'ON';
    if (Number.isFinite(body.brightness)) v.bri = Math.round(body.brightness / 2.54);
    if (set && typeof set.channel === 'string') v.ch = { ...(v.ch || {}), [set.channel]: set.on === true };
    if (dev.kind === 'climate') {
      if (Number.isFinite(body[dev.caps.setpointProp])) v.setpoint = body[dev.caps.setpointProp];
      if (typeof body.system_mode === 'string') v.mode = body.system_mode;
    }
    this.values.set(ieee, v);
    this.dirty = true;
    return 'accepted';
  }

  /** Firmware über Funk: nach einem Update suchen ('check') oder es starten ('update'). */
  async _ota(dev, action) {
    if ((action !== 'check' && action !== 'update') || !dev.caps.ota) return 'invalid';
    if (!this.running()) return 'not_running';
    await this._publish(`${BASE}/bridge/request/device/ota_update/${action}`, { id: dev.ieee });
    const info = { ...(this.otaInfo.get(dev.ieee) || {}) };
    delete info.error;
    this.otaInfo.set(dev.ieee, info);
    if (action === 'update') {
      const v = this.values.get(dev.ieee) || {};
      this.values.set(dev.ieee, { ...v, ota: { ...(v.ota || {}), state: 'updating', progress: 0 } });
    }
    this.dirty = true;
    logger.info({ model: dev.model, action }, 'radio: zigbee ota requested');
    return 'accepted';
  }

  // ─── Zustand ──────────────────────────────────────────────────────────
  state() {
    if (!this.wanted) return 'off';
    if (!this.stick) return this.missing ? 'stick_missing' : (this.unsupported ? 'unsupported' : 'no_stick');
    const b = this.brokerState();
    if (b !== 'ok') return b;
    if (this.running()) return 'running';
    const svc = this.service();
    if (svc === 'missing') return 'service_missing';
    const w = this.watcher();
    if (svc === 'absent') {
      if (this.askHost && this.askHost('zigbee2mqtt')) return 'starting';
      return this.now() - this.wantSince < START_GRACE_MS ? 'starting' : 'service_missing';
    }
    if (w && w.state === 'exit') return 'error';
    if (w && w.state === 'wait') return 'error';
    return this.now() - this.wantSince < START_GRACE_MS ? 'starting' : 'error';
  }

  /** Geräteliste für den Server und den Reiter „Funk“. */
  list() {
    return [...this.devices.values()].map((d) => {
      const { stateProp, chProps, setpointProp, ...caps } = d.caps; // eslint-disable-line no-unused-vars
      let values = this.values.get(d.ieee) || {};
      if (caps.ota) {
        const info = this.otaInfo.get(d.ieee) || {};
        values = { ...values, ota: { state: 'idle', ...(values.ota || {}), ...(info.checked ? { checked: new Date(info.checked).toISOString() } : {}), ...(info.error ? { error: info.error } : {}) } };
      }
      return {
        ieee: d.mac, name: d.name, model: d.model, vendor: d.vendor, description: d.description, type: d.type, power: d.power,
        supported: d.supported, interview: d.interview, disabled: d.disabled, kind: d.kind, caps,
        values,
        available: this.available.has(d.ieee) ? this.available.get(d.ieee) : null,
        seenAt: this.seen.has(d.ieee) ? new Date(this.seen.get(d.ieee)).toISOString() : null,
      };
    }).sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, MAX_DEVICES);
  }

  telemetry() {
    const now = this.now();
    this.recent = this.recent.filter((r) => now - Date.parse(r.at) < RECENT_MS).slice(0, MAX_RECENT);
    const state = this.state();
    let error = this.lastError;
    if (state === 'error' && !error) {
      const w = this.watcher();
      error = { at: now, code: w && w.state === 'wait' ? 'z2m_device' : (w && w.state === 'exit' ? 'z2m_exit' : (this.bridge === 'offline' ? 'z2m_offline' : 'z2m_unreachable')), message: '' };
    }
    return {
      want: this.wanted,
      service: this.service(),
      state,
      broker: this.brokerState(),
      model: this.stick ? this.stick.model : null,
      device: this.stick ? this.stick.tty : null,
      adapter: this.stick ? this.stick.z2m : null,
      version: this.info ? this.info.version : null,
      firmware: this.info ? this.info.firmware : null,
      channel: this.info ? this.info.channel : null,
      devices: state === 'running' ? this.devices.size : null,
      permitUntil: this.pairUntil > now ? new Date(this.pairUntil).toISOString() : null,
      recent: this.recent.map((r) => ({ ...r })),
      error: state === 'running' ? null : error,
    };
  }

  // ─── Bericht an den Server ────────────────────────────────────────────
  async report(force = false) {
    if (!this.reporter || !this.wanted || this.bridge !== 'online') return null;
    const now = this.now();
    const due = force || (this.dirty && now - this.lastReport >= REPORT_MIN_MS) || now - this.lastReport >= REPORT_MAX_MS;
    if (!due) return null;
    this.dirty = false;
    this.lastReport = now;
    const r = await this.reporter.post('/api/v1/gateway/radio/zigbee', { stack: 'zigbee2mqtt', reportedAt: new Date(now).toISOString(), devices: this.list() });
    if (!r.ok && r.status !== 404) logger.debug({ status: r.status, err: r.error }, 'radio: zigbee report failed');
    return r;
  }
  _startReports() {
    if (this.reportTimer) return;
    this.reportTimer = setInterval(() => { this.report().catch(() => {}); }, 2_500);
    if (this.reportTimer.unref) this.reportTimer.unref();
  }
  _stopReports() { if (this.reportTimer) clearInterval(this.reportTimer); this.reportTimer = null; }

  stop() {
    this._stopReports();
    if (this.offSub) { this.offSub(); this.offSub = null; }
  }
}

module.exports = { Zigbee2Mqtt, summarize, valuesOf, setPayload, deviceOf, macOfIeee, ieeeOf, USER, ACCOUNT_FILE, BASE };
