'use strict';

// `features.ai` (Vertrag Phase 3c, Schritt 3 §1 – docs/local-ai.md) prüfen.
//   enabled: true | false
//   source:  'service' (Dienst ki auf diesem Gateway) | 'lan' (vorhandener KI-Server)
//   lan:     { url, api: 'ollama' | 'openai', keyRev?, pin? } – nur mit source 'lan'
// Fehlt `features.ai` (älterer Server) → aus. Die LAN-Adresse ist Server-
// Eingabe: nur http/https, ein Port, kein Pfad, keine Zugangsdaten; der Host
// als private IPv4-Adresse (RFC 1918), als private IPv6-Adresse (fc00::/7,
// in Klammern: [fd00::1]) oder als Name (nas.local, pc.fritz.box). Ein Name
// wird erst beim Verbinden aufgelöst (resolve.js) – und nur an private
// Adressen verbunden. Alles andere → kein LAN-Server.
// `keyRev`: es gibt einen API-Schlüssel – das Gateway holt ihn selbst
// (creds.js, nie im Config-Pull).
// `pin` (nur https): SHA-256-Fingerabdruck des Server-Zertifikats, den der Admin
// bestätigt hat – verbunden wird dann nur mit genau diesem Zertifikat
// (src/proxy/tlsPin.js). Ein unlesbarer Pin passt auf kein Zertifikat (PIN_INVALID):
// lieber keine Verbindung als eine ohne die bestätigte Prüfung.

const net = require('node:net');
const { isRfc1918 } = require('../print/config');
const { normalizeFingerprint } = require('../proxy/tlsPin');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const APIS = new Set(['ollama', 'openai']);
// Ollama-Modellname: Name, optional Namensraum, optional Tag
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?(:[A-Za-z0-9._-]{1,64})?$/;
const REV_RE = /^[0-9a-f]{8,64}$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// ein Pin, der zu keinem Zertifikat passt (kein gültiger Fingerabdruck)
const PIN_INVALID = 'invalid';

/** `lan.pin` des Servers → Fingerabdruck (hex), PIN_INVALID (unlesbar) oder null (keiner / kein https). */
function parsePin(raw, protocol) {
  if (protocol !== 'https:' || raw === undefined || raw === null || raw === '') return null;
  return normalizeFingerprint(raw) || PIN_INVALID;
}

/** fc00::/7 – private IPv6-Adressen (ULA), z. B. fd00::1 */
function isUla(ip) {
  if (typeof ip !== 'string' || !net.isIPv6(ip)) return false;
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return Number.isFinite(first) && (first & 0xfe00) === 0xfc00;
}

/** Eine Adresse im Heimnetz: RFC 1918 oder fc00::/7 (nie Loopback, Link-Local, öffentlich). */
function isLanAddress(ip) { return isRfc1918(ip) || isUla(ip); }

/** Ein Rechnername (nas, nas.local, pc.fritz.box) – nur Buchstaben, Ziffern, Bindestrich; kein localhost. */
function isHostname(h) {
  if (typeof h !== 'string' || !h || h.length > 253) return false;
  const parts = h.split('.');
  if (!parts.every((p) => LABEL_RE.test(p))) return false;
  // „1.2.3“ oder „10.0.0.300“ ist keine Adresse und kein Name
  if (/^[0-9]+$/.test(parts[parts.length - 1])) return false;
  return h !== 'localhost' && !h.endsWith('.localhost');
}

/** Basis-URL eines KI-Servers im LAN → { protocol, host, port, origin, name } oder null. */
function parseLanUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!['', '/', '/v1', '/v1/'].includes(u.pathname)) return null;
  // new URL() schreibt IPv4 normal (keine Oktal-/Hex-Tricks mehr übrig) und IPv6 kurz in Klammern
  const hn = u.hostname;
  let host;
  let name = false;
  if (hn.startsWith('[') && hn.endsWith(']')) {
    host = hn.slice(1, -1);
    if (!isUla(host)) return null;
  } else if (net.isIPv4(hn)) {
    if (!isRfc1918(hn)) return null;
    host = hn;
  } else if (isHostname(hn)) {
    host = hn;
    name = true;
  } else return null;
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { protocol: u.protocol, host, port, origin: `${u.protocol}//${hn}:${port}`, name };
}

function normalizeAi(raw) {
  const a = isObj(raw) ? raw : {};
  const source = a.source === 'lan' ? 'lan' : 'service';
  let lan = null;
  if (source === 'lan' && isObj(a.lan)) {
    const p = parseLanUrl(a.lan.url);
    if (p) {
      lan = { url: p.origin, api: APIS.has(a.lan.api) ? a.lan.api : 'ollama', keyRev: typeof a.lan.keyRev === 'string' && REV_RE.test(a.lan.keyRev) ? a.lan.keyRev : null,
        pin: parsePin(a.lan.pin, p.protocol) };
    }
  }
  return { enabled: a.enabled === true, source, lan };
}

const validModel = (m) => typeof m === 'string' && MODEL_RE.test(m);

// Ein API-Schlüssel geht als „Authorization: Bearer …“ – nur druckbare Zeichen ohne Leerzeichen
const KEY_RE = /^[\x21-\x7e]{1,512}$/;
const validKey = (k) => typeof k === 'string' && KEY_RE.test(k);

module.exports = { normalizeAi, parseLanUrl, parsePin, validModel, validKey, isLanAddress, isUla, isHostname, MODEL_RE, APIS, PIN_INVALID };
