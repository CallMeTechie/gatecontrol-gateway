'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runSelfCheck } = require('../src/health/selfCheck');

describe('selfCheck', () => {
  it('returns structured health result with all layers', async () => {
    const result = await runSelfCheck({
      proxyPort: 9999, // unreachable
      apiPort: 9998,   // unreachable
      tcpPorts: [],
      wgStatus: async () => ({ peers: [{ handshakeAgeS: 30 }] }),
      dnsResolveFn: async () => ['1.2.3.4'],
      reachabilityFn: async () => ({ reachable: true, latencyMs: 10 }),
      routes: [],
    });
    assert.ok('http_proxy_healthy' in result);
    assert.ok('tcp_listeners' in result);
    assert.ok('wg_handshake_age_s' in result);
    assert.ok('dns_resolve_ok' in result);
    assert.ok('route_reachability' in result);
  });

  it('reports wg_handshake_age_s from wgStatus', async () => {
    const result = await runSelfCheck({
      proxyPort: 9999, apiPort: 9998,
      tcpPorts: [],
      wgStatus: async () => ({ peers: [{ handshakeAgeS: 42 }] }),
      dnsResolveFn: async () => [],
      reachabilityFn: async () => ({ reachable: true }),
      routes: [],
    });
    assert.equal(result.wg_handshake_age_s, 42);
  });

  it('returns per-route reachability summary', async () => {
    const result = await runSelfCheck({
      proxyPort: 9999, apiPort: 9998,
      tcpPorts: [],
      wgStatus: async () => ({ peers: [] }),
      dnsResolveFn: async () => [],
      reachabilityFn: async (host, port) => ({ reachable: host === '192.168.1.10', latencyMs: 15 }),
      routes: [
        { id: 1, domain: 'a.example', target_lan_host: '192.168.1.10', target_lan_port: 80 },
        { id: 2, domain: 'b.example', target_lan_host: '192.168.1.20', target_lan_port: 80 },
      ],
    });
    assert.equal(result.route_reachability.length, 2);
    assert.equal(result.route_reachability.find(r => r.route_id === 1).reachable, true);
    assert.equal(result.route_reachability.find(r => r.route_id === 2).reachable, false);
  });
});
