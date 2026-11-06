'use strict';

// `features.print` (Vertrag Phase 3c §1) prüfen. Fehlt es → aus.
// `manual`: Adressen von Geräten, die sich nicht per mDNS melden – nur
// private IPv4-Adressen (RFC 1918), höchstens 16.

const net = require('node:net');

const MAX_MANUAL = 16;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 10/8, 172.16/12, 192.168/16 */
function isRfc1918(ip) {
  if (typeof ip !== 'string' || !net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Text ohne Steuerzeichen, getrimmt, höchstens n Zeichen ('' für Nicht-Text). */
function cleanText(v, n) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 ? ' ' : ch;
  }
  return out.trim().slice(0, n);
}

function normalizePrint(raw) {
  const p = isObj(raw) ? raw : {};
  const manual = Array.isArray(p.manual)
    ? [...new Set(p.manual.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(isRfc1918))].slice(0, MAX_MANUAL)
    : [];
  return { enabled: p.enabled === true, manual };
}

module.exports = { normalizePrint, isRfc1918, cleanText, MAX_MANUAL };
