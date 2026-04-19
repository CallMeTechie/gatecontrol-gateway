'use strict';

const http = require('node:http');
const httpProxy = require('http-proxy');
const logger = require('../logger');

/**
 * Create the HTTP reverse-proxy server. Reads `X-Gateway-Target-Domain`
 * header to determine which LAN-target to forward to.
 *
 * Strips `X-Gateway-*` headers before forwarding (don't leak internal info).
 *
 * On ECONNREFUSED, if wolMac is present, returns a hint status. Caller
 * (bootstrap) should wire WoL trigger into this error event.
 */
function createHttpProxy({ router, onUpstreamUnreachable }) {
  const proxy = httpProxy.createProxyServer({ changeOrigin: false, xfwd: true });
  proxy.on('proxyReq', (proxyReq) => {
    // Strip X-Gateway-* headers before forwarding to LAN
    proxyReq.removeHeader('x-gateway-target');
    proxyReq.removeHeader('x-gateway-target-domain');
  });

  proxy.on('error', (err, req, res) => {
    logger.warn({ err: err.message, code: err.code, url: req?.url }, 'Upstream proxy error');
    if (res && !res.headersSent) {
      if (err.code === 'ECONNREFUSED' && typeof onUpstreamUnreachable === 'function') {
        const target = router.resolve(req._targetDomain);
        if (target && target.wolMac) {
          onUpstreamUnreachable({ domain: req._targetDomain, target });
        }
      }
      res.writeHead(err.code === 'ECONNREFUSED' ? 502 : 504, { 'Content-Type': 'text/plain' });
      res.end(`Gateway upstream error: ${err.code || err.message}`);
    }
  });

  return http.createServer((req, res) => {
    const domain = req.headers['x-gateway-target-domain'] || req.headers.host || '';
    req._targetDomain = domain;
    const target = router.resolve(domain);
    if (!target) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(`No route for domain ${domain}`);
    }
    proxy.web(req, res, {
      target: `http://${target.host}:${target.port}`,
    });
  });
}

module.exports = { createHttpProxy };
