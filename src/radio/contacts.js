'use strict';

// Fensterkontakte für Edge-Teile (docs/radio.md „Fensterkontakte für Edge-Teile“,
// Capability `radio-contacts` im Heartbeat und im `hello` unter `gw.features`).
//
// Das Gateway hört Tür-/Fensterkontakte selbst: Bluetooth-Sensoren (BTHome
// window/door/opening, z. B. Shelly BLU Door/Window) und zigbee2mqtt-Geräte mit
// `contact`. Damit ein Edge-Teil (die Heizung des Smart-Home-Plugins) auch ohne
// Server reagieren kann, legt das Gateway den Zustand jedes Kontakts als
// gehaltene (retained) Nachricht an seinen MQTT-Broker:
//
//   gatecontrol/contacts                 { v: 1, sources: ['ble', 'z2m'] } – das Gateway liefert (Merkmal)
//   gatecontrol/contacts/ble-<12 hex>    { open, since, seen }   Bluetooth (MAC ohne Doppelpunkte, klein)
//   gatecontrol/contacts/z2m-<16 hex>    { open, since, seen, online }   zigbee2mqtt (IEEE-Adresse ohne 0x)
//
// open: true = offen; since: seit wann (ms) dieser Zustand gilt; seen: letzte
// Meldung des Kontakts (ms); online (zigbee2mqtt): availability, sonst fehlt es.
// Gesendet bei jeder Änderung von open/online, sonst höchstens alle 10 Min. mit
// neuem `seen`. Ein Kontakt, der 24 h nichts meldet, wird gelöscht (leere
// gehaltene Nachricht). Nach einem neuen Verbindungsaufbau zum Broker geht alles
// noch einmal raus (der Broker kann neu gestartet sein).
//
// Lesen dürfen nur Edge-Teile, denen GateControl das Topic `gatecontrol/contacts/#`
// genehmigt hat (Pflicht- oder bestätigte optionale Fähigkeit) – die üblichen
// Regeln des Brokers (src/edge/mqtt/manager.js). Schreiben kann nur das Gateway.

const logger = require('../logger');

const ROOT = 'gatecontrol/contacts';
const FEATURE = 'radio-contacts';
const MAX_CONTACTS = 128;
const REFRESH_MS = 10 * 60_000;
const FORGET_MS = 24 * 3600_000;
const BLE_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const IEEE_RE = /^0x[0-9a-f]{16}$/;

/** Ein Bluetooth-Sensor (ble.list()) → { id, open, seen } oder null (kein Kontakt). */
function fromBle(s) {
  if (!s || typeof s.mac !== 'string' || !BLE_RE.test(s.mac)) return null;
  const v = s.values && typeof s.values === 'object' ? s.values : {};
  const flags = ['window', 'door', 'opening'].filter((k) => typeof v[k] === 'boolean');
  if (!flags.length) return null;
  const seen = Date.parse(s.seenAt);
  return { id: 'ble-' + s.mac.replace(/:/g, '').toLowerCase(), open: flags.some((k) => v[k] === true), seen: Number.isFinite(seen) ? seen : null };
}

/** Ein zigbee2mqtt-Gerät ({ ieee: '0x…', values, seen, available }) → { id, open, seen, online } oder null. */
function fromZ2m(d) {
  if (!d || typeof d.ieee !== 'string' || !IEEE_RE.test(d.ieee)) return null;
  const v = d.values && typeof d.values === 'object' ? d.values : {};
  if (typeof v.opening !== 'boolean') return null;
  const out = { id: 'z2m-' + d.ieee.slice(2), open: v.opening, seen: Number.isFinite(d.seen) ? d.seen : null };
  if (typeof d.available === 'boolean') out.online = d.available;
  return out;
}

class ContactFeed {
  /**
   * @param {object} o
   * @param {() => Array} o.ble   Bluetooth-Sensoren (BleScanner.list)
   * @param {() => Array} o.z2m   Kontakte von zigbee2mqtt (Zigbee2Mqtt.contacts)
   */
  constructor({ ble = () => [], z2m = () => [], now = Date.now } = {}) {
    Object.assign(this, { ble, z2m, now });
    this.mqtt = null;
    this.known = new Map(); // id → { open, online, since, seen, sentAt }
    this.ready = false;     // war beim letzten Lauf verbunden
    this.busy = false;
  }

  /** Den MQTT-Broker des Gateways anhängen (wie zigbee2mqtt; null = kein Edge-Volume). */
  attach(mqtt) {
    this.mqtt = mqtt || null;
    if (this.mqtt && typeof this.mqtt.setLocal === 'function') this.mqtt.setLocal({ accounts: [], topics: [ROOT + '/#'] }, 'contacts');
    this.ready = false;
  }

  /** Was gerade gilt: Map id → { open, online?, seen }. */
  current() {
    const out = new Map();
    const add = (c) => { if (c && !out.has(c.id) && out.size < MAX_CONTACTS) out.set(c.id, c); };
    try { for (const s of this.ble() || []) add(fromBle(s)); } catch (e) { logger.debug({ err: e.message }, 'radio: bluetooth contacts not read'); }
    try { for (const d of this.z2m() || []) add(fromZ2m(d)); } catch (e) { logger.debug({ err: e.message }, 'radio: zigbee contacts not read'); }
    return out;
  }

  /** Einmal abgleichen und Änderungen senden (wirft nie). → Anzahl gesendeter Nachrichten */
  async tick() {
    if (this.busy) return 0;
    this.busy = true;
    try { return await this._tick(); } catch (e) { logger.debug({ err: e.message }, 'radio: contact feed failed'); return 0; } finally { this.busy = false; }
  }

  async _tick() {
    const now = this.now();
    const cur = this.current();
    // Zustand nachführen (auch ohne Broker – „since“ soll stimmen, sobald er da ist)
    for (const [id, c] of cur) {
      const k = this.known.get(id);
      const seen = c.seen != null ? c.seen : (k ? k.seen : now);
      if (!k) { this.known.set(id, { open: c.open, online: c.online, since: seen, seen, sentAt: 0 }); continue; }
      if (k.open !== c.open) { k.open = c.open; k.since = seen; k.sentAt = 0; }
      if (k.online !== c.online) { k.online = c.online; k.sentAt = 0; }
      if (seen > k.seen) k.seen = seen;
    }
    const gone = [];
    for (const [id, k] of this.known) if (!cur.has(id) && now - k.seen > FORGET_MS) gone.push(id);
    const m = this.mqtt;
    const ready = !!(m && typeof m.localReady === 'function' && m.localReady());
    if (!ready) {
      this.ready = false;
      for (const id of gone) this.known.delete(id);
      return 0;
    }
    let sent = 0;
    const pub = async (topic, body) => {
      await m.localPublish(topic, Buffer.from(body === null ? '' : JSON.stringify(body)), { qos: 0, retain: true });
      sent++;
    };
    const fresh = !this.ready;
    if (fresh) await pub(ROOT, { v: 1, feature: FEATURE, sources: ['ble', 'z2m'] });
    for (const id of gone) { await pub(`${ROOT}/${id}`, null); this.known.delete(id); }
    for (const [id, k] of this.known) {
      if (!fresh && k.sentAt && now - k.sentAt < REFRESH_MS) continue;
      const body = { open: k.open, since: k.since, seen: k.seen };
      if (typeof k.online === 'boolean') body.online = k.online;
      await pub(`${ROOT}/${id}`, body);
      k.sentAt = now;
    }
    this.ready = true;
    return sent;
  }
}

module.exports = { ContactFeed, fromBle, fromZ2m, ROOT, FEATURE, REFRESH_MS, FORGET_MS };
