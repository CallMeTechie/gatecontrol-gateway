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

  it('re-applies the L4 route table when listeners are missing (reconcile=true)', async () => {
    // Models the bug: a configured L4 route has no registered listener (bind
    // failed on a prior apply, config hash unchanged since → 'change' never
    // re-fired). The heartbeat path must detect the deficit and re-apply.
    const wireguard = { getStatus: async () => ({ peers: [] }) };
    const store = {
      httpRoutes: [],
      l4Routes: [{ id: 7, listen_port: 3389, target_lan_host: '127.0.0.1', target_lan_port: 1 }],
    };
    let setRoutesCalls = 0;
    let registeredPorts = []; // starts empty → listener missing
    const tcpMgr = {
      listListenerPorts: () => registeredPorts,
      setRoutes: async (routes) => { setRoutesCalls += 1; registeredPorts = routes.map(r => r.listen_port); },
    };
    const config = { proxyPort: 1, apiPort: 1, tunnelIp: '127.0.0.1', serverUrl: 'https://127.0.0.1' };

    const run = createSelfCheckRunner({ config, store, tcpMgr, wireguard });
    const result = await run({ reconcile: true });

    assert.equal(setRoutesCalls, 1, 'missing listener triggers exactly one re-apply');
    assert.equal(result.listener_reapply_triggered, true);
    assert.equal(result.l4_listeners_missing, 0, 're-check after re-apply shows the listener restored');
  });

  it('does NOT re-apply on the read-only path (reconcile=false)', async () => {
    const wireguard = { getStatus: async () => ({ peers: [] }) };
    const store = {
      httpRoutes: [],
      l4Routes: [{ id: 7, listen_port: 3389, target_lan_host: '127.0.0.1', target_lan_port: 1 }],
    };
    let setRoutesCalls = 0;
    const tcpMgr = { listListenerPorts: () => [], setRoutes: async () => { setRoutesCalls += 1; } };
    const config = { proxyPort: 1, apiPort: 1, tunnelIp: '127.0.0.1', serverUrl: 'https://127.0.0.1' };

    const run = createSelfCheckRunner({ config, store, tcpMgr, wireguard });
    const result = await run();

    assert.equal(setRoutesCalls, 0, '/api/status reads stay side-effect free');
    assert.equal(result.l4_listeners_missing, 1);
    assert.notEqual(result.listener_reapply_triggered, true);
  });
});
