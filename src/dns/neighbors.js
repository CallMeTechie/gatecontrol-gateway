'use strict';

// Client-IP → MAC aus der Nachbartabelle des Kernels (`ip -j neigh`, IPv4
// und IPv6). Der Kernel kennt die MAC jedes Clients, der gerade fragt – er
// braucht sie, um zu antworten. Neu eingelesen wird höchstens alle
// `minRefreshMs` (bei unbekannter IP) bzw. alle `maxAgeMs`.

const { execFile } = require('node:child_process');
const { normalizeMac } = require('../features/macs');

function execText(bin, args, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });
}

/** `ip -j neigh show` → Map(ip → mac); IPv6 ohne Zonen-Suffix. */
function parseNeighbors(text) {
  const out = new Map();
  if (!String(text).trim()) return out;
  let arr;
  try { arr = JSON.parse(text); } catch (_e) { return out; }
  if (!Array.isArray(arr)) return out;
  for (const e of arr.slice(0, 8192)) {
    if (!e || typeof e.dst !== 'string' || e.dst.length > 64) continue;
    const mac = normalizeMac(e.lladdr || '');
    const states = Array.isArray(e.state) ? e.state : [e.state];
    if (!mac || states.includes('FAILED') || states.includes('INCOMPLETE')) continue;
    out.set(e.dst.toLowerCase(), mac);
  }
  return out;
}

/** "fe80::1%eth0" → "fe80::1", "::ffff:192.168.1.2" → "192.168.1.2" */
function plainIp(ip) {
  let s = String(ip || '').toLowerCase();
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  return s;
}

class NeighborCache {
  constructor({ exec = execText, now = Date.now, minRefreshMs = 5_000, maxAgeMs = 60_000 } = {}) {
    Object.assign(this, { exec, now, minRefreshMs, maxAgeMs });
    this.map = new Map();
    this.loadedAt = 0;
    this.pending = null;
  }

  async refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        this.map = parseNeighbors(await this.exec('ip', ['-j', 'neigh', 'show']));
      } catch (_e) { /* ohne iproute2: keine Zuordnung, Standardprofil */ }
      this.loadedAt = this.now();
    })();
    try { await this.pending; } finally { this.pending = null; }
    return undefined;
  }

  /** MAC zu `ip` (null = unbekannt). Liest die Tabelle nur bei Bedarf und begrenzt neu ein. */
  async macFor(ip) {
    const key = plainIp(ip);
    const age = this.now() - this.loadedAt;
    let mac = this.map.get(key);
    if ((!mac && age >= this.minRefreshMs) || age >= this.maxAgeMs) {
      await this.refresh();
      mac = this.map.get(key);
    }
    return mac || null;
  }
}

module.exports = { NeighborCache, parseNeighbors, plainIp };
