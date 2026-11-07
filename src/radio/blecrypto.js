'use strict';

// Verschlüsselte Bluetooth-Sensoren entschlüsseln (docs/radio.md „Verschlüsselte Sensoren“).
//   BTHome v2  Geräteinfo-Bit 0: AES-128-CCM, Schlüssel 16 Byte, MIC 4 Byte, ohne AAD;
//              Nonce = MAC (6) ‖ UUID 0xFCD2 (LE) ‖ Geräteinfo (1) ‖ Zähler (4);
//              Nutzdaten = Geräteinfo ‖ Chiffrat ‖ Zähler (4) ‖ MIC (4)
//   MiBeacon   Version 4/5 (Rahmen-Bit 3): AES-128-CCM, Bindkey 16 Byte, MIC 4 Byte, AAD 0x11;
//              Nonce = MAC rückwärts (6) ‖ Produkt-ID (2) ‖ Zähler (1) ‖ erweiterter Zähler (3);
//              Objekte: Typ (2, LE) ‖ Länge (1) ‖ Wert
// Der Schlüssel kommt vom Server (src/radio/blekeys.js) und steht nie im Log.
// Ein falscher Schlüssel ist kein Fehler des Gateways, sondern ein Zustand des Sensors.

const crypto = require('node:crypto');

const KEY_RE = /^[0-9a-f]{32}$/;

function keyBuf(hex) {
  const k = String(hex || '').toLowerCase();
  return KEY_RE.test(k) ? Buffer.from(k, 'hex') : null;
}

function ccm(key, nonce, cipher, tag, aad) {
  try {
    const d = crypto.createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: 4 });
    d.setAuthTag(tag);
    if (aad) d.setAAD(aad, { plaintextLength: cipher.length });
    return Buffer.concat([d.update(cipher), d.final()]);
  } catch { return null; }
}

function macBytes(mac) {
  const h = String(mac || '').replace(/:/g, '');
  return /^[0-9A-Fa-f]{12}$/.test(h) ? Buffer.from(h, 'hex') : null;
}

/**
 * BTHome v2 (Service-Daten nach der UUID, beginnend mit dem Geräteinfo-Byte) →
 * { ok: true, plain: Buffer (Geräteinfo ohne Verschlüsselungs-Bit ‖ Klartext-Objekte), counter } | { ok: false }
 */
function decryptBthome(mac, data, keyHex) {
  const key = keyBuf(keyHex);
  const m = macBytes(mac);
  if (!key || !m || !Buffer.isBuffer(data) || data.length < 1 + 1 + 8) return { ok: false };
  const info = data[0];
  const cipher = data.subarray(1, data.length - 8);
  const counter = data.subarray(data.length - 8, data.length - 4);
  const tag = data.subarray(data.length - 4);
  const nonce = Buffer.concat([m, Buffer.from([0xd2, 0xfc, info]), counter]);
  const plain = ccm(key, nonce, cipher, tag, null);
  if (!plain) return { ok: false };
  return { ok: true, plain: Buffer.concat([Buffer.from([info & 0xfe]), plain]), counter: counter.readUInt32LE(0) };
}

/** MiBeacon v4/v5 (Service-Daten nach der UUID 0xFE95) → { ok, objects: Buffer, version, productId } | { ok: false, reason } */
function decryptMibeacon(mac, data, keyHex) {
  if (!Buffer.isBuffer(data) || data.length < 5) return { ok: false, reason: 'short' };
  const fc = data.readUInt16LE(0);
  const version = fc >> 12;
  if (!(fc & 0x0008)) return { ok: false, reason: 'plain' };
  if (version < 4) return { ok: false, reason: 'legacy' };
  const key = keyBuf(keyHex);
  if (!key) return { ok: false, reason: 'no_key' };
  let i = 5;
  let m = macBytes(mac);
  if (fc & 0x0010) {
    if (data.length < i + 6) return { ok: false, reason: 'short' };
    m = Buffer.from(data.subarray(i, i + 6)).reverse(); // im Paket steht die MAC rückwärts
    i += 6;
  }
  if (!m) return { ok: false, reason: 'short' };
  if (fc & 0x0020) {
    if (data.length < i + 1) return { ok: false, reason: 'short' };
    const cap = data[i];
    i += (cap & 0x20) ? 2 : 1; // wie xiaomi-ble: Fähigkeit (1) und ggf. I/O-Fähigkeit
  }
  const p = data.subarray(i);
  if (p.length < 7 + 1) return { ok: false, reason: 'short' };
  const nonce = Buffer.concat([Buffer.from(m).reverse(), data.subarray(2, 5), p.subarray(p.length - 7, p.length - 4)]);
  const plain = ccm(key, nonce, p.subarray(0, p.length - 7), p.subarray(p.length - 4), Buffer.from([0x11]));
  if (!plain) return { ok: false, reason: 'wrong_key' };
  return { ok: true, objects: plain, version, productId: data.readUInt16LE(2) };
}

/** MiBeacon-Objekte → Werte (Namen wie bei BTHome). Unbekannte Objekte werden übersprungen. */
function mibeaconValues(buf) {
  const v = {};
  let i = 0;
  while (i + 3 <= buf.length) {
    const type = buf.readUInt16LE(i);
    const len = buf[i + 2];
    const d = buf.subarray(i + 3, i + 3 + len);
    if (d.length !== len) break;
    i += 3 + len;
    switch (type) {
      case 0x1004: if (len === 2) v.temperature = d.readInt16LE(0) / 10; break;
      case 0x1006: if (len === 2) v.humidity = d.readUInt16LE(0) / 10; break;
      case 0x100a: if (len >= 1) v.battery = d[0]; break;
      case 0x100d: if (len === 4) { v.temperature = d.readInt16LE(0) / 10; v.humidity = d.readUInt16LE(2) / 10; } break;
      case 0x1007: if (len === 3) v.illuminance = d.readUIntLE(0, 3); break;
      case 0x1008: if (len === 1) v.moisture = d[0]; break;
      case 0x1018: if (len === 1) v.light = d[0] === 1; break;
      case 0x1019: if (len === 1 && d[0] <= 1) v.opening = d[0] === 0; break;
      case 0x4803: if (len === 1) v.battery = d[0]; break;
      case 0x4c01: if (len === 4) v.temperature = Math.round(d.readFloatLE(0) * 100) / 100; break;
      case 0x4c02: if (len === 1) v.humidity = d[0]; break;
      case 0x4c08: if (len === 4) v.humidity = Math.round(d.readFloatLE(0) * 100) / 100; break;
      default: break;
    }
  }
  for (const k of Object.keys(v)) if (typeof v[k] === 'number' && !Number.isFinite(v[k])) delete v[k];
  return v;
}

module.exports = { decryptBthome, decryptMibeacon, mibeaconValues, KEY_RE };
