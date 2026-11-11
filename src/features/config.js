'use strict';

// Funktionsschalter aus dem Config-Pull (Vertrag Phase 3a, Abschnitt 1).
// Fehlt `features` (alter Server), ist alles aus – das Gateway verhält sich
// wie bisher. Alles hier ist Server-Eingabe und wird geprüft/gekürzt.

const crypto = require('node:crypto');
const net = require('node:net');
const { normalizeMac } = require('./macs');
const { isUlaIpv6 } = require('../discovery/lanInterfaces');
const { validTimezone } = require('./timezone');
const { normalizeDns } = require('../dns/config');
const { normalizeCache } = require('../cache/config');
const { normalizePrint } = require('../print/config');
const { normalizeRadio } = require('../radio/config');
const { normalizeAi } = require('../ai/config');
const { normalizeCameras } = require('../cameras/config');

const DEFAULT_TARGETS = Object.freeze(['1.1.1.1', '9.9.9.9']);
const SPEEDTEST_PLANS = new Set(['off', '4x', 'hourly']);
const MAX_PRESENCE_MACS = 256;
const MAX_TARGETS = 4;
const AWAY_DEFAULT_S = 600;
const UPS_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9-]{1,63}$/;

function isHostname(h) {
  return h.length <= 253 && h.split('.').every((l) => LABEL_RE.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

// Volumen der Speedtests (features.inetq.speedVolume, Server ab der Fassung mit
// diesem Feld; fehlt es: Tageslimit wie bisher 12 GB, kein Deckel je Test).
const SPEED_MIN_BYTES = 1_000_000;
const SPEED_MAX_DAY_BYTES = 1_000_000_000_000;
const speedBytes = (v) => (Number.isSafeInteger(v) && v >= SPEED_MIN_BYTES && v <= SPEED_MAX_DAY_BYTES ? v : null);


/** Öffentlich sinnvolle IPv4-Messziele: keine Null-, Loopback-, Multicast- oder Broadcast-Adressen. */
function isUsableTarget(ip) {
  if (!net.isIPv4(ip)) return false;
  const a = Number(ip.split('.')[0]);
  return a !== 0 && a !== 127 && a < 224;
}

function normalizeFeatures(raw) {
  const present = isObj(raw);
  const f = present ? raw : {};
  const nw = isObj(f.netwatch) ? f.netwatch : {};
  const iq = isObj(f.inetq) ? f.inetq : {};
  const pr = isObj(f.presence) ? f.presence : {};
  const up = isObj(f.ups) ? f.ups : {};
  const dns = normalizeDns(f.dns);
  dns.enabled = present && dns.enabled;
  const cache = normalizeCache(f.cache);
  if (!present) Object.assign(cache, { enabled: false, requested: false, problem: null });
  // Phase 3c: Drucken & Scannen
  const print = normalizePrint(f.print);
  print.enabled = present && print.enabled;
  // Phase 3c, Schritt 2: Funk (fehlt es: Zigbee automatisch wie bisher im Pi-Image, Bluetooth aus)
  const radio = normalizeRadio(f.radio);
  // Phase 3c, Schritt 3: Lokale KI (fehlt es: aus)
  const ai = normalizeAi(f.ai);
  // Phase 3c, Schritt 4: Kameras (fehlt es: aus)
  const cameras = normalizeCameras(f.cameras);

  const targets = Array.isArray(iq.targets)
    ? [...new Set(iq.targets.filter((t) => typeof t === 'string' && isUsableTarget(t)))].slice(0, MAX_TARGETS)
    : [];
  const macs = Array.isArray(pr.macs)
    ? [...new Set(pr.macs.map(normalizeMac).filter(Boolean))].slice(0, MAX_PRESENCE_MACS)
    : [];
  const away = Number.isInteger(pr.awayAfterSec) ? Math.min(3600, Math.max(60, pr.awayAfterSec)) : AWAY_DEFAULT_S;
  const upsHost = typeof up.host === 'string' ? up.host.trim() : '';
  const upsPort = Number.isInteger(up.port) && up.port > 0 && up.port < 65536 ? up.port : 3493;
  const upsName = typeof up.name === 'string' && UPS_NAME_RE.test(up.name) ? up.name : null;
  // IPv4, Name oder – Heimnetz ohne IPv4 – eine private IPv6-Adresse (fc00::/7); ob das Ziel privat ist, prüft ups/nut.js
  const hostOk = upsHost !== '' && (net.isIPv4(upsHost) || isUlaIpv6(upsHost) || isHostname(upsHost));

  return {
    received: present,
    netwatch: { enabled: present && bool(nw.enabled, true), portscan: bool(nw.portscan, true) },
    inetq: {
      enabled: present && bool(iq.enabled, true),
      speedtest: SPEEDTEST_PLANS.has(iq.speedtest) ? iq.speedtest : '4x',
      targets: targets.length ? targets : [...DEFAULT_TARGETS],
      // dayBytes: Volumen in 24 h; downBytes/upBytes: Deckel je Test und Richtung (null = keiner)
      speedVolume: (() => {
        const l = isObj(iq.speedVolume) ? iq.speedVolume : {};
        return { dayBytes: speedBytes(l.dayBytes), downBytes: speedBytes(l.downBytes), upBytes: speedBytes(l.upBytes) };
      })(),
    },
    presence: { enabled: present && bool(pr.enabled, true), macs, awayAfterSec: away },
    ups: {
      enabled: present && up.enabled === true && hostOk,
      host: hostOk ? upsHost : '',
      port: upsPort,
      name: upsName,
    },
    timezone: present ? validTimezone(f.timezone) : null,
    dns,
    cache,
    print,
    radio,
    ai,
    cameras,
  };
}

/**
 * JSON mit rekursiv sortierten Objektschlüsseln, Arrays in Lieferreihenfolge,
 * ohne Leerzeichen; `undefined` fällt weg (wie JSON.stringify).
 */
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',') + ']';
  const parts = [];
  for (const k of Object.keys(v).sort()) {
    if (v[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableJson(v[k]));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * Config-Hash wie der Server ihn bildet (Vertrag, Änderung Server-Seite 1):
 * ohne `features` der Bibliotheks-Hash, sonst
 * 'sha256:' + sha256hex(libHash + '\n' + stableJson(features)).
 */
function configHash(cfgBody, libComputeHash) {
  const { features, ...rest } = cfgBody || {};
  const libHash = libComputeHash(rest);
  if (features === undefined) return libHash;
  return 'sha256:' + crypto.createHash('sha256').update(libHash + '\n' + stableJson(features), 'utf8').digest('hex');
}

module.exports = { normalizeFeatures, normalizeMac, stableJson, configHash, isUsableTarget, DEFAULT_TARGETS };
