'use strict';

// `features.print` (Vertrag Phase 3c §1) prüfen. Fehlt es → aus.
// `manual`: Adressen von Geräten, die sich nicht per mDNS melden – nur
// private IPv4-Adressen (RFC 1918), höchstens 16. `convert`: PDF für Drucker
// ohne PDF umwandeln (convert.js) – fehlt es, ist es an. `ocr`: Texterkennung
// für Scans (durchsuchbares PDF, ocr.js), `office`: Office-Dateien drucken
// (Dienst office mit LibreOffice, office.js) – beide nur mit `true` an.

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
  // `convert`: PDF für Drucker ohne PDF im Gateway umwandeln (Standard an; nur `false` schaltet es aus)
  return { enabled: p.enabled === true, manual, convert: p.convert !== false, ocr: p.ocr === true, office: p.office === true };
}

module.exports = { normalizePrint, isRfc1918, cleanText, MAX_MANUAL };
