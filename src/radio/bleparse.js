'use strict';

// Bluetooth-Werbepakete der Sensoren lesen (Phase 3c, Schritt 2 §5).
//   BTHome v2      Service-Daten UUID 0xFCD2 (Shelly BLU, ATC/pvvx mit BTHome) – verschlüsselt mit Schlüssel
//   ATC1441        UUID 0x181A, 13 Byte (Xiaomi LYWSD03MMC mit eigener Firmware)
//   pvvx           UUID 0x181A, 15 Byte (dto., Format „custom“)
//   MiBeacon       UUID 0xFE95 (Xiaomi-Originalfirmware) – v4/v5 verschlüsselt mit Bindkey, sonst Klartext-Objekte
// Schlüssel je Sensor (blekeys.js) über `keyFor(mac)`; Entschlüsselung in blecrypto.js.
// Alles ist Funk von irgendwem: Längen geprüft, nichts vertraut.

const { decryptBthome, decryptMibeacon, mibeaconValues } = require('./blecrypto');

const AD_NAME_SHORT = 0x08;
const AD_NAME_FULL = 0x09;
const AD_SERVICE_DATA16 = 0x16;

const UUID_BTHOME = 0xfcd2;
const UUID_ENV = 0x181a;
const UUID_MIBEACON = 0xfe95;

/**
 * BTHome-v2-Objekte, die vorkommen: id → [Name, Bytes, vorzeichenbehaftet, Faktor].
 * Die Liste muss lückenlos die Längen kennen – ein unbekanntes Objekt beendet das Lesen
 * (danach kann nichts mehr sicher gelesen werden).
 */
const OBJ = {
  0x00: ['packet', 1, false, 1],
  0x01: ['battery', 1, false, 1],
  0x02: ['temperature', 2, true, 0.01],
  0x03: ['humidity', 2, false, 0.01],
  0x04: ['pressure', 3, false, 0.01],
  0x05: ['illuminance', 3, false, 0.01],
  0x06: ['mass', 2, false, 0.01],
  0x07: ['mass_lb', 2, false, 0.01],
  0x08: ['dewpoint', 2, true, 0.01],
  0x09: ['count', 1, false, 1],
  0x0a: ['energy', 3, false, 0.001],
  0x0b: ['power', 3, false, 0.01],
  0x0c: ['voltage', 2, false, 0.001],
  0x0d: ['pm25', 2, false, 1],
  0x0e: ['pm10', 2, false, 1],
  0x12: ['co2', 2, false, 1],
  0x13: ['tvoc', 2, false, 1],
  0x14: ['moisture', 2, false, 0.01],
  0x2e: ['humidity', 1, false, 1],
  0x2f: ['moisture', 1, false, 1],
  0x3a: ['button', 1, false, 1],
  0x3c: ['dimmer', 2, false, 1],
  0x3d: ['count', 2, false, 1],
  0x3e: ['count', 4, false, 1],
  0x3f: ['rotation', 2, true, 0.1],
  0x40: ['distance_mm', 2, false, 1],
  0x41: ['distance_m', 2, false, 0.1],
  0x42: ['duration', 3, false, 0.001],
  0x43: ['current', 2, false, 0.001],
  0x44: ['speed', 2, false, 0.01],
  0x45: ['temperature', 2, true, 0.1],
  0x46: ['uv', 1, false, 0.1],
  0x47: ['volume', 2, false, 0.1],
  0x48: ['volume_ml', 2, false, 1],
  0x49: ['flow', 2, false, 0.001],
  0x4a: ['voltage', 2, false, 0.1],
  0x4b: ['gas', 3, false, 0.001],
  0x4c: ['gas', 4, false, 0.001],
  0x4d: ['energy', 4, false, 0.001],
  0x4e: ['volume', 4, false, 0.001],
  0x4f: ['water', 4, false, 0.001],
  0x50: ['timestamp', 4, false, 1],
  0x51: ['acceleration', 2, false, 0.001],
  0x52: ['gyroscope', 2, false, 0.001],
  0x55: ['volume_storage', 4, false, 0.001],
  0x56: ['conductivity', 2, false, 1],
  0x57: ['temperature', 1, true, 1],
  0x58: ['temperature', 1, true, 0.35],
  0x59: ['count', 1, true, 1],
  0x5a: ['count', 2, true, 1],
  0x5b: ['count', 4, true, 1],
  0x5c: ['power', 4, true, 0.01],
  0x5d: ['current', 2, true, 0.001],
  0x5e: ['direction', 2, false, 0.01],
  0x5f: ['precipitation', 2, false, 1],
  0x60: ['channel', 1, false, 1],
  0x61: ['rotational_speed', 2, false, 1],
  0xf0: ['device_type', 2, false, 1],
  0xf1: ['firmware', 4, false, 1],
  0xf2: ['firmware', 3, false, 1],
};
// Binärsensoren 0x0F…0x2D (je 1 Byte): die, die wir zeigen
const BINARY = {
  0x0f: 'generic', 0x10: 'power_on', 0x11: 'opening', 0x15: 'battery_low', 0x16: 'charging', 0x1a: 'door', 0x1c: 'gas_detected',
  0x1d: 'heat', 0x1e: 'light', 0x1f: 'lock', 0x20: 'moisture_wet', 0x21: 'motion', 0x22: 'moving', 0x23: 'occupancy',
  0x26: 'presence', 0x29: 'smoke', 0x2a: 'sound', 0x2b: 'tamper', 0x2c: 'vibration', 0x2d: 'window',
};
// nur diese Werte gehen an den Server (der Rest ist für Sensoren hier ohne Belang)
const KEEP = new Set(['battery', 'temperature', 'humidity', 'pressure', 'illuminance', 'dewpoint', 'voltage', 'pm25', 'pm10', 'co2',
  'tvoc', 'moisture', 'button', 'uv', 'power', 'energy', 'opening', 'door', 'window', 'motion', 'occupancy', 'presence',
  'moisture_wet', 'smoke', 'battery_low', 'vibration', 'tamper', 'light']);

const round = (v, f) => {
  const digits = f >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(f)));
  return Number(v.toFixed(digits));
};

function readUInt(buf, off, len) {
  let v = 0;
  for (let i = len - 1; i >= 0; i--) v = v * 256 + buf[off + i];
  return v;
}
function readInt(buf, off, len) {
  const u = readUInt(buf, off, len);
  const max = 2 ** (8 * len);
  return u >= max / 2 ? u - max : u;
}

/** AD-Strukturen [len][type][data…] → [{ type, data }] (kaputte Längen beenden das Lesen). */
function adStructures(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const len = buf[i];
    if (len === 0 || i + 1 + len > buf.length) break;
    out.push({ type: buf[i + 1], data: buf.subarray(i + 2, i + 1 + len) });
    i += 1 + len;
  }
  return out;
}

/** BTHome v2 → { encrypted, values } oder null. */
function parseBthome(data) {
  if (data.length < 1) return null;
  const info = data[0];
  if ((info >> 5) !== 2) return null;            // nur Version 2
  if (info & 0x01) return { encrypted: true, values: {} };
  const values = {};
  let i = 1;
  while (i < data.length) {
    const id = data[i];
    if (id === 0x0f || id === 0x10 || id === 0x11 || (id >= 0x15 && id <= 0x2d)) {
      if (i + 1 >= data.length) break;
      if (BINARY[id]) values[BINARY[id]] = data[i + 1] === 1;
      i += 2;
      continue;
    }
    if (id === 0x53 || id === 0x54) {            // Text / roh: Länge davor
      if (i + 1 >= data.length) break;
      i += 2 + data[i + 1];
      continue;
    }
    const o = OBJ[id];
    if (!o) break;
    const [name, len, signed, factor] = o;
    if (i + 1 + len > data.length) break;
    const raw = signed ? readInt(data, i + 1, len) : readUInt(data, i + 1, len);
    // „button“ kommt mehrfach vor (je Taste) – der erste zählt
    if (values[name] === undefined) values[name] = round(raw * factor, factor);
    i += 1 + len;
  }
  return { encrypted: false, values };
}

/** ATC1441 (13 Byte) oder pvvx (15 Byte) unter UUID 0x181A → { format, values } oder null. */
function parseEnv(data, mac) {
  const macHex = String(mac || '').replace(/:/g, '').toLowerCase();
  if (data.length === 13) {
    if (data.subarray(0, 6).toString('hex') !== macHex) return null;
    return {
      format: 'atc1441',
      values: {
        temperature: round(data.readInt16BE(6) * 0.1, 0.1),
        humidity: data[8],
        battery: data[9],
        voltage: round(data.readUInt16BE(10) * 0.001, 0.001),
      },
    };
  }
  if (data.length === 15) {
    if (Buffer.from(data.subarray(0, 6)).reverse().toString('hex') !== macHex) return null;
    return {
      format: 'pvvx',
      values: {
        temperature: round(data.readInt16LE(6) * 0.01, 0.01),
        humidity: round(data.readUInt16LE(8) * 0.01, 0.01),
        voltage: round(data.readUInt16LE(10) * 0.001, 0.001),
        battery: data[12],
      },
    };
  }
  return null;
}

function cleanName(buf) {
  let s = '';
  for (const ch of buf.toString('utf8')) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127 && ch !== '�') s += ch;
  }
  return s.trim().slice(0, 32) || null;
}

/** MiBeacon ohne Verschlüsselung: die Objekte hinter Kopf, MAC und Fähigkeit (ältere Sensoren, z. B. LYWSDCGQ). */
function mibeaconPlain(data) {
  const fc = data.readUInt16LE(0);
  if (!(fc & 0x0040)) return {};
  let i = 5;
  if (fc & 0x0010) i += 6;
  if (fc & 0x0020) { if (data.length <= i) return {}; i += (data[i] & 0x20) ? 2 : 1; }
  return i < data.length ? mibeaconValues(data.subarray(i)) : {};
}

/**
 * Ein Werbepaket → { format, encrypted, decrypted, keyState, name, values } eines bekannten Sensors oder null.
 * keyState: null (unverschlüsselt) | 'ok' | 'no_key' | 'wrong_key' | 'unsupported' (MiBeacon vor v4).
 * @param {{ keyFor?: (mac: string) => string|null }} [o]
 */
function parseAdvert(mac, buf, { keyFor = null } = {}) {
  let name = null;
  let found = null;
  const key = () => (typeof keyFor === 'function' ? keyFor(mac) : null);
  for (const ad of adStructures(buf)) {
    if (ad.type === AD_NAME_FULL || ad.type === AD_NAME_SHORT) name = cleanName(ad.data) || name;
    if (ad.type !== AD_SERVICE_DATA16 || ad.data.length < 2 || found) continue;
    const uuid = ad.data.readUInt16LE(0);
    const rest = ad.data.subarray(2);
    if (uuid === UUID_BTHOME) {
      const r = parseBthome(rest);
      if (!r) continue;
      if (!r.encrypted) { found = { format: 'bthome', encrypted: false, keyState: null, values: r.values }; continue; }
      const k = key();
      if (!k) { found = { format: 'bthome', encrypted: true, keyState: 'no_key', values: {} }; continue; }
      const d = decryptBthome(mac, rest, k);
      const p = d.ok ? parseBthome(d.plain) : null;
      found = p ? { format: 'bthome', encrypted: true, keyState: 'ok', values: p.values } : { format: 'bthome', encrypted: true, keyState: 'wrong_key', values: {} };
    } else if (uuid === UUID_ENV) {
      const r = parseEnv(rest, mac);
      if (r) found = { format: r.format, encrypted: false, keyState: null, values: r.values };
    } else if (uuid === UUID_MIBEACON && rest.length >= 5) {
      const fc = rest.readUInt16LE(0);
      if (!(fc & 0x0008)) { found = { format: 'mibeacon', encrypted: false, keyState: null, values: mibeaconPlain(rest) }; continue; }
      if ((fc >> 12) < 4) { found = { format: 'mibeacon', encrypted: true, keyState: 'unsupported', values: {} }; continue; }
      // ohne Objekt-Bit (nur Anmeldung/Kopf) gibt es nichts zu entschlüsseln
      if (!(fc & 0x0040)) { found = { format: 'mibeacon', encrypted: true, keyState: key() ? 'ok' : 'no_key', values: {} }; continue; }
      const k = key();
      if (!k) { found = { format: 'mibeacon', encrypted: true, keyState: 'no_key', values: {} }; continue; }
      const d = decryptMibeacon(mac, rest, k);
      found = d.ok ? { format: 'mibeacon', encrypted: true, keyState: 'ok', values: mibeaconValues(d.objects) } : { format: 'mibeacon', encrypted: true, keyState: d.reason === 'wrong_key' ? 'wrong_key' : 'unsupported', values: {} };
    }
  }
  if (!found) return null;
  const values = {};
  for (const [k, v] of Object.entries(found.values)) if (KEEP.has(k) && (typeof v === 'boolean' || Number.isFinite(v))) values[k] = v;
  return { ...found, decrypted: found.keyState === 'ok', values, name };
}

module.exports = { parseAdvert, parseBthome, parseEnv, mibeaconPlain, adStructures, UUID_BTHOME, UUID_ENV, UUID_MIBEACON };
