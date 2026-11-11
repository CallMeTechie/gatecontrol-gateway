'use strict';

// Zustand der Einrichtungsseite (docs/setup-page.md):
//
//   setup       keine (gültige) gateway.env – Code-Eingabe (A, B, D)
//   connecting  Zugangsdaten da, Tunnel/erster Kontakt stehen noch aus (C)
//   connected   reine Statusanzeige ohne Eingaben (E)
//   invalid     der Server lehnt den Zugang dauerhaft ab – Code-Eingabe mit
//               fester Serveradresse (F)
//
// Die Seite zeigt nie Schlüssel oder Zugangsdaten; was von hier nach außen
// geht (snapshot), besteht nur aus Kennungen, Zahlen und geprüften Namen.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseConfig } = require('../config');
const { parseCode, parseServer, parseCidrs } = require('./net');
const { createChecks, ready } = require('./checks');
const pairing = require('./pairing');
const { detectPlatform } = require('./platform');

const RATE_MAX = 5;
const RATE_WINDOW_MS = 5 * 60 * 1000;
// Zugang gilt erst als ungültig, wenn der Server es mehrfach hintereinander
// und über diese Zeit hinweg sagt (Heartbeat alle 30 s → rund zwei Minuten).
const INVALID_MIN_COUNT = 4;
const INVALID_MIN_SPAN_MS = 90_000;
const INVALID_ERRORS = new Set(['invalid_token', 'invalid_token_format', 'missing_bearer_token']);
const HANDSHAKE_FRESH_S = 180;
const WG_STATUS_TTL_MS = 5_000;
const PREFS_FILE = 'setup-page.json';

function gatewayVersion() {
  try { return require('../../package.json').version; } catch { return null; }
}

function createSetupController({
  envPath, stateDir, logger, now = Date.now,
  wireguard = null, lanIp = () => null, checksDeps, redeem = pairing.redeem, tls,
  platform = detectPlatform(), onRestart = () => {},
}) {
  const configDir = path.dirname(envPath);
  const checks = createChecks({ configDir, deps: checksDeps, now });
  const csrf = crypto.randomBytes(24).toString('hex');
  const attempts = [];
  const listeners = new Set();

  const s = {
    mode: 'setup',
    config: null,
    server: null, // { host, port, display, origin }
    name: null,
    paired: false, // in diesem Prozess über die Seite verbunden
    busy: false,
    steps: { code: null, saved: null, tunnel: 'todo', online: 'todo' },
    startFailed: false,
    lastContactAt: 0,
    tunnelSince: 0,
    wgUp: false,
    invalidCount: 0,
    invalidSince: 0,
    statusPage: readPrefs().status !== false,
  };
  let pairWaiter = null;
  let wgCache = { at: 0, fresh: false };

  function readPrefs() {
    try { const j = JSON.parse(fs.readFileSync(path.join(stateDir, PREFS_FILE), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
  }
  function writePrefs() {
    try { fs.writeFileSync(path.join(stateDir, PREFS_FILE), JSON.stringify({ status: s.statusPage })); } catch (err) {
      logger.debug({ err: err.message }, 'setup page: preference not stored');
    }
  }
  function changed() { for (const fn of listeners) { try { fn(); } catch { /* Zuhörer */ } } }

  function adopt(config, envContent) {
    s.config = config;
    try {
      const u = new URL(config.serverUrl);
      const https = u.protocol === 'https:';
      s.server = { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (https ? 443 : 80), display: u.host, origin: u.origin, https };
    } catch { s.server = null; }
    s.name = pairing.peerNameFromEnv(envContent);
  }

  /** gateway.env beim Start lesen. null → Einrichtungsmodus. */
  function load() {
    let raw;
    try { raw = fs.readFileSync(envPath, 'utf8'); } catch (err) {
      logger.warn({ path: envPath, code: err.code }, 'No readable gateway.env — setup mode');
      return null;
    }
    try {
      const config = parseConfig(raw);
      adopt(config, raw);
      s.mode = 'connecting';
      s.steps = { code: null, saved: 'done', tunnel: 'wait', online: 'todo' };
      return config;
    } catch (err) {
      // zod nennt nur Feldnamen und Regeln, keine Werte
      logger.warn({ path: envPath, err: String(err.message).slice(0, 500) }, 'gateway.env is not valid — setup mode');
      return null;
    }
  }

  /** Wartet im Einrichtungsmodus, bis ein Code eingelöst und die gateway.env geschrieben ist. */
  function waitForPairing() {
    return new Promise((resolve) => { pairWaiter = resolve; });
  }

  function rateState() {
    const t = now();
    while (attempts.length && t - attempts[0] >= RATE_WINDOW_MS) attempts.shift();
    const left = Math.max(0, RATE_MAX - attempts.length);
    return { left, retryAfterS: left > 0 ? 0 : Math.ceil((attempts[0] + RATE_WINDOW_MS - t) / 1000) };
  }

  /**
   * „Verbinden“. Ergebnis { ok: true } oder { ok: false, error, retryAfterS? }
   * mit fester Fehlerkennung – nie Text des Servers.
   */
  async function pair(input) {
    if (s.mode !== 'setup' && s.mode !== 'invalid') return { ok: false, status: 409, error: 'not_in_setup' };
    if (s.busy) return { ok: false, status: 409, error: 'busy' };
    const parsed = parseCode(input && input.code);
    if (!parsed) return { ok: false, status: 400, error: 'bad_code' };
    // F: die Serveradresse ist fest die bisherige – kein Umhängen aus dem Heimnetz
    const server = s.mode === 'invalid' ? s.server : parseServer((input && input.server) || parsed.host || '');
    if (!server) return { ok: false, status: 400, error: 'bad_server' };
    if (s.mode === 'invalid' && !server.https) return { ok: false, status: 400, error: 'bad_server' };

    const rate = rateState();
    if (rate.left <= 0) return { ok: false, status: 429, error: 'rate_limited', retryAfterS: rate.retryAfterS };
    attempts.push(now());

    s.busy = true;
    try {
      // Erst prüfen, dann einlösen: ein eingelöster Code ist verbraucht und
      // macht den alten Zugang ungültig.
      const c = await checks.get({ force: true });
      if (!c.config) return { ok: false, status: 409, error: 'config_readonly' };
      if (s.mode === 'setup' && !ready(c)) return { ok: false, status: 409, error: 'not_ready' };

      let result;
      try {
        result = await redeem({ server, code: parsed.code, tls });
      } catch (err) {
        const code = err instanceof pairing.PairError ? err.code : 'server_unreachable';
        logger.warn({ server: server.display, reason: code, detail: err.detail || undefined }, 'Pairing failed');
        return { ok: false, status: 502, error: code, server: server.display };
      }
      try {
        pairing.writeEnvAtomic(envPath, result.envContent);
      } catch (err) {
        logger.error({ err: err.code || err.message }, 'Pairing: gateway.env could not be written');
        return { ok: false, status: 500, error: 'write_failed' };
      }
      // Raspberry-Pi-Image: gatecontrol-setup.path startet danach die übrigen Dienste (edge, mqtt)
      try { fs.writeFileSync(path.join(stateDir, 'setup-done'), ''); } catch { /* /state nicht beschreibbar */ }
      const wasInvalid = s.mode === 'invalid';
      adopt(result.config, result.envContent);
      s.paired = true;
      s.mode = 'connecting';
      s.startFailed = false;
      s.invalidCount = 0;
      s.steps = { code: 'done', saved: 'done', tunnel: 'wait', online: 'todo' };
      logger.info({ server: server.display }, 'Pairing code accepted, gateway.env written');
      changed();
      if (wasInvalid) setImmediate(() => onRestart());
      else if (pairWaiter) { const w = pairWaiter; pairWaiter = null; w(result.config); }
      return { ok: true };
    } finally {
      s.busy = false;
    }
  }

  // ── Rückmeldungen aus dem laufenden Gateway (bootstrap.js) ──
  const hooks = {
    onStage(stage) {
      if (stage === 'wg_up') s.wgUp = true;
    },
    /** @param {{ ok: boolean, status?: number|null, error?: string|null }} r Ergebnis eines Heartbeats */
    onHeartbeat(r) {
      if (r && r.ok) {
        s.lastContactAt = now();
        s.invalidCount = 0;
        s.steps.online = 'done';
        if (s.mode === 'connecting' || s.mode === 'invalid') { s.mode = 'connected'; changed(); }
        return;
      }
      // Nur eine ausdrückliche Absage des Servers zählt – kein Netzfehler,
      // kein Timeout, kein TLS-Fehler, keine Fehlerseite eines Proxys.
      const refused = r && (r.status === 401 || r.status === 403) && INVALID_ERRORS.has(r.error);
      if (!refused) return;
      if (s.invalidCount === 0) s.invalidSince = now();
      s.invalidCount += 1;
      if (s.mode !== 'invalid' && s.mode !== 'setup' && s.invalidCount >= INVALID_MIN_COUNT && now() - s.invalidSince >= INVALID_MIN_SPAN_MS) {
        logger.warn({ count: s.invalidCount }, 'Server rejects the gateway access — setup page asks for a new code');
        s.mode = 'invalid';
        changed();
      }
    },
    /** Config-Pull: `features.setup_page.status === false` schaltet die Statusseite ab (Standard an). */
    onConfig(cfg) {
      const f = cfg && cfg.features && cfg.features.setup_page;
      const on = !(f && typeof f === 'object' && f.status === false);
      if (on === s.statusPage) return;
      s.statusPage = on;
      writePrefs();
      logger.info({ enabled: on }, 'Status page in the home network switched by the server');
      changed();
    },
    telemetry() {
      return { status: s.statusPage, mode: s.mode };
    },
    startFailed() {
      s.startFailed = true;
      changed();
    },
  };

  async function tunnelFresh() {
    if (!wireguard || !s.wgUp) return false;
    if (now() - wgCache.at < WG_STATUS_TTL_MS) return wgCache.fresh;
    let fresh = false;
    try {
      const st = await wireguard.getStatus();
      fresh = st.peers.some((p) => p.handshakeAgeS !== null && p.handshakeAgeS < HANDSHAKE_FRESH_S);
    } catch { fresh = false; }
    wgCache = { at: now(), fresh };
    if (fresh) { if (!s.tunnelSince) s.tunnelSince = now(); s.steps.tunnel = 'done'; } else s.tunnelSince = 0;
    return fresh;
  }

  /** Soll der Port gerade offen sein? Einrichtung und „Zugang ungültig“ immer, die Statusseite nur wenn eingeschaltet. */
  function visible() {
    return s.mode === 'setup' || s.mode === 'invalid' || s.paired || s.statusPage;
  }

  /** Wer darf nicht anfragen: Adressen des Tunnels. */
  function tunnel() {
    if (!s.config) return {};
    return { tunnelIp: s.config.tunnelIp, tunnelCidrs: [...parseCidrs(s.config.wg.address), ...parseCidrs(s.config.wg.allowedIps)] };
  }

  /** Alles, was die Seite anzeigen darf. */
  async function snapshot({ recheck = false } = {}) {
    const t = now();
    const base = {
      mode: s.mode,
      device: platform.label,
      platform: platform.kind,
      version: gatewayVersion(),
      lanIp: lanIp(),
      name: s.name,
      server: s.server ? s.server.display : null,
      csrf,
    };
    if (s.mode === 'setup' || s.mode === 'invalid') {
      const c = await checks.get({ force: recheck });
      const rate = rateState();
      return { ...base, checks: c, ready: s.mode === 'invalid' ? c.config : ready(c), busy: s.busy, attemptsLeft: rate.left, retryAfterS: rate.retryAfterS };
    }
    const up = await tunnelFresh();
    if (s.mode === 'connecting') {
      return { ...base, steps: { ...s.steps }, startFailed: s.startFailed };
    }
    return {
      ...base,
      lastContactS: s.lastContactAt ? Math.max(0, Math.round((t - s.lastContactAt) / 1000)) : null,
      tunnelUp: up,
      tunnelSinceS: up && s.tunnelSince ? Math.max(0, Math.round((t - s.tunnelSince) / 1000)) : null,
      openUrl: s.server ? `${s.server.origin}/gateways` : null,
    };
  }

  return {
    load, waitForPairing, pair, snapshot, hooks, visible, tunnel, csrf,
    mode: () => s.mode,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    _state: s,
  };
}

module.exports = { createSetupController, RATE_MAX, RATE_WINDOW_MS, INVALID_MIN_COUNT, INVALID_MIN_SPAN_MS };
