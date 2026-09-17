'use strict';

const http = require('node:http');
const httpProxy = require('http-proxy');
const logger = require('../logger');
const { getPinnedAgent, PIN_MISMATCH_CODE } = require('./tlsPin');

// Body of the plain-text error returned when a route asks for certificate
// pinning but the configured fingerprint is unusable. Same shape as the
// upstream-error body below so clients see one consistent format.
const PIN_CONFIG_CODE = 'ERR_TLS_PIN_CONFIG';

/**
 * Create the HTTP reverse-proxy server. Reads `X-Gateway-Target-Domain`
 * header to determine which LAN-target to forward to. Handles both plain
 * HTTP requests AND WebSocket upgrades — e.g. the Proxmox noVNC console,
 * which tunnels VNC over a WebSocket on the same backend port (8006), or
 * Home-Assistant's live event stream. Node routes Upgrade requests to the
 * server's 'upgrade' event instead of 'request'; without an 'upgrade'
 * handler the connection is dropped and browser consoles hang.
 *
 * Strips `X-Gateway-*` headers before forwarding (don't leak internal info).
 *
 * On ECONNREFUSED, if wolMac is present, fires the WoL trigger via
 * onUpstreamUnreachable.
 */
function createHttpProxy({ router, onUpstreamUnreachable }) {
  // secure:false disables LAN-cert verification. LAN HTTPS targets
  // (DSM on :5001, Proxmox on :8006, router admin UIs, etc.) almost always
  // use self-signed certs — verifying them against a public CA would reject
  // every one of them. The hop from the public internet to the gateway is
  // already fully authenticated by WireGuard. Applies to both the web and the
  // ws (wss) upstream.
  //
  // A route MAY opt into certificate pinning by carrying
  // `backend_tls_fingerprint`: for those the per-request `agent` below checks
  // the backend's leaf certificate against the pin and refuses the connection
  // on mismatch (see ./tlsPin.js). Routes without a fingerprint keep exactly
  // the behaviour above.
  const proxy = httpProxy.createProxyServer({ changeOrigin: false, xfwd: true, secure: false });

  // Strip internal X-Gateway-* headers before forwarding to LAN — on both
  // the normal request path (proxyReq) and the WebSocket-upgrade path
  // (proxyReqWs), so neither leaks the gateway's routing metadata.
  //
  // Belt and braces: the authoritative strip happens in `targetFor()` on the
  // *incoming* headers, because http-proxy fires 'proxyReq' from the outgoing
  // request's 'socket' event — and a pinned route only gets its socket after
  // the TLS handshake, by which time the outgoing headers are already
  // rendered and removeHeader() would throw. The hook stays as a safety net
  // for anything that reaches http-proxy with those headers still attached,
  // and no-ops once the header block is fixed.
  const stripGatewayHeaders = (proxyReq) => {
    if (proxyReq.headersSent) return;
    proxyReq.removeHeader('x-gateway-target');
    proxyReq.removeHeader('x-gateway-target-domain');
  };
  proxy.on('proxyReq', stripGatewayHeaders);
  proxy.on('proxyReqWs', stripGatewayHeaders);

  proxy.on('error', (err, req, resOrSocket) => {
    const pinMismatch = err.code === PIN_MISMATCH_CODE;
    if (pinMismatch) {
      // Fingerprints are public certificate metadata, not secrets — logging
      // expected vs. seen is what makes this diagnosable (cert renewed on the
      // backend vs. something else answering on that host:port).
      logger.error({
        domain: req?._targetDomain,
        routeId: req?._targetRouteId,
        target: `${err.pinHost}:${err.pinPort}`,
        expected: err.expectedFingerprint,
        seen: err.actualFingerprint,
        ws: !(resOrSocket instanceof http.ServerResponse),
        url: req?.url,
      }, 'Backend TLS certificate does not match the pinned fingerprint — refused, nothing was forwarded');
    } else {
      logger.warn({ err: err.message, code: err.code, url: req?.url }, 'Upstream proxy error');
    }
    const wakeIfRefused = () => {
      if (err.code === 'ECONNREFUSED' && typeof onUpstreamUnreachable === 'function') {
        const target = router.resolve(req?._targetDomain);
        if (target && target.wolMac) {
          onUpstreamUnreachable({ domain: req._targetDomain, target });
        }
      }
    };
    // web path → http.ServerResponse (has writeHead); ws path → net.Socket.
    // Calling writeHead on a raw socket would throw and crash the gateway, so
    // the two cases must be handled separately.
    if (resOrSocket instanceof http.ServerResponse) {
      if (!resOrSocket.headersSent) {
        wakeIfRefused();
        resOrSocket.writeHead(err.code === 'ECONNREFUSED' || pinMismatch ? 502 : 504, { 'Content-Type': 'text/plain' });
        resOrSocket.end(`Gateway upstream error: ${err.code || err.message}`);
      }
    } else if (resOrSocket && typeof resOrSocket.destroy === 'function') {
      wakeIfRefused();
      resOrSocket.destroy();
    }
  });

  // Resolve the route for a request from its X-Gateway-Target-Domain header
  // (Caddy sets it; falls back to Host). Records domain and route id on the
  // req for the error handler and returns the route entry, or null when no
  // route matches. Shared by the request and the upgrade path.
  const targetFor = (req) => {
    const domain = req.headers['x-gateway-target-domain'] || req.headers.host || '';
    req._targetDomain = domain;
    // Drop the routing metadata now that it has been read: http-proxy copies
    // `req.headers` verbatim into the outgoing request, so removing them here
    // keeps them off the wire on every path, including pinned routes where
    // the 'proxyReq' hook runs too late to edit headers (see above).
    delete req.headers['x-gateway-target'];
    delete req.headers['x-gateway-target-domain'];
    const target = router.resolve(domain);
    if (!target) return null;
    req._targetRouteId = target.routeId;
    return target;
  };

  // Build the per-request http-proxy options. A pinned HTTPS route gets a
  // dedicated agent that verifies the backend's leaf certificate against the
  // route's fingerprint before the request is allowed onto the socket.
  const proxyOptionsFor = (target, { upgrade }) => {
    const scheme = target.backendHttps ? 'https' : 'http';
    const options = { target: `${scheme}://${target.host}:${target.port}` };
    if (target.backendHttps && target.backendTlsFingerprint) {
      options.agent = getPinnedAgent({
        host: target.host,
        port: target.port,
        fingerprint: target.backendTlsFingerprint,
      });
      // http-proxy forces `Connection: close` only when it runs agent-less
      // (its default). With an agent supplied it would forward the client's
      // `Connection: keep-alive` instead, so re-assert close here to keep the
      // pinned path's socket lifecycle identical to the unpinned one. On the
      // upgrade path the client's `Connection: Upgrade` must survive untouched.
      if (!upgrade) options.headers = { connection: 'close' };
    }
    return options;
  };

  const server = http.createServer((req, res) => {
    const target = targetFor(req);
    if (!target) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(`No route for domain ${req._targetDomain}`);
    }
    // Pinning was requested but the fingerprint is unusable — fail closed
    // rather than fall back to an unverified connection.
    if (target.backendTlsPinInvalid) {
      logger.error({ domain: req._targetDomain, routeId: target.routeId },
        'Route has an unusable backend_tls_fingerprint — refusing to proxy');
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(`Gateway upstream error: ${PIN_CONFIG_CODE}`);
    }
    proxy.web(req, res, proxyOptionsFor(target, { upgrade: false }));
  });

  server.on('upgrade', (req, socket, head) => {
    const target = targetFor(req);
    if (!target) { socket.destroy(); return; }
    if (target.backendTlsPinInvalid) {
      logger.error({ domain: req._targetDomain, routeId: target.routeId },
        'Route has an unusable backend_tls_fingerprint — refusing WebSocket upgrade');
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head, proxyOptionsFor(target, { upgrade: true }));
  });

  return server;
}

module.exports = { createHttpProxy };
