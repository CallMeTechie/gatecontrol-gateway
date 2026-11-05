'use strict';

// `features.cache` (Vertrag Phase 3b §2.1) prüfen. Fehlt es → aus.
// `path` muss unter dem Zwischenspeicher-Volume liegen (Standard /cache,
// GATEWAY_CACHE_ROOT); alles andere wird abgelehnt – der Server darf das
// Gateway nicht irgendwohin schreiben lassen.

const path = require('node:path');

const DEFAULT_ROOT = '/cache';
const MIN_BYTES = 256 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 ** 4;
const DEFAULT_BYTES = 20 * 1024 ** 3;
const DEFAULT_PORT = 8443;
const KINDS = Object.freeze({ drive: true, photos: true, updates: true, vault: false });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cacheRoot() {
  const r = process.env.GATEWAY_CACHE_ROOT;
  return typeof r === 'string' && path.isAbsolute(r) ? path.resolve(r) : DEFAULT_ROOT;
}

/** Pfad innerhalb von `root` (oder root selbst) → normalisiert, sonst null. */
function safePath(p, root) {
  if (p === undefined || p === null || p === '') return root;
  if (typeof p !== 'string' || p.length > 512 || p.includes('\0')) return null;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === '') return root;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function normalizeCache(raw, { root = cacheRoot() } = {}) {
  const c = isObj(raw) ? raw : {};
  const k = isObj(c.kinds) ? c.kinds : {};
  const kinds = {};
  for (const [name, dflt] of Object.entries(KINDS)) kinds[name] = typeof k[name] === 'boolean' ? k[name] : dflt;
  const p = safePath(c.path, root);
  const maxBytes = Number.isSafeInteger(c.maxBytes) ? Math.min(MAX_BYTES, Math.max(MIN_BYTES, c.maxBytes)) : DEFAULT_BYTES;
  const secret = typeof c.secret === 'string' && c.secret.length >= 32 && c.secret.length <= 512 ? c.secret : null;
  const port = Number.isInteger(c.port) && c.port >= 1024 && c.port <= 65535 ? c.port : DEFAULT_PORT;
  let problem = null;
  if (c.enabled === true && !p) problem = 'path_not_allowed';
  else if (c.enabled === true && !secret) problem = 'no_secret';
  return {
    enabled: c.enabled === true && !problem,
    requested: c.enabled === true,
    problem,
    path: p || root,
    root,
    maxBytes,
    kinds,
    secret,
    port,
  };
}

module.exports = { normalizeCache, safePath, cacheRoot, DEFAULT_PORT, KINDS };
