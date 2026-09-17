'use strict';

const https = require('node:https');
const logger = require('../logger');

/**
 * Certificate pinning for HTTPS LAN backends.
 *
 * Background: LAN targets (DSM on :5001, Proxmox on :8006, router admin UIs)
 * practically always present a self-signed certificate, so the proxy talks to
 * them with `secure: false` — no chain, no hostname check. That is fine for
 * confidentiality but gives no identity: anything that can answer on
 * `host:port` is accepted. GateControl's server can store a per-route SHA-256
 * fingerprint of the backend's leaf certificate and ships it in the gateway
 * config as `backend_tls_fingerprint`. When a route carries one, this module
 * replaces "verify nothing" with "verify exactly this certificate".
 *
 * Deliberately NOT chain verification: pinning is the whole trust decision for
 * a self-signed LAN cert. Turning `rejectUnauthorized` back on would reject
 * every real-world LAN backend, so the pin is the check — not an addition to
 * one. A route without a fingerprint keeps today's behaviour unchanged.
 *
 * Fail-closed by construction: the connected socket is handed to the HTTP
 * client only *after* the fingerprint matched. Node's `http.Agent` waits for
 * the `createConnection` callback when the method returns nothing, so on a
 * mismatch the request never gets a socket and not a single byte of it — no
 * request line, no headers, no body, no `Authorization` — is written to the
 * backend. The socket is destroyed immediately and, because pinned agents run
 * with `keepAlive: false`, it can never be pooled and handed to a later
 * request.
 */

/** `err.code` raised when the backend certificate does not match the pin. */
const PIN_MISMATCH_CODE = 'ERR_TLS_PIN_MISMATCH';

/** Canonical wire format: bare lowercase hex, no colons, no "sha256:" prefix. */
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

// One agent per (host, port, fingerprint). A gateway serves a handful of
// routes, so this map stays tiny; the cap only guards against an unbounded
// route table (or a flapping fingerprint) slowly growing it. Pinned agents
// hold no keep-alive sockets, so dropping them is free.
const MAX_CACHED_AGENTS = 256;
const agentCache = new Map();

/**
 * Normalise a certificate fingerprint to bare lowercase hex, or null when the
 * input is not a usable SHA-256 fingerprint.
 *
 * The server sends the canonical form (64 lowercase hex chars). The colon-
 * separated / uppercase / "sha256:"-prefixed spellings are accepted too —
 * they denote the very same certificate, and OpenSSL, browsers and Node's own
 * `fingerprint256` each print a different one, so rejecting them would only
 * turn a copy-paste into a hard outage. Anything that is not exactly 32 bytes
 * of hex after normalisation returns null and the caller must fail closed.
 */
function normalizeFingerprint(raw) {
  if (typeof raw !== 'string') return null;
  const hex = raw.trim().toLowerCase().replace(/^sha256:/, '').replace(/[\s:-]/g, '');
  return FINGERPRINT_RE.test(hex) ? hex : null;
}

function pinMismatchError({ host, port, expected, actual }) {
  const err = new Error(
    `backend TLS certificate for ${host}:${port} does not match the pinned fingerprint`
  );
  err.code = PIN_MISMATCH_CODE;
  err.pinHost = host;
  err.pinPort = port;
  // Fingerprints are public certificate metadata, not secrets — carrying them
  // on the error is what lets the proxy log expected-vs-seen for diagnosis.
  err.expectedFingerprint = expected;
  err.actualFingerprint = actual;
  return err;
}

class PinnedHttpsAgent extends https.Agent {
  constructor({ host, port, fingerprint }) {
    super({
      // Same socket lifecycle as the unpinned path (http-proxy runs with
      // `agent: false`, i.e. one connection per request). Beyond parity this
      // is a hard safety property: no pooled socket means a rejected peer can
      // never be reused, and every single request re-checks the certificate
      // instead of inheriting a decision made minutes ago.
      keepAlive: false,
      // MUST stay 0. On a resumed TLS session the server does not re-send its
      // certificate, so `getPeerCertificate()` comes back empty and there is
      // nothing left to pin against — the check would either break every
      // second request or, if it were lenient about an empty certificate,
      // silently stop verifying after the first handshake. Disabling session
      // caching forces a full handshake, and therefore a real certificate, on
      // every connection.
      maxCachedSessions: 0,
      // The pin IS the verification — see the module comment.
      rejectUnauthorized: false,
    });
    this.pinHost = host;
    this.pinPort = port;
    this.pinFingerprint = fingerprint;
  }

  /**
   * Returns nothing and calls `cb` only once the peer certificate matched, so
   * `http.Agent` keeps the request parked until then. On mismatch the socket
   * is destroyed and `cb` gets a PIN_MISMATCH_CODE error, which surfaces as a
   * normal request 'error' and lands in the proxy's existing error handler.
   */
  createConnection(options, cb) {
    const socket = super.createConnection(options);

    if (typeof cb !== 'function') {
      // Defensive: no callback to defer to (not a path http.Agent takes).
      // Still fail closed — destroy the socket the moment the pin fails.
      socket.once('secureConnect', () => {
        const err = this._verifyPeer(socket);
        if (err) socket.destroy(err);
      });
      return socket;
    }

    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) socket.destroy();
      cb(err, err ? undefined : socket);
    };
    socket.once('secureConnect', () => settle(this._verifyPeer(socket)));
    socket.once('error', (err) => settle(err));
    return undefined;
  }

  /** null when the leaf certificate matches the pin, else a mismatch error. */
  _verifyPeer(socket) {
    const peer = typeof socket.getPeerCertificate === 'function'
      ? socket.getPeerCertificate()
      : null;
    // getPeerCertificate() (no `detailed`) is the leaf/end-entity certificate.
    const seen = normalizeFingerprint(peer && peer.fingerprint256);
    if (seen !== null && seen === this.pinFingerprint) return null;
    return pinMismatchError({
      host: this.pinHost,
      port: this.pinPort,
      expected: this.pinFingerprint,
      actual: seen || 'none',
    });
  }
}

/**
 * Agent for a pinned backend, cached per (host, port, fingerprint). A rotated
 * fingerprint yields a new key and therefore a new agent — a stale pin can
 * never be served from the cache.
 */
function getPinnedAgent({ host, port, fingerprint }) {
  const key = `${host}|${port}|${fingerprint}`;
  const cached = agentCache.get(key);
  if (cached) return cached;
  if (agentCache.size >= MAX_CACHED_AGENTS) {
    logger.warn({ cached: agentCache.size }, 'Pinned-agent cache full — clearing');
    agentCache.clear();
  }
  const agent = new PinnedHttpsAgent({ host, port, fingerprint });
  agentCache.set(key, agent);
  return agent;
}

/** Test helper: drop all cached agents. */
function _resetPinnedAgents() {
  agentCache.clear();
}

module.exports = {
  PIN_MISMATCH_CODE,
  PinnedHttpsAgent,
  getPinnedAgent,
  normalizeFingerprint,
  _resetPinnedAgents,
};
