'use strict';

// Prüfung der Nachrichten vom Server (Vertrag Abschnitt 2). Der Sollzustand
// (`state`) wird vollständig geprüft und normalisiert, bevor irgendetwas
// davon angewendet wird; eine ungültige Nachricht ändert nichts.

const { LIMITS, ID_RE, VERSION_RE } = require('./constants');
const { validateCaps } = require('./manifest');
const { validPluginFilter, validFilter } = require('./topics');

class ProtocolError extends Error {
  constructor(message) { super(message); this.code = 'bad_message'; }
}

const USER_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
// mosquitto_passwd: $7$<iterations>$<salt b64>$<hash b64> (PBKDF2-SHA512); $6$ = älteres SHA512-Format
const HASH_RE = /^\$(?:7\$[0-9]{1,7}|6)\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/;
const ACCESS = new Set(['read', 'write', 'readwrite']);
const RESERVED_USERS = new Set(['gc-edge']);

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function fail(msg) { throw new ProtocolError(msg); }

function validId(id) { return typeof id === 'string' && id.length >= 2 && id.length <= 64 && ID_RE.test(id); }

function parseMqtt(m) {
  if (m === undefined || m === null) return { enabled: false, tls: false, accounts: [], pluginTopics: {} };
  if (!isObj(m)) fail('state.mqtt must be an object');
  const accounts = [];
  const seen = new Set();
  const list = m.accounts === undefined ? [] : m.accounts;
  if (!Array.isArray(list) || list.length > 256) fail('state.mqtt.accounts: list of at most 256 accounts');
  for (const a of list) {
    if (!isObj(a) || typeof a.user !== 'string' || !USER_RE.test(a.user)) fail('state.mqtt.accounts: invalid user');
    if (RESERVED_USERS.has(a.user)) fail(`state.mqtt.accounts: user ${a.user} is reserved`);
    if (seen.has(a.user)) fail(`state.mqtt.accounts: duplicate user ${a.user}`);
    seen.add(a.user);
    if (typeof a.hash !== 'string' || a.hash.length > 512 || !HASH_RE.test(a.hash)) fail(`state.mqtt.accounts: invalid hash for ${a.user}`);
    const acl = [];
    const al = a.acl === undefined ? [] : a.acl;
    if (!Array.isArray(al) || al.length > 64) fail(`state.mqtt.accounts: acl of ${a.user}`);
    for (const r of al) {
      if (!isObj(r) || !ACCESS.has(r.access) || !validFilter(r.topic) || r.topic.startsWith('$')) fail(`state.mqtt.accounts: acl entry of ${a.user}`);
      acl.push({ access: r.access, topic: r.topic });
    }
    accounts.push({ user: a.user, hash: a.hash, acl });
  }
  const pluginTopics = {};
  if (m.pluginTopics !== undefined) {
    if (!isObj(m.pluginTopics)) fail('state.mqtt.pluginTopics must be an object');
    for (const [id, topics] of Object.entries(m.pluginTopics)) {
      if (!validId(id)) fail('state.mqtt.pluginTopics: invalid plugin id');
      if (!Array.isArray(topics) || topics.length > 16 || !topics.every(validPluginFilter)) fail(`state.mqtt.pluginTopics.${id}`);
      pluginTopics[id] = [...new Set(topics)];
    }
  }
  return { enabled: m.enabled === true, tls: m.tls === true, accounts, pluginTopics };
}

/** `state` prüfen → normalisierter Sollzustand. */
function parseState(msg) {
  if (!isObj(msg) || msg.t !== 'state') fail('not a state message');
  const plugins = [];
  const list = msg.plugins === undefined ? [] : msg.plugins;
  if (!Array.isArray(list) || list.length > LIMITS.maxPlugins) fail(`state.plugins: list of at most ${LIMITS.maxPlugins}`);
  const ids = new Set();
  for (const p of list) {
    if (!isObj(p) || !validId(p.id)) fail('state.plugins: invalid id');
    if (ids.has(p.id)) fail(`state.plugins: duplicate ${p.id}`);
    ids.add(p.id);
    if (typeof p.version !== 'string' || p.version.length > 64 || !VERSION_RE.test(p.version)) fail(`state.plugins.${p.id}: invalid version`);
    if (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(p.sha256)) fail(`state.plugins.${p.id}: invalid sha256`);
    let memoryMb = null;
    if (p.memoryMb !== undefined && p.memoryMb !== null) {
      if (!Number.isInteger(p.memoryMb) || p.memoryMb < LIMITS.memoryMbMin || p.memoryMb > LIMITS.memoryMbMax) fail(`state.plugins.${p.id}: memoryMb ${LIMITS.memoryMbMin}–${LIMITS.memoryMbMax}`);
      memoryMb = p.memoryMb;
    }
    let caps = {};
    let capsError = null;
    try { caps = validateCaps(p.caps, `caps of ${p.id}`); } catch (e) { capsError = e.message; caps = {}; }
    plugins.push({ id: p.id, version: p.version, sha256: p.sha256.toLowerCase(), caps, capsError, memoryMb, enabled: p.enabled !== false });
  }
  return {
    edgeEnabled: msg.edgeEnabled === true,
    allowUnsigned: msg.allowUnsigned === true,
    plugins,
    mqtt: parseMqtt(msg.mqtt),
  };
}

/** `call` prüfen. */
function parseCall(msg) {
  if (typeof msg.id !== 'string' || msg.id.length < 1 || msg.id.length > 64) fail('call.id');
  if (!validId(msg.plugin)) fail('call.plugin');
  if (typeof msg.method !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(msg.method)) fail('call.method');
  const t = Number.isFinite(msg.timeoutMs) ? Math.max(1, Math.min(LIMITS.callTimeoutMaxMs, msg.timeoutMs)) : LIMITS.callTimeoutDefaultMs;
  return { id: msg.id, plugin: msg.plugin, method: msg.method, params: msg.params === undefined ? null : msg.params, timeoutMs: t };
}

module.exports = { parseState, parseCall, ProtocolError, HASH_RE, USER_RE, RESERVED_USERS };
