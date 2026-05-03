'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createSelfCheckRunner } = require('../src/health/selfCheckRunner');

// We can't avoid touching the real DNS / TCP-probe code without rewriting
// runSelfCheck, so we stand up a tiny TCP listener for proxy/api checks
// and rely on the fact that all probes time out fast on a closed port.

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

describe('selfCheckRunner', () => {
  it('builds routes from store with l4:<port> domain labels', async () => {
    const proxyPort = await freePort();
    const apiPort = await freePort();

    // Stub WG status and a controllable store + tcpMgr.
    const wireguard = {
      getStatus: async () => ({ peers: [{ handshakeAgeS: 42 }] }),
    };
    const store = {
      httpRoutes: [{ id: 1, domain: 'nas.example.com', target_lan_host: '127.0.0.1', target_lan_port: 1 }],
      l4Routes: [{ id: 7, listen_port: 3389, target_lan_host: '127.0.0.1', target_lan_port: 1 }],
    };
    const tcpMgr = { listListenerPorts: () => [] };
    const config = {
      proxyPort, apiPort,
      tunnelIp: '127.0.0.1',
      serverUrl: 'https://127.0.0.1', // hostname is an IP — dns.resolve4 of an IP rejects, but selfCheck swallows it
    };

    const run = createSelfCheckRunner({ config, store, tcpMgr, wireguard });
    const result = await run();

    assert.equal(result.wg_handshake_age_s, 42);
    assert.equal(Array.isArray(result.route_reachability), true);
    assert.equal(result.route_reachability.length, 2);
    const l4Entry = result.route_reachability.find(r => r.route_id === 7);
    assert.equal(l4Entry.domain, 'l4:3389', 'L4 routes get a synthesized domain label');
    const httpEntry = result.route_reachability.find(r => r.route_id === 1);
    assert.equal(httpEntry.domain, 'nas.example.com');
  });

  it('returns overall_healthy=false when proxy/api are not bound', async () => {
    const wireguard = { getStatus: async () => ({ peers: [] }) };
    const store = { httpRoutes: [], l4Routes: [] };
    const tcpMgr = { listListenerPorts: () => [] };
    const config = {
      proxyPort: 1, // intentionally unreachable
      apiPort: 1,
      tunnelIp: '127.0.0.1',
      serverUrl: 'https://127.0.0.1',
    };

    const run = createSelfCheckRunner({ config, store, tcpMgr, wireguard });
    const result = await run();
    assert.equal(result.overall_healthy, false);
    assert.equal(result.http_proxy_healthy, false);
    assert.equal(result.api_healthy, false);
  });
});
