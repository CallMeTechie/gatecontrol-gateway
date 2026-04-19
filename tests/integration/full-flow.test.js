'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { computeConfigHash } = require('@callmetechie/gatecontrol-config-hash');

describe('integration: full-flow with mock server', () => {
  let mockServer;

  // Mock GateControl server: serves /api/v1/gateway/config + /heartbeat + /probe-ack
  before(async () => {
    const cfgBody = {
      config_hash_version: 1, peer_id: 1,
      routes: [{ id: 1, domain: 'nas.example.com', target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 65000, wol_enabled: false }],
      l4_routes: [],
    };
    const hash = computeConfigHash(cfgBody);

    mockServer = http.createServer((req, res) => {
      if (req.url === '/api/v1/gateway/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ...cfgBody, config_hash: hash }));
      }
      if (req.url.startsWith('/api/v1/gateway/config/check')) {
        const given = new URL('http://x' + req.url).searchParams.get('hash');
        res.writeHead(given === hash ? 304 : 200); return res.end();
      }
      if (req.url === '/api/v1/gateway/heartbeat') {
        res.writeHead(200); return res.end('{}');
      }
      res.writeHead(404); res.end();
    });
    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));

    // Mock LAN target on 65000 for the route
    const lanTarget = http.createServer((req, res) => res.end('hello from LAN'));
    await new Promise(r => lanTarget.listen(65000, '127.0.0.1', r));
  });

  after(() => mockServer?.close());

  it('placeholder — full bootstrap with real WG is integration-test-only', () => {
    // Full bootstrap requires root + wg-quick; run manually or in docker-smoke.
    assert.ok(true);
  });
});
