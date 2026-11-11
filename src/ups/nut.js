'use strict';

// USV-Zustand über einen NUT-Server (Network UPS Tools, TCP 3493), z. B. die
// Synology (Vertrag Phase 3a, Abschnitt 5). Nur lesende Befehle ohne
// Anmeldung: `LIST UPS`, `LIST VAR <ups>`. Ziel nur im Heimnetz: RFC 1918 oder
// – in einem Netz ohne IPv4 – eine private IPv6-Adresse (ULA, fc00::/7). Alle
// 30 s; Ergebnis geht als `telemetry.ups` mit dem Heartbeat an den Server.

const net = require('node:net');
const dns = require('node:dns');
const logger = require('../logger');
const { FeatureStatus, loop } = require('../features/status');
const { isPrivateIpv4, isUlaIpv6 } = require('../discovery/lanInterfaces');

const INTERVAL_MS = 30_000;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;
const MAX_LINES = 1000;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

class NutError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** Eine NUT-Antwortzeile in Wörter zerlegen ("…" mit \" und \\). */
function splitNutLine(line) {
  const out = [];
  let i = 0;
  const s = String(line);
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue; }
    let w = '';
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i++;
        w += s[i++];
      }
      i++;
    } else {
      while (i < s.length && s[i] !== ' ') w += s[i++];
    }
    out.push(w);
  }
  return out;
}

/** LIST-Antwort (Zeilen) → [[wörter…]] ohne BEGIN/END; ERR → NutError. */
function parseList(lines, what) {
  const rows = [];
  let inside = false;
  for (const l of lines) {
    const w = splitNutLine(l);
    if (w[0] === 'ERR') throw new NutError(`nut_error:${(w[1] || 'UNKNOWN').slice(0, 32)}`);
    if (w[0] === 'BEGIN' && w[1] === 'LIST' && w[2] === what) { inside = true; continue; }
    if (w[0] === 'END' && w[1] === 'LIST' && w[2] === what) return rows;
    if (inside) rows.push(w);
  }
  throw new NutError('protocol');
}

/** Zeilenorientierte Sitzung. `request(cmd, endPrefix)` liest bis zur END-Zeile oder ERR. */
function openSession({ host, port, timeoutMs = TIMEOUT_MS, connect = net.createConnection }) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let buf = '';
    let total = 0;
    let waiter = null;
    let lines = [];
    const fail = (err) => {
      clearTimeout(connectTimer);
      sock.destroy();
      if (waiter) { const w = waiter; waiter = null; w.reject(err); } else reject(err);
    };
    sock.setTimeout(timeoutMs, () => fail(new NutError('timeout')));
    const connectTimer = setTimeout(() => fail(new NutError('timeout')), timeoutMs);
    sock.on('error', () => fail(new NutError('connect')));
    sock.on('close', () => { if (waiter) fail(new NutError('protocol')); });
    sock.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) return fail(new NutError('protocol'));
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!waiter) continue;
        lines.push(line);
        if (lines.length > MAX_LINES) return fail(new NutError('protocol'));
        if (line.startsWith('ERR ') || line.startsWith(waiter.end)) {
          const w = waiter; waiter = null; const got = lines; lines = [];
          w.resolve(got);
        }
      }
    });
    sock.once('connect', () => clearTimeout(connectTimer));
    sock.once('connect', () => resolve({
      request(cmd, end) {
        return new Promise((res, rej) => {
          waiter = { resolve: res, reject: rej, end };
          sock.write(cmd + '\n');
        });
      },
      close() { try { sock.end('LOGOUT\n'); } catch (_e) { /* zu */ } setTimeout(() => sock.destroy(), 200).unref(); },
    }));
  });
}

async function resolvePrivate(host, lookup) {
  if (net.isIPv6(host)) {
    if (!isUlaIpv6(host)) throw new NutError('not_private');
    return host;
  }
  let ip = host;
  if (!net.isIPv4(host)) {
    try { ip = (await lookup(host, { family: 4 })).address; } catch (_e) {
      // kein A-Eintrag: ein Heimnetz ohne IPv4 – dann zählt der AAAA-Eintrag (nur ULA)
      try { ip = (await lookup(host, { family: 6 })).address; } catch (_e2) { throw new NutError('connect'); }
      if (!isUlaIpv6(ip)) throw new NutError('not_private');
      return ip;
    }
  }
  if (!isPrivateIpv4(ip)) throw new NutError('not_private');
  return ip;
}

const num = (v) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === 'string' && v ? v.slice(0, 64) : null);

/** → { name, status, charge, runtimeSec, model, mfr } oder wirft NutError. */
async function queryUps({ host, port = 3493, name = null, timeoutMs = TIMEOUT_MS, connect, lookup = dns.promises.lookup }) {
  const ip = await resolvePrivate(host, lookup);
  const s = await openSession({ host: ip, port, timeoutMs, connect });
  try {
    let ups = name;
    if (!ups) {
      const rows = parseList(await s.request('LIST UPS', 'END LIST UPS'), 'UPS');
      const first = rows.find((w) => w[0] === 'UPS' && NAME_RE.test(w[1] || ''));
      if (!first) throw new NutError('no_ups');
      ups = first[1];
    }
    if (!NAME_RE.test(ups)) throw new NutError('no_ups');
    const vars = new Map();
    for (const w of parseList(await s.request(`LIST VAR ${ups}`, `END LIST VAR ${ups}`), 'VAR')) {
      if (w[0] === 'VAR' && w[1] === ups && w.length >= 4) vars.set(w[2], w[3]);
    }
    return {
      name: ups,
      status: str(vars.get('ups.status')),
      charge: num(vars.get('battery.charge')),
      runtimeSec: num(vars.get('battery.runtime')),
      model: str(vars.get('device.model') || vars.get('ups.model')),
      mfr: str(vars.get('device.mfr') || vars.get('ups.mfr')),
    };
  } finally {
    s.close();
  }
}

class UpsMonitor {
  constructor({ query = queryUps, now = Date.now, intervalMs = INTERVAL_MS } = {}) {
    this.query = query;
    this.now = now;
    this.status = new FeatureStatus(now);
    this.cfg = { enabled: false, host: '', port: 3493, name: null };
    this.result = null;
    this.loop = loop(() => this.tick(), () => intervalMs);
  }

  apply({ enabled, host, port, name }) {
    const prev = this.cfg;
    this.cfg = { enabled: !!enabled, host, port, name };
    this.status.setEnabled(this.cfg.enabled);
    const changed = prev.host !== host || prev.port !== port || prev.name !== name;
    if (!this.cfg.enabled) { this.loop.stop(); this.result = null; return; }
    if (!prev.enabled || changed) { this.result = null; this.loop.start(1_000); }
  }

  stop() { this.loop.stop(); }

  async tick() {
    if (!this.cfg.enabled) return;
    this.status.start();
    try {
      const r = await this.query({ host: this.cfg.host, port: this.cfg.port, name: this.cfg.name });
      this.result = { ...r, at: this.now() };
      this.status.ok();
    } catch (err) {
      const code = err instanceof NutError ? err.code : 'protocol';
      this.result = { error: code, at: this.now() };
      this.status.fail(code);
      logger.debug({ err: code }, 'ups: query failed');
    }
  }

  /** Für `telemetry.ups`: null wenn aus. */
  telemetry() {
    return this.cfg.enabled ? this.result : null;
  }

  featureTelemetry() {
    return this.status.snapshot({ host: this.cfg.host || null, port: this.cfg.port, name: this.cfg.name });
  }
}

module.exports = { queryUps, UpsMonitor, splitNutLine, parseList, NutError };
