'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { ConfigStore } = require('../src/sync/configStore');
const { EgressProxyManager } = require('../src/proxy/egress');

describe('egress heartbeat wiring: self-heal reconcile + status staple', () => {
  let upstream, upstreamPort, blocker, blockedPort;
  before(async () => {
    upstream = net.createServer(s => s.on('data', d => s.write('echo:' + d.toString())));
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = upstream.address().port;
    blocker = net.createServer();
    blockedPort = await new Promise(r => blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)));
  });
  after(() => { upstream?.close(); });

  it('reconcile tick re-applies egress routes and staples status', async () => {
    const store = new ConfigStore();
    const egressMgr = new EgressProxyManager();
    store.on('change', async ({ cfg }) => { await egressMgr.setRoutes(cfg.egress_routes || []); });

    // First config: bind onto the blocked port → fails.
    store.replaceConfig({ routes: [], l4_routes: [], egress_routes: [{
      id: 1, lan_bind_ip: '127.0.0.1', lan_listen_port: blockedPort,
      tunnel_target_host: '127.0.0.1', tunnel_target_port: upstreamPort,
      allowed_source_ips: ['127.0.0.1/32'],
    }] }, 'h1');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(egressMgr.getStatus()[0].bound, false);

    // Port frees, then a heartbeat reconcile tick re-applies (mirror of bootstrap getHealth):
    await new Promise(r => blocker.close(r));
    await egressMgr.setRoutes(store.egressRoutes);          // ← the self-heal line
    const telemetry = { scan_egress_listeners: egressMgr.getStatus() }; // ← the staple line

    assert.equal(telemetry.scan_egress_listeners[0].bound, true, 'self-heal rebound the listener');
    assert.equal(typeof telemetry.scan_egress_listeners[0].source_drops, 'number');
    await egressMgr.stopAll();
  });
});
