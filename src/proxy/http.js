'use strict';

const http = require('node:http');
const httpProxy = require('http-proxy');
const logger = require('../logger');

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
  // use self-signed certs — verifying them would mean the user has to pin a
  // cert per route. For a LAN-only hop that's unnecessary overhead; the hop
  // from the public internet to the gateway is already fully authenticated
  // by WireGuard. Applies to both the web and the ws (wss) upstream.
  const proxy = httpProxy.createProxyServer({ changeOrigin: false, xfwd: true, secure: false });

  // Strip internal X-Gateway-* headers before forwarding to LAN — on both
  // the normal request path (proxyReq) and the WebSocket-upgrade path
  // (proxyReqWs), so neither leaks the gateway's routing metadata.
  const stripGatewayHeaders = (proxyReq) => {
    proxyReq.removeHeader('x-gateway-target');
    proxyReq.removeHeader('x-gateway-target-domain');
  };
  proxy.on('proxyReq', stripGatewayHeaders);
  proxy.on('proxyReqWs', stripGatewayHeaders);

  proxy.on('error', (err, req, resOrSocket) => {
    logger.warn({ err: err.message, code: err.code, url: req?.url }, 'Upstream proxy error');
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
        resOrSocket.writeHead(err.code === 'ECONNREFUSED' ? 502 : 504, { 'Content-Type': 'text/plain' });
        resOrSocket.end(`Gateway upstream error: ${err.code || err.message}`);
      }
    } else if (resOrSocket && typeof resOrSocket.destroy === 'function') {
      wakeIfRefused();
      resOrSocket.destroy();
    }
  });

  // Resolve the upstream URL for a request from its X-Gateway-Target-Domain
  // header (Caddy sets it; falls back to Host). Records the domain on the req
  // for the error handler and returns the upstream URL, or null when no route
  // matches. Shared by the request and the upgrade path.
  const targetUrlFor = (req) => {
    const domain = req.headers['x-gateway-target-domain'] || req.headers.host || '';
    req._targetDomain = domain;
    const target = router.resolve(domain);
    if (!target) return null;
    const scheme = target.backendHttps ? 'https' : 'http';
    return `${scheme}://${target.host}:${target.port}`;
  };

  const server = http.createServer((req, res) => {
    const target = targetUrlFor(req);
    if (!target) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(`No route for domain ${req._targetDomain}`);
    }
    proxy.web(req, res, { target });
  });

  server.on('upgrade', (req, socket, head) => {
    const target = targetUrlFor(req);
    if (!target) { socket.destroy(); return; }
    proxy.ws(req, socket, head, { target });
  });

  return server;
}

module.exports = { createHttpProxy };
