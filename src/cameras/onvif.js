'use strict';

// ONVIF-Client für Kameras im LAN (docs/cameras.md §4): Geräteinfo,
// Fähigkeiten, Profile, Stream-/Snapshot-Adressen, Ereignis-Themen und
// PullPoint-Abos. SOAP 1.2 mit WS-UsernameToken (PasswordDigest, Uhrzeit-
// Abgleich über GetSystemDateAndTime), HTTP-Digest bei 401 (http.js).
//
// Adressen aus Antworten (XAddr, Stream-, Snapshot-, Abo-Adressen) werden nur
// mit Port und Pfad übernommen – der Host ist immer die geprüfte Adresse der
// Kamera (kein SSRF über eine Kamera, die eine fremde Adresse nennt).

const crypto = require('node:crypto');
const { request, CamHttpError } = require('./http');
const xml = require('./xml');
const { ONVIF_PATH_RE, RTSP_PATH_RE, PROFILE_RE } = require('./config');
const { cleanText } = require('../print/config');

const NS = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  wsa: 'http://www.w3.org/2005/08/addressing',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
};
const DEVICE_PATH = '/onvif/device_service';
const SOAP_MAX = 256 * 1024;

class OnvifError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** WS-Security-Kopf (UsernameToken, PasswordDigest = Base64(SHA1(Nonce + Created + Passwort))). */
function security(user, password, offsetMs = 0) {
  if (!user) return '';
  const nonce = crypto.randomBytes(16);
  const created = new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(String(password || ''), 'utf8')])).digest('base64');
  return `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" s:mustUnderstand="1"><wsse:UsernameToken>`
    + `<wsse:Username>${esc(user)}</wsse:Username>`
    + `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>`
    + `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce>`
    + `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
}

function envelope(body, header = '') {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS.s}" xmlns:tds="${NS.tds}" xmlns:trt="${NS.trt}" xmlns:tt="${NS.tt}" xmlns:tev="${NS.tev}" xmlns:wsnt="${NS.wsnt}" xmlns:wsa="${NS.wsa}">`
    + `<s:Header>${header}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
}

/**
 * Port und Pfad einer Adresse aus einer Antwort (Host fällt weg).
 * kind 'xaddr' (http, ONVIF-Pfad), 'rtsp' (rtsp, Pfad + Query), 'http' (http, Pfad + Query).
 */
function uriParts(raw, kind) {
  const s = cleanText(raw, 512).split(/\s+/)[0] || '';
  let u;
  try { u = new URL(s); } catch { return null; }
  const want = kind === 'rtsp' ? 'rtsp:' : 'http:';
  if (u.protocol !== want) return null;
  const dflt = kind === 'rtsp' ? 554 : 80;
  const port = u.port ? Number(u.port) : dflt;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const path = kind === 'xaddr' ? u.pathname : u.pathname + u.search;
  const re = kind === 'xaddr' ? ONVIF_PATH_RE : RTSP_PATH_RE;
  return re.test(path) ? { port, path } : null;
}

function faultCode(root) {
  const f = xml.find(root, 'Fault');
  if (!f) return null;
  const all = xml.findAll(f, 'Value').map(xml.text).concat([xml.textOf(f, 'faultcode'), xml.textOf(f, 'Text'), xml.textOf(f, 'faultstring')]).join(' ');
  if (/NotAuthorized|not ?authori[sz]ed|Sender.*Auth|FailedAuthentication|InvalidSecurity/i.test(all)) return 'auth_failed';
  return 'fault';
}

/**
 * Ein SOAP-Aufruf. ctx: { host, port, user, password, offsetMs, signal }.
 * → Wurzelknoten der Antwort; wirft OnvifError (auth_failed, fault, not_onvif, unreachable, …).
 */
async function soap(ctx, path, body, { action = '', header = '', auth = true, timeoutMs = 10_000 } = {}) {
  const sec = auth ? security(ctx.user, ctx.password, ctx.offsetMs || 0) : '';
  const data = envelope(body, sec + header);
  let r;
  try {
    r = await request({
      host: ctx.host, port: ctx.port, path, method: 'POST', body: data, maxBytes: SOAP_MAX, timeoutMs, signal: ctx.signal,
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}` },
      user: auth ? ctx.user : null, password: ctx.password, allowBasic: false,
    });
  } catch (e) {
    if (e instanceof CamHttpError) throw new OnvifError(e.code === 'auth_failed' ? 'auth_failed' : (e.code === 'redirect' ? 'not_onvif' : e.code), e.message);
    throw new OnvifError('unreachable', 'the camera does not answer');
  }
  let root;
  try { root = xml.parse(r.body.toString('utf8')); } catch { throw new OnvifError('not_onvif', 'the camera sent no ONVIF answer'); }
  if (!xml.find(root, 'Envelope')) throw new OnvifError('not_onvif', 'the camera sent no SOAP answer (HTTP ' + r.status + ')');
  const fault = faultCode(root);
  if (fault) throw new OnvifError(fault, fault === 'auth_failed' ? 'the camera refused the user or password' : 'the camera answered with a SOAP fault');
  if (r.status >= 400) throw new OnvifError('fault', 'HTTP ' + r.status);
  return root;
}

/** Abweichung der Kamera-Uhr (ms) – ohne Anmeldung. */
async function clockOffset(ctx, path = DEVICE_PATH) {
  const root = await soap(ctx, path, '<tds:GetSystemDateAndTime/>', { auth: false, action: `${NS.tds}/GetSystemDateAndTime` });
  const utc = xml.find(root, 'UTCDateTime');
  if (!utc) return 0;
  const d = xml.child(utc, 'Date');
  const t = xml.child(utc, 'Time');
  const n = (node, k) => Number(xml.textOf(node, k));
  const ms = Date.UTC(n(d, 'Year'), n(d, 'Month') - 1, n(d, 'Day'), n(t, 'Hour'), n(t, 'Minute'), n(t, 'Second'));
  return Number.isFinite(ms) && Math.abs(ms - Date.now()) < 10 * 365 * 86400_000 ? ms - Date.now() : 0;
}

async function deviceInfo(ctx, path = DEVICE_PATH) {
  const root = await soap(ctx, path, '<tds:GetDeviceInformation/>', { action: `${NS.tds}/GetDeviceInformation` });
  return {
    manufacturer: cleanText(xml.textOf(root, 'Manufacturer'), 48) || null,
    model: cleanText(xml.textOf(root, 'Model'), 48) || null,
    firmware: cleanText(xml.textOf(root, 'FirmwareVersion'), 48) || null,
  };
}

/** → { media: { port, path } | null, events: { port, path } | null } */
async function capabilities(ctx, path = DEVICE_PATH) {
  const root = await soap(ctx, path, '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>', { action: `${NS.tds}/GetCapabilities` });
  const caps = xml.find(root, 'Capabilities');
  const part = (name) => {
    const n = xml.child(caps, name) || xml.find(caps, name);
    return n ? uriParts(xml.textOf(n, 'XAddr'), 'xaddr') : null;
  };
  return { media: part('Media'), events: part('Events') };
}

/** → [{ token, name, codec: h264|h265|jpeg|other, width, height }] (≤ 8) */
async function profiles(ctx, mediaPath) {
  const root = await soap(ctx, mediaPath, '<trt:GetProfiles/>', { action: `${NS.trt}/GetProfiles` });
  const out = [];
  for (const p of xml.findAll(root, 'Profiles', 8)) {
    const token = p.attrs.token;
    if (typeof token !== 'string' || !PROFILE_RE.test(token)) continue;
    const enc = xml.find(p, 'VideoEncoderConfiguration');
    if (!enc) continue;
    const e = xml.textOf(enc, 'Encoding').toUpperCase();
    const res = xml.find(enc, 'Resolution');
    out.push({
      token,
      name: cleanText(xml.textOf(p, 'Name'), 48) || token,
      codec: e === 'H264' ? 'h264' : (e === 'H265' || e === 'HEVC' ? 'h265' : (e === 'JPEG' ? 'jpeg' : 'other')),
      width: Number(xml.textOf(res, 'Width')) || null,
      height: Number(xml.textOf(res, 'Height')) || null,
    });
  }
  return out;
}

async function streamUri(ctx, mediaPath, token) {
  const body = '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
    + `<trt:ProfileToken>${esc(token)}</trt:ProfileToken></trt:GetStreamUri>`;
  const root = await soap(ctx, mediaPath, body, { action: `${NS.trt}/GetStreamUri` });
  return uriParts(xml.textOf(root, 'Uri'), 'rtsp');
}

async function snapshotUri(ctx, mediaPath, token) {
  try {
    const root = await soap(ctx, mediaPath, `<trt:GetSnapshotUri><trt:ProfileToken>${esc(token)}</trt:ProfileToken></trt:GetSnapshotUri>`, { action: `${NS.trt}/GetSnapshotUri` });
    return uriParts(xml.textOf(root, 'Uri'), 'http');
  } catch (e) {
    if (e.code === 'fault') return null;
    throw e;
  }
}

// ─── Ereignisse ──────────────────────────────────────────────────────

const WORDS = {
  person: ['people', 'person', 'persons', 'human', 'humans', 'face', 'visitor'],
  vehicle: ['vehicle', 'vehicles', 'car', 'cars', 'truck', 'motorvehicle'],
  animal: ['animal', 'animals', 'pet', 'pets', 'dog', 'dogs', 'cat', 'cats', 'dogcat'],
  motion: ['motion', 'cellmotion', 'movement'],
};

/** 'DogCatDetect' → animal, 'IsPeople' → person, 'CellMotionDetector/Motion' → motion (Wörter, nicht Teilstrings) */
function kindOfName(s) {
  const words = String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const kind of ['person', 'vehicle', 'animal', 'motion']) if (words.some((w) => WORDS[kind].includes(w))) return kind;
  return null;
}

const TRUE_RE = /^(true|1|active|on)$/i;
const FALSE_RE = /^(false|0|inactive|off)$/i;

/**
 * Eine NotificationMessage → [{ kind, active }] (leer: nichts, was uns angeht).
 * Tapo nennt die Art im Namen des Wertes (IsPeople, IsVehicle, IsPet), Reolink
 * im Thema (…/PeopleDetect, State), viele nur Bewegung (…/CellMotionDetector/Motion, IsMotion).
 */
function classify(topic, items) {
  const out = [];
  const tKind = kindOfName(String(topic || '').split('/').slice(-2).join('/'));
  for (const [name, value] of Object.entries(items || {})) {
    const v = String(value).trim();
    const active = TRUE_RE.test(v) ? true : (FALSE_RE.test(v) ? false : null);
    if (active === null) continue;
    const kind = kindOfName(name) || tKind;
    if (kind && !out.some((x) => x.kind === kind)) out.push({ kind, active });
  }
  return out;
}

/** Ereignis-Arten aus GetEventProperties (TopicSet) – für die Anzeige „Bewegung: Personen, Autos“. */
async function eventKinds(ctx, eventsPath) {
  const root = await soap(ctx, eventsPath, '<tev:GetEventProperties/>', { action: `${NS.tev}/EventPortType/GetEventPropertiesRequest` });
  const set = xml.find(root, 'TopicSet');
  const kinds = new Set();
  const walk = (n, trail) => {
    if (!n || trail.length > 12) return;
    for (const c of n.children) {
      const k = kindOfName(c.name) || null;
      if (k) kinds.add(k);
      for (const si of xml.findAll(c, 'SimpleItemDescription', 32)) { const kk = kindOfName(si.attrs.Name); if (kk) kinds.add(kk); }
      walk(c, trail.concat(c.name));
    }
  };
  walk(set, []);
  return ['person', 'vehicle', 'animal', 'motion'].filter((k) => kinds.has(k));
}

/** NotificationMessages einer PullMessages-Antwort → [{ topic, items, at }] */
function messagesOf(root) {
  const out = [];
  for (const m of xml.findAll(root, 'NotificationMessage', 64)) {
    const topic = cleanText(xml.textOf(m, 'Topic'), 200);
    const msg = xml.find(m, 'Message');
    const inner = msg ? (xml.child(msg, 'Message') || msg) : null;
    const items = {};
    const data = xml.find(inner, 'Data');
    for (const si of xml.findAll(data, 'SimpleItem', 16)) {
      if (typeof si.attrs.Name === 'string') items[cleanText(si.attrs.Name, 48)] = cleanText(si.attrs.Value, 48);
    }
    const at = inner && typeof inner.attrs.UtcTime === 'string' ? Date.parse(inner.attrs.UtcTime) : NaN;
    out.push({ topic, items, at: Number.isFinite(at) ? at : null });
  }
  return out;
}

async function createPullPoint(ctx, eventsPath) {
  const body = '<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT120S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>';
  const root = await soap(ctx, eventsPath, body, { action: `${NS.tev}/EventPortType/CreatePullPointSubscriptionRequest` });
  const ref = xml.find(root, 'SubscriptionReference');
  const addr = xml.textOf(ref, 'Address');
  const parts = uriParts(addr, 'xaddr') || (/^\//.test(addr) && ONVIF_PATH_RE.test(addr) ? { port: ctx.port, path: addr } : null);
  if (!parts) throw new OnvifError('fault', 'the camera named no usable subscription address');
  return { ...parts, address: cleanText(addr, 400) };
}

function wsa(action, to) {
  return `<wsa:Action>${esc(action)}</wsa:Action><wsa:To>${esc(to)}</wsa:To>`;
}

async function pullMessages(ctx, sub, { timeoutS = 10, limit = 32 } = {}) {
  const action = `${NS.tev}/PullPointSubscription/PullMessagesRequest`;
  const body = `<tev:PullMessages><tev:Timeout>PT${timeoutS}S</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>`;
  const root = await soap({ ...ctx, port: sub.port }, sub.path, body, { action, header: wsa(action, sub.address), timeoutMs: (timeoutS + 10) * 1000 });
  return messagesOf(root);
}

async function renew(ctx, sub) {
  const action = `${NS.wsnt}/SubscriptionManager/RenewRequest`;
  await soap({ ...ctx, port: sub.port }, sub.path, '<wsnt:Renew><wsnt:TerminationTime>PT120S</wsnt:TerminationTime></wsnt:Renew>', { action, header: wsa(action, sub.address) });
}

async function unsubscribe(ctx, sub) {
  const action = `${NS.wsnt}/SubscriptionManager/UnsubscribeRequest`;
  try { await soap({ ...ctx, port: sub.port }, sub.path, '<wsnt:Unsubscribe/>', { action, header: wsa(action, sub.address), timeoutMs: 4000 }); } catch { /* best effort */ }
}

module.exports = {
  NS, DEVICE_PATH, OnvifError, security, envelope, uriParts, soap, clockOffset, deviceInfo, capabilities, profiles, streamUri, snapshotUri,
  eventKinds, classify, kindOfName, messagesOf, createPullPoint, pullMessages, renew, unsubscribe,
};
