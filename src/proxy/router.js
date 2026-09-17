'use strict';

const { normalizeFingerprint } = require('./tlsPin');
const logger = require('../logger');

class Router {
  constructor() {
    this._map = new Map();
  }

  /**
   * Atomic swap of the routing table. Existing in-flight requests use the old
   * map via their closure; new requests get the new map.
   */
  setRoutes(httpRoutes) {
    const next = new Map();
    for (const route of httpRoutes) {
      // Per-route certificate pin for HTTPS LAN backends. The server sends the
      // SHA-256 of the backend's leaf certificate as bare lowercase hex, or
      // omits the field. Present-but-unusable is NOT the same as absent: it
      // means the operator asked for pinning and we cannot honour it, so the
      // route is marked broken and the proxy refuses it (fail closed) instead
      // of silently downgrading to "verify nothing".
      const rawFingerprint = route.backend_tls_fingerprint;
      const configured = rawFingerprint !== undefined && rawFingerprint !== null && rawFingerprint !== '';
      const fingerprint = configured ? normalizeFingerprint(rawFingerprint) : null;
      const backendHttps = !!route.backend_https;
      if (configured && !backendHttps) {
        // Nothing to pin on a cleartext hop, so the pin is inert rather than
        // broken. Not a hard failure: this only happens when a route was
        // switched back to http:// while the stored fingerprint lingered, and
        // refusing would break a route the operator just asked for in plain
        // HTTP without protecting anything. Loud enough to be noticed instead.
        logger.warn(
          { routeId: route.id, domain: route.domain },
          'backend_tls_fingerprint set on a plain-http route — pin has no effect; set backend_https to enable it'
        );
      } else if (configured && !fingerprint) {
        logger.error(
          { routeId: route.id, domain: route.domain },
          'Route carries an unusable backend_tls_fingerprint (expected 64 hex chars) — refusing to proxy this route'
        );
      }
      next.set(route.domain, {
        host: route.target_lan_host,
        port: route.target_lan_port,
        // LAN-side scheme. true = https://. Without a pin, certificate
        // verification stays off (self-signed is the LAN default — DSM on
        // :5001, router admin panels, etc). Omitted / falsy = http://.
        backendHttps,
        wolMac: route.wol_enabled ? (route.wol_mac || null) : null,
        routeId: route.id,
        backendTlsFingerprint: fingerprint,
        // Only an HTTPS route can be broken by an unusable pin; on a plain-http
        // route there is no TLS to verify, so the route still serves (warned above).
        backendTlsPinInvalid: backendHttps && configured && !fingerprint,
      });
    }
    this._map = next;
  }

  resolve(domain) {
    return this._map.get(domain) || null;
  }
}

module.exports = { Router };
