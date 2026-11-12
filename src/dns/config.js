'use strict';

// `features.dns` aus dem Config-Pull (Vertrag Phase 3b §1.1) prüfen und
// kürzen. Fehlt es oder ist es kaputt → aus. Alles ist Server-Eingabe.

const { normalizeMac } = require('../features/macs');
const { cleanDomain } = require('../dnsfilter-core/domainSet');

const PROVIDERS = new Set(['quad9', 'cloudflare', 'dns0', 'custom']);
const FORMATS = new Set(['domains', 'hosts', 'adblock']);
const LIST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const LIMITS = Object.freeze({
  lists: 32, categories: 16, categoryDomains: 20_000, alwaysAllow: 1000, profiles: 32, patterns: 2000,
  schedules: 16, macsPerProfile: 256, macsTotal: 2048, pauses: 512, name: 64,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/** 'example.com' | '*.example.com' → normalisiert oder null. */
function cleanPattern(p) {
  if (typeof p !== 'string') return null;
  const t = p.trim();
  const wild = t.startsWith('*.');
  const d = cleanDomain(wild ? t.slice(2) : t);
  return d ? (wild ? `*.${d}` : d) : null;
}

const patterns = (v, max = LIMITS.patterns) => [...new Set(arr(v, max * 2).map(cleanPattern).filter(Boolean))].slice(0, max);
const macs = (v, max) => [...new Set(arr(v, max * 2).map(normalizeMac).filter(Boolean))].slice(0, max);

function httpsUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname && !x.username && !x.password ? x.toString() : null;
  } catch (_e) {
    return null;
  }
}

/** 'HH:MM' → Minuten seit Mitternacht; `to` darf '24:00' sein. */
function minutes(s, allow24 = false) {
  if (allow24 && s === '24:00') return 1440;
  const m = typeof s === 'string' ? TIME_RE.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function timeMs(v) {
  if (Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string' || v.length > 64) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function normalizeSchedule(s, catKeys) {
  if (!isObj(s)) return null;
  const days = [...new Set(arr(s.days, 7).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort();
  const from = minutes(s.from);
  const to = minutes(s.to, true);
  if (!days.length || from === null || to === null) return null;
  const block = s.block === 'all' ? 'all' : 'categories';
  const categories = [...new Set(arr(s.categories, LIMITS.categories).filter((c) => typeof c === 'string' && catKeys.has(c)))];
  if (block === 'categories' && !categories.length) return null;
  return { days, from, to, block, categories, allowAlways: patterns(s.allowAlways) };
}

function normalizePauses(v) {
  const out = [];
  for (const p of arr(v, LIMITS.pauses)) {
    if (!isObj(p)) continue;
    const until = timeMs(p.until);
    const m = macs(p.macs, LIMITS.macsPerProfile);
    if (until !== null && m.length) out.push({ macs: m, until });
  }
  return out;
}

function normalizeDns(raw) {
  const d = isObj(raw) ? raw : {};
  const up = isObj(d.upstream) ? d.upstream : {};
  let provider = PROVIDERS.has(up.provider) ? up.provider : 'quad9';
  const url = provider === 'custom' ? httpsUrl(up.url) : null;
  if (provider === 'custom' && !url) provider = 'quad9';

  const lists = {};
  if (isObj(d.lists)) {
    for (const [id, l] of Object.entries(d.lists).slice(0, LIMITS.lists * 2)) {
      if (Object.keys(lists).length >= LIMITS.lists) break;
      if (!LIST_ID_RE.test(id) || !isObj(l)) continue;
      const u = httpsUrl(l.url);
      if (!u || !FORMATS.has(l.format)) continue;
      const sha = typeof l.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(l.sha256) ? l.sha256.toLowerCase() : null;
      lists[id] = { url: u, format: l.format, sha256: sha };
    }
  }

  const categories = {};
  if (isObj(d.categories)) {
    for (const [k, v] of Object.entries(d.categories).slice(0, LIMITS.categories)) {
      if (KEY_RE.test(k)) categories[k] = patterns(v, LIMITS.categoryDomains);
    }
  }
  const catKeys = new Set(Object.keys(categories));

  const profiles = [];
  const seenIds = new Set();
  let macBudget = LIMITS.macsTotal;
  for (const p of arr(d.profiles, LIMITS.profiles)) {
    if (!isObj(p)) continue;
    const id = typeof p.id === 'number' && Number.isInteger(p.id) ? String(p.id) : p.id;
    if (typeof id !== 'string' || !PROFILE_ID_RE.test(id) || seenIds.has(id)) continue;
    seenIds.add(id);
    const m = macs(p.macs, Math.min(LIMITS.macsPerProfile, macBudget));
    macBudget -= m.length;
    profiles.push({
      id,
      name: typeof p.name === 'string' ? p.name.slice(0, LIMITS.name) : id,
      lists: [...new Set(arr(p.lists, LIMITS.lists).filter((l) => typeof l === 'string' && lists[l]))],
      safeSearch: p.safeSearch === true,
      allow: patterns(p.allow),
      deny: patterns(p.deny),
      schedules: arr(p.schedules, LIMITS.schedules).map((s) => normalizeSchedule(s, catKeys)).filter(Boolean),
      macs: m,
    });
  }
  const defaultId = typeof d.defaultProfile === 'number' ? String(d.defaultProfile) : d.defaultProfile;
  const defaultProfile = profiles.some((p) => p.id === defaultId) ? defaultId : (profiles[0] ? profiles[0].id : null);

  return {
    enabled: d.enabled === true,
    listen: 'lan',
    upstream: { mode: 'doh', provider, url, fallbackRouter: up.fallbackRouter !== false },
    logQueries: d.logQueries === true,
    alwaysAllow: patterns(d.alwaysAllow, LIMITS.alwaysAllow),
    lists,
    categories,
    profiles,
    defaultProfile,
    pauses: normalizePauses(d.pauses),
    extensions: normalizePauses(d.extensions),
    blockResponse: d.blockResponse === 'nxdomain' ? 'nxdomain' : 'zero',
  };
}

module.exports = { normalizeDns, cleanPattern, minutes, timeMs, httpsUrl, LIMITS };
