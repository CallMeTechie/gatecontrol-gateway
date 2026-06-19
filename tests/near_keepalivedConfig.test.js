'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildKeepalivedConf } = require('../src/near/keepalivedConfig');

describe('keepalived config generator', () => {
  const conf = buildKeepalivedConf({
    iface: 'eth0', routerIdBase: 50, healthCheckCmd: '/run/keepalived/health.sh',
    instances: [{ name: 'EGRESS_NAS1', vrid: 51, priority: 150, vip: '192.168.2.250',
                  unicastSrc: '192.168.2.228', unicastPeers: ['192.168.2.151'] }],
  });
  it('declares the vrrp_script health check', () => {
    assert.match(conf, /vrrp_script\s+chk_tunnel\s*\{[^}]*script\s+"\/run\/keepalived\/health\.sh"/s);
  });
  it('declares the instance with the VIP, vrid, priority, iface', () => {
    assert.match(conf, /vrrp_instance\s+EGRESS_NAS1\s*\{/);
    assert.match(conf, /virtual_router_id\s+51/);
    assert.match(conf, /priority\s+150/);
    assert.match(conf, /interface\s+eth0/);
    assert.match(conf, /192\.168\.2\.250/);
  });
  it('wires unicast peers and track_script (no notify lines)', () => {
    assert.match(conf, /unicast_src_ip\s+192\.168\.2\.228/);
    assert.match(conf, /unicast_peer\s*\{[^}]*192\.168\.2\.151/s);
    assert.match(conf, /track_script\s*\{[^}]*chk_tunnel/s);
    assert.doesNotMatch(conf, /notify_master/);
    assert.doesNotMatch(conf, /notify_backup/);
    assert.doesNotMatch(conf, /notify_fault/);
  });
});
