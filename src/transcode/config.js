'use strict';

// `features.transcode` („Videos umwandeln“, docs/transcode.md §1) prüfen.
//   enabled:      true | false
//   roots:        Medienordner, in denen umgewandelt werden darf (absolute Pfade,
//                 dieselben wie im Dienst umwandeln eingehängt; höchstens 8)
//   software:     Umwandeln ohne Grafik (libx264) erlaubt – Standard false
//   trashDays:    Frist des Papierkorbs in Tagen (1…365, Standard 14)
//   quality:      Qualitätsziel ICQ/QVBR (16…32, Standard 23)
//   verifyDecode: neue Datei vor dem Tausch einmal ganz dekodieren (Standard true)
//   minFreeGb / minFreePct: so viel Platz bleibt nach dem Umwandeln frei (20 GB / 5 %)
// Fehlt `features.transcode` (älterer Server) → aus. Alles ist Server-Eingabe.
//
// Pfade: Das Gateway sieht die Medien nicht (kein Mount) und prüft deshalb nur
// die Schreibweise – absolut, normalisiert, ohne Steuerzeichen, unter einer
// Wurzel, nicht in den Arbeitsordnern, Endung aus einer festen Liste. Ob die
// Datei wirklich dort liegt und kein symbolischer Link im Spiel ist, prüft der
// Wächter im Dienst (umwandeln.sh, realpath) gegen seine eigenen Wurzeln.

const path = require('node:path');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v, min, max, dflt) => (Number.isInteger(v) && v >= min && v <= max ? v : dflt);

const MAX_ROOTS = 8;
const MAX_PATH_BYTES = 4096;
const MAX_NAME_BYTES = 255;
const TRASH_DIR = '.gc-papierkorb';
const WORK_DIR = '.gc-umwandeln';
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Was ffprobe für die Liste prüfen darf; umgewandelt wird nur MKV (der Container bleibt MKV).
const VIDEO_EXT = new Set(['mkv', 'mp4', 'm4v', 'mov', 'avi', 'ts', 'm2ts', 'mts', 'wmv', 'asf', 'flv', 'webm', 'mpg', 'mpeg', 'vob', 'ogm', 'divx', '3gp']);
const CONVERT_EXT = new Set(['mkv']);

function hasControl(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

/** Ein absoluter, normalisierter Pfad ohne Steuerzeichen (sonst null). */
function cleanAbs(p) {
  if (typeof p !== 'string' || p.length < 2 || p[0] !== '/') return null;
  if (Buffer.byteLength(p) > MAX_PATH_BYTES || hasControl(p)) return null;
  if (path.posix.normalize(p) !== p || p.endsWith('/')) return null;
  for (const seg of p.split('/').slice(1)) {
    if (seg === '' || seg === '.' || seg === '..' || Buffer.byteLength(seg) > MAX_NAME_BYTES) return null;
  }
  return p;
}

function normalizeRoots(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const r of raw) {
    const p = cleanAbs(r);
    // „:“ trennt die Wurzeln in GC_UMW_ROOTS; Arbeitsordner sind nie eine Wurzel
    if (!p || p.includes(':') || p.split('/').some((s) => s === TRASH_DIR || s === WORK_DIR)) continue;
    // keine Wurzel in einer anderen (der Papierkorb wäre sonst mehrdeutig)
    if (out.some((o) => o === p || p.startsWith(o + '/') || o.startsWith(p + '/'))) continue;
    out.push(p);
    if (out.length >= MAX_ROOTS) break;
  }
  return out;
}

function normalizeTranscode(raw) {
  const t = isObj(raw) ? raw : {};
  const roots = normalizeRoots(t.roots);
  return {
    enabled: t.enabled === true,
    roots,
    software: t.software === true,
    trashDays: int(t.trashDays, 1, 365, 14),
    quality: int(t.quality, 16, 32, 23),
    verifyDecode: t.verifyDecode !== false,
    minFreeGb: int(t.minFreeGb, 0, 100000, 20),
    minFreePct: int(t.minFreePct, 0, 90, 5),
  };
}

/**
 * Pfad eines Auftrags prüfen. kind: 'convert' (nur MKV) | 'probe' (alle Videos).
 * → { ok: true, path, root } oder { ok: false, error }.
 * Fehler: bad_path, outside_roots, unsupported_container, unsupported_type.
 */
function checkPath(p, roots, kind = 'convert') {
  const clean = cleanAbs(p);
  if (!clean) return { ok: false, error: 'bad_path' };
  const segs = clean.split('/');
  if (segs.some((s) => s === TRASH_DIR || s === WORK_DIR)) return { ok: false, error: 'bad_path' };
  const root = (roots || []).find((r) => clean.startsWith(r + '/'));
  if (!root) return { ok: false, error: 'outside_roots' };
  const name = segs[segs.length - 1];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (kind === 'convert') {
    if (!CONVERT_EXT.has(ext)) return { ok: false, error: 'unsupported_container' };
  } else if (!VIDEO_EXT.has(ext)) return { ok: false, error: 'unsupported_type' };
  return { ok: true, path: clean, root };
}

module.exports = { normalizeTranscode, normalizeRoots, checkPath, cleanAbs, ID_RE, TRASH_DIR, WORK_DIR, VIDEO_EXT, CONVERT_EXT, MAX_ROOTS };
