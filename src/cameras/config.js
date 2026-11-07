'use strict';

// `features.cameras` (Vertrag Phase 3c, Schritt 4 §1 – docs/cameras.md) prüfen.
// Alles hier ist Server-Eingabe. Fehlt `features.cameras` (älterer Server) → aus.
// Adressen: nur RFC 1918; ob eine Adresse zu einem eigenen LAN-Netz (oder zu
// `subnets`) gehört, prüft hostAllowed() bei jeder Verbindung.

const { isRfc1918, cleanText } = require('../print/config');

const MAX_CAMERAS = 16;
const MAX_SUBNETS = 8;
const ID_RE = /^c[0-9a-f]{15}$/;
const EVENT_ID_RE = /^e[0-9a-f]{15}$/;
const ONVIF_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,127}$/;
const RTSP_PATH_RE = /^\/[A-Za-z0-9._~/%&=?+:;,-]{0,255}$/;
const PROFILE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const REV_RE = /^[0-9a-f]{8,64}$/;
const RECORD = new Set(['motion', 'away', 'never']);
const KINDS = Object.freeze(['person', 'vehicle', 'animal', 'motion']);
const RETENTION = { min: 1, max: 90, dflt: 14 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const port = (v) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null);

function ipToInt(ip) {
  return ip.split('.').reduce((a, o) => ((a << 8) + (Number(o) & 255)) >>> 0, 0);
}

/** '192.168.20.0/24' → { net, prefix } (nur RFC 1918, /16…/30) oder null */
function parseCidr(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(v.trim());
  if (!m || !isRfc1918(m[1])) return null;
  const prefix = Number(m[2]);
  if (prefix < 16 || prefix > 30) return null;
  const mask = (~(0xffffffff >>> prefix)) >>> 0;
  const net = (ipToInt(m[1]) & mask) >>> 0;
  return { net, prefix, cidr: `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.')}/${prefix}` };
}

function inCidr(ip, cidr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!c || !isRfc1918(ip)) return false;
  const mask = (~(0xffffffff >>> c.prefix)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === c.net;
}

/**
 * Darf das Gateway mit `host` sprechen? Nur RFC 1918 und in einem eigenen
 * LAN-Netz (`ownSubnets`: [{ cidr }]) oder in `extra` (features.cameras.subnets).
 */
function hostAllowed(host, ownSubnets, extra = []) {
  if (!isRfc1918(host)) return false;
  for (const s of ownSubnets || []) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(s && s.cidr));
    if (!m) continue;
    const prefix = Number(m[2]);
    if (prefix < 8 || prefix > 30) continue;
    const mask = (~(0xffffffff >>> prefix)) >>> 0;
    if (((ipToInt(host) & mask) >>> 0) === ((ipToInt(m[1]) & mask) >>> 0)) return true;
  }
  return (extra || []).some((c) => inCidr(host, c));
}

function normCamera(c) {
  if (!isObj(c) || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
  const host = typeof c.host === 'string' ? c.host.trim() : '';
  if (!isRfc1918(host)) return null;
  let onvif = null;
  if (isObj(c.onvif) && port(c.onvif.port) && typeof c.onvif.path === 'string' && ONVIF_PATH_RE.test(c.onvif.path)) {
    onvif = { port: c.onvif.port, path: c.onvif.path };
  }
  let rtsp = null;
  if (isObj(c.rtsp) && port(c.rtsp.port) && typeof c.rtsp.path === 'string' && RTSP_PATH_RE.test(c.rtsp.path)) {
    rtsp = { port: c.rtsp.port, path: c.rtsp.path };
  }
  if (!onvif && !rtsp) return null;
  const events = Array.isArray(c.events) ? KINDS.filter((k) => c.events.includes(k)) : ['person', 'vehicle', 'animal'];
  const days = Number.isInteger(c.retentionDays) ? Math.min(RETENTION.max, Math.max(RETENTION.min, c.retentionDays)) : RETENTION.dflt;
  return {
    id: c.id,
    name: cleanText(c.name, 60) || c.id,
    host,
    onvif,
    rtsp,
    profile: typeof c.profile === 'string' && PROFILE_RE.test(c.profile) ? c.profile : null,
    stream: c.stream === 'sub' ? 'sub' : 'main',
    record: RECORD.has(c.record) ? c.record : 'never',
    events,
    retentionDays: days,
    audio: c.audio === true,
    codec: c.codec === 'h265' ? 'h265' : (c.codec === 'h264' ? 'h264' : null),
  };
}

function normalizeCameras(raw) {
  const c = isObj(raw) ? raw : {};
  const seen = new Set();
  const cameras = [];
  for (const x of Array.isArray(c.cameras) ? c.cameras : []) {
    const n = normCamera(x);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    cameras.push(n);
    if (cameras.length >= MAX_CAMERAS) break;
  }
  const subnets = Array.isArray(c.subnets)
    ? [...new Set(c.subnets.map(parseCidr).filter(Boolean).map((x) => x.cidr))].slice(0, MAX_SUBNETS)
    : [];
  return {
    enabled: c.enabled === true,
    nobodyHome: c.nobodyHome === true ? true : (c.nobodyHome === false ? false : null),
    credRev: typeof c.credRev === 'string' && REV_RE.test(c.credRev) ? c.credRev : null,
    subnets,
    cameras,
  };
}

/** Darf die Kamera gerade Clips aufnehmen? */
function mayRecord(cam, nobodyHome) {
  if (!cam || cam.record === 'never') return false;
  if (cam.record === 'away') return nobodyHome === true;
  return true;
}

module.exports = {
  normalizeCameras, hostAllowed, parseCidr, inCidr, mayRecord,
  ID_RE, EVENT_ID_RE, ONVIF_PATH_RE, RTSP_PATH_RE, PROFILE_RE, KINDS, MAX_CAMERAS,
};
