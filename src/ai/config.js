'use strict';

// `features.ai` (Vertrag Phase 3c, Schritt 3 §1 – docs/local-ai.md) prüfen.
//   enabled: true | false
//   source:  'service' (Dienst ki auf diesem Gateway) | 'lan' (vorhandener KI-Server)
//   lan:     { url, api: 'ollama' | 'openai' } – nur mit source 'lan'
// Fehlt `features.ai` (älterer Server) → aus. Die LAN-Adresse ist Server-
// Eingabe: nur http/https, Host nur als private IPv4-Adresse (RFC 1918), ein
// Port, kein Pfad, keine Zugangsdaten – sonst gibt es keinen LAN-Server.

const { isRfc1918 } = require('../print/config');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const APIS = new Set(['ollama', 'openai']);
// Ollama-Modellname: Name, optional Namensraum, optional Tag
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?(:[A-Za-z0-9._-]{1,64})?$/;

/** Basis-URL eines KI-Servers im LAN → { protocol, host, port, origin } oder null. */
function parseLanUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!['', '/', '/v1', '/v1/'].includes(u.pathname)) return null;
  // new URL() schreibt IPv4 normal (keine Oktal-/Hex-Tricks mehr übrig); nur RFC 1918
  if (!isRfc1918(u.hostname)) return null;
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { protocol: u.protocol, host: u.hostname, port, origin: `${u.protocol}//${u.hostname}:${port}` };
}

function normalizeAi(raw) {
  const a = isObj(raw) ? raw : {};
  const source = a.source === 'lan' ? 'lan' : 'service';
  let lan = null;
  if (source === 'lan' && isObj(a.lan)) {
    const p = parseLanUrl(a.lan.url);
    if (p) lan = { url: p.origin, api: APIS.has(a.lan.api) ? a.lan.api : 'ollama' };
  }
  return { enabled: a.enabled === true, source, lan };
}

const validModel = (m) => typeof m === 'string' && MODEL_RE.test(m);

module.exports = { normalizeAi, parseLanUrl, validModel, MODEL_RE };
