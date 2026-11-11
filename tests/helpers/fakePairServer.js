'use strict';

// Test-Server für die Einrichtungsseite: POST /api/v1/gateway/pair wie
// GateControl (src/routes/api/gateway.js dort) – ein Code gilt einmal.

const https = require('node:https');
const { makeSelfSigned } = require('../../src/cache/selfsigned');

const API_TOKEN = 'gc_gw_' + 'a'.repeat(64);
const GATEWAY_TOKEN = 'b'.repeat(64);

function envContent({ serverUrl = 'https://gate.example.de', name = 'Synology Keller', tunnelIp = '10.8.0.7' } = {}) {
  return [
    '# GateControl Home Gateway — Pairing Config',
    `# Peer: ${name} (ID: 7)`,
    '',
    `GC_SERVER_URL=${serverUrl}`,
    `GC_API_TOKEN=${API_TOKEN}`,
    `GC_GATEWAY_TOKEN=${GATEWAY_TOKEN}`,
    `GC_TUNNEL_IP=${tunnelIp}`,
    'GC_PROXY_PORT=8080',
    'GC_API_PORT=9876',
    'WG_PRIVATE_KEY=priv',
    'WG_PUBLIC_KEY=pub',
    'WG_PRESHARED_KEY=',
    'WG_ENDPOINT=gate.example.de:51820',
    'WG_SERVER_PUBLIC_KEY=srv',
    `WG_ADDRESS=${tunnelIp}/32`,
    'WG_ALLOWED_IPS=10.8.0.1/32',
    'WG_DNS=10.8.0.1',
    '',
  ].join('\n');
}

/**
 * @param {{ codes?: string[], handler?: Function, env?: object }} [opts]
 *   `handler(req, res, body)` ersetzt die normale Antwort (true = erledigt).
 */
async function startFakePairServer(opts = {}) {
  const tls = makeSelfSigned({ altNames: [{ dns: 'localhost' }, { ip: '127.0.0.1' }] });
  const codes = new Set(opts.codes || ['A3F9-27C1-0BDE-58E4']);
  const requests = [];
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      requests.push({ method: req.method, url: req.url, body });
      if (opts.handler && opts.handler(req, res, body)) return;
      if (req.method !== 'POST' || req.url !== '/api/v1/gateway/pair') { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<h1>Not found</h1>'); return; }
      res.setHeader('Content-Type', 'application/json');
      if (!body || !codes.delete(body.code)) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid_or_expired' })); return; }
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, envContent: envContent({ serverUrl: `https://127.0.0.1:${server.address().port}`, ...opts.env }) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    address: `127.0.0.1:${port}`,
    server: { host: '127.0.0.1', port },
    tls: { ca: tls.cert },
    requests,
    codes,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

module.exports = { startFakePairServer, envContent, API_TOKEN, GATEWAY_TOKEN };
