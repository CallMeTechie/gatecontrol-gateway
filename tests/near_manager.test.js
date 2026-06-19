'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NearManager } = require('../src/near/nearManager');

function fakeIO() {
  const files = {};
  return {
    files,
    writeFile: async (p, c) => { files[p] = c; },
    chmod: async () => {},
    mkdir: async () => {},
    exec: async () => ({ ok: true }),
  };
}

describe('NearManager.plan', () => {
  it('emits one vrrp_instance + master/backup scripts per egress route with a vip_ip', () => {
    const io = fakeIO();
    const mgr = new NearManager({ io, iface: 'eth0', selfLanIp: '192.168.2.228', peerLanIps: ['192.168.2.151'], hubTunnelIp: '10.8.0.1' });
    const plan = mgr.plan([
      { id: 7, vip_ip: '192.168.2.250', vip_prefix: 24, lan_listen_port: 14450 },
      { id: 8, vip_ip: null, lan_listen_port: 14451 }, // no vip → skipped (not a Synology near route)
    ]);
    assert.equal(plan.instances.length, 1);
    assert.equal(plan.instances[0].vip, '192.168.2.250');
    assert.match(plan.conf, /vrrp_instance EGRESS_7/);
    assert.ok(plan.scripts['EGRESS_7_master.sh'].includes('14450'));
    assert.ok(plan.scripts['EGRESS_7_backup.sh'].includes('-D'));
    assert.match(plan.healthScript, /10\.8\.0\.1/);
  });

  it('uses per-route near_peers for unicast_peer even when manager peerLanIps is empty', () => {
    const io = fakeIO();
    // Production bootstrap constructs with peerLanIps: [] — server delivers near_peers inside each route
    const mgr = new NearManager({ io, iface: 'eth0', selfLanIp: '192.168.2.228', peerLanIps: [], hubTunnelIp: '10.8.0.1' });
    const plan = mgr.plan([
      { id: 7, vip_ip: '192.168.2.250', vip_prefix: 24, lan_listen_port: 14450, near_peers: ['192.168.2.151'] },
    ]);
    assert.match(plan.conf, /unicast_src_ip\s+192\.168\.2\.228/);
    assert.match(plan.conf, /unicast_peer\s*\{[^}]*192\.168\.2\.151/s);
  });
});
