'use strict';

// UDP-Routen im Config-Pull, im Hash, in der Selbstprüfung und als Capability
// (docs/udp.md).

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const dgram = require('node:dgram');
const { computeConfigHash } = require('@callmetechie/gatecontrol-config-hash');
const { configHash, stableJson } = require('../src/features/config');
const { ConfigStore } = require('../src/sync/configStore');
const { CAPABILITIES } = require('../src/features/manager');
const { UdpProxyManager } = require('../src/proxy/udp');
const { createSelfCheckRunner } = require('../src/health/selfCheckRunner');
const { runSelfCheck } = require('../src/health/selfCheck');

const base = { config_hash_version: 1, peer_id: 3, routes: [], l4_routes: [] };
const udp = [{ id: 7, listen_port: 5353, target_lan_host: '192.168.1.20', target_lan_port: 53 }];

describe('UDP-Routen: Config-Hash', () => {
  it('ohne udp_routes unverändert (älterer Server)', () => {
    assert.equal(configHash(base, computeConfigHash), computeConfigHash(base));
  });

  it('mit udp_routes: sha256(h + \\nudp_routes\\n + stableJson(udp_routes)), nach features', () => {
    const lib = computeConfigHash(base);
    const want = 'sha256:' + crypto.createHash('sha256').update(lib + '\nudp_routes\n' + stableJson(udp)).digest('hex');
    assert.equal(configHash({ ...base, udp_routes: udp }, computeConfigHash), want);

    const features = { netwatch: { enabled: true } };
    const withF = 'sha256:' + crypto.createHash('sha256').update(lib + '\n' + stableJson(features)).digest('hex');
    const both = 'sha256:' + crypto.createHash('sha256').update(withF + '\nudp_routes\n' + stableJson(udp)).digest('hex');
    assert.equal(configHash({ ...base, features, udp_routes: udp }, computeConfigHash), both);
  });

  it('eine geänderte UDP-Route ändert den Hash (das Gateway holt die Konfiguration neu)', () => {
    const a = configHash({ ...base, udp_routes: udp }, computeConfigHash);
    const b = configHash({ ...base, udp_routes: [{ ...udp[0], target_lan_port: 5300 }] }, computeConfigHash);
    const empty = configHash({ ...base, udp_routes: [] }, computeConfigHash);
    assert.notEqual(a, b);
    assert.notEqual(a, empty);
    assert.notEqual(empty, computeConfigHash(base), 'leere Liste = Server kennt UDP, Hash anders als ohne Feld');
  });
});

describe('UDP-Routen: ConfigStore und Capability', () => {
  it('ConfigStore übernimmt geprüfte udp_routes, ohne Feld bleibt die Liste leer', () => {
    const store = new ConfigStore();
    store.replaceConfig({ ...base, udp_routes: [...udp, { id: 'x' }] }, 'h1');
    assert.deepEqual(store.udpRoutes, udp);
    store.replaceConfig({ ...base }, 'h2');
    assert.deepEqual(store.udpRoutes, []);
  });

  it('meldet die Capability udp-routes', () => {
    assert.ok(CAPABILITIES.includes('udp-routes'));
  });
});

describe('UDP-Routen: Selbstprüfung', () => {
  const cleanup = [];
  afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

  const listen = () => new Promise((resolve) => {
    const s = net.createServer(sock => sock.end());
    s.listen(0, '127.0.0.1', () => { cleanup.push(() => new Promise(r => s.close(r))); resolve(s.address().port); });
  });

  it('runSelfCheck zählt UDP mit: fehlender UDP-Listener → missing, Grund in den issues, Zähler in udp_listeners', async () => {
    const r = await runSelfCheck({
      proxyPort: 9, apiPort: 9, tcpPorts: [], bindIp: '127.0.0.1',
      wgStatus: async () => ({ peers: [] }), dnsResolveFn: async () => [], reachabilityFn: async () => ({ reachable: true }), routes: [],
      l4RouteCount: 0,
      udpRouteCount: 2, udpListenerCount: 1,
      udpIssues: [{ route_id: 4, listen_port: 5353, reason: 'port_in_use', code: 'EADDRINUSE', protocol: 'udp' }],
      udpStatus: [{ route_id: 5, listen_port: 27015, sessions: 3 }],
    });
    assert.equal(r.l4_routes_configured, 2);
    assert.equal(r.l4_listeners_missing, 1);
    assert.deepEqual(r.l4_listener_issues, [{ route_id: 4, listen_port: 5353, reason: 'port_in_use', code: 'EADDRINUSE', protocol: 'udp' }]);
    assert.deepEqual(r.udp_listeners, [{ route_id: 5, listen_port: 27015, sessions: 3 }]);
    assert.equal(r.overall_healthy, false);
  });

  it('UDP-Route direkt vom Zieldienst bedient: nicht fehlend, ohne Probe', async () => {
    const r = await runSelfCheck({
      proxyPort: 9, apiPort: 9, tcpPorts: [], bindIp: '127.0.0.1',
      wgStatus: async () => ({ peers: [] }), dnsResolveFn: async () => [], reachabilityFn: async () => ({ reachable: true }), routes: [],
      udpRouteCount: 1, udpDirect: [{ route_id: 8, listen_port: 5353 }],
    });
    assert.equal(r.l4_listeners_missing, 0);
    assert.deepEqual(r.l4_listeners_direct, [{ route_id: 8, listen_port: 5353, protocol: 'udp' }]);
  });

  it('Runner: Abgleich bindet einen UDP-Listener neu, sobald der Port frei ist; UDP-Ziele nicht in route_reachability', async () => {
    const proxyPort = await listen();
    const apiPort = await listen();
    const busy = dgram.createSocket('udp4');
    await new Promise(r => busy.bind(0, '127.0.0.1', r));
    const port = busy.address().port;
    const udpMgr = new UdpProxyManager({ bindIp: '127.0.0.1' });
    cleanup.push(() => udpMgr.stopAll());
    const store = { httpRoutes: [], l4Routes: [], udpRoutes: [{ id: 3, listen_port: port, target_lan_host: '192.168.1.20', target_lan_port: 53 }] };
    const run = createSelfCheckRunner({
      config: { proxyPort, apiPort, tunnelIp: '127.0.0.1', serverUrl: 'https://127.0.0.1' },
      store, tcpMgr: { listListenerPorts: () => [], setRoutes: async () => {} }, udpMgr, wireguard: { getStatus: async () => ({ peers: [] }) },
    });
    await udpMgr.setRoutes(store.udpRoutes);
    let h = await run({ reconcile: true });
    assert.equal(h.l4_listeners_missing, 1);
    assert.equal(h.l4_listener_issues[0].protocol, 'udp');
    assert.equal(h.route_reachability.length, 0);

    await new Promise(r => busy.close(r));
    h = await run({ reconcile: true });
    assert.equal(h.listener_reapply_triggered, true);
    assert.equal(h.l4_listeners_missing, 0);
    assert.deepEqual(udpMgr.listListenerPorts(), [port]);
    assert.equal(h.udp_listeners.length, 1);
    assert.equal(h.udp_listeners[0].route_id, 3);
  });
});
