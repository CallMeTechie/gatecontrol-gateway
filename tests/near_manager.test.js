'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NearManager } = require('../src/near/nearManager');

/** fakeIO with controlled pgrep responses. pgrepsRunning[i] drives the i-th _keepalivedRunning() probe. */
function makeIO({ pgrepsRunning = [] } = {}) {
  const files = {};
  const calls = [];
  let pgrepIdx = 0;
  return {
    files,
    calls,
    writeFile: async (p, c) => { files[p] = c; },
    chmod: async () => {},
    mkdir: async () => {},
    exec: async (bin, args) => {
      calls.push({ bin, args: args ? [...args] : [] });
      // pgrep keepalived probe (sh -c 'pgrep keepalived ...')
      if (bin === 'sh' && Array.isArray(args) && args.some(a => typeof a === 'string' && a.includes('pgrep'))) {
        const yes = pgrepsRunning[pgrepIdx++] ?? false;
        return { ok: true, stdout: yes ? 'yes' : 'no' };
      }
      // iptables -C → not found so -A will be issued (table-first: -t nat -C ...)
      if (bin === 'iptables' && Array.isArray(args) && args[2] === '-C') {
        return { ok: false };
      }
      return { ok: true };
    },
  };
}

const ROUTE = { id: 7, vip_ip: '192.168.2.250', vip_prefix: 24, lan_listen_port: 14450, near_peers: ['192.168.2.151'] };

describe('NearManager.plan', () => {
  it('emits one vrrp_instance per egress route with a vip_ip (no scripts)', () => {
    const io = makeIO();
    const mgr = new NearManager({ io, iface: 'eth0', selfLanIp: '192.168.2.228', peerLanIps: ['192.168.2.151'], hubTunnelIp: '10.8.0.1' });
    const plan = mgr.plan([
      { id: 7, vip_ip: '192.168.2.250', vip_prefix: 24, lan_listen_port: 14450 },
      { id: 8, vip_ip: null, lan_listen_port: 14451 }, // no vip → skipped
    ]);
    assert.equal(plan.instances.length, 1);
    assert.equal(plan.instances[0].vip, '192.168.2.250');
    assert.match(plan.conf, /vrrp_instance EGRESS_7/);
    assert.match(plan.healthScript, /10\.8\.0\.1/);
    assert.equal(plan.scripts, undefined, 'plan must not return scripts anymore');
  });

  it('uses per-route near_peers for unicast_peer even when manager peerLanIps is empty', () => {
    const io = makeIO();
    const mgr = new NearManager({ io, iface: 'eth0', selfLanIp: '192.168.2.228', peerLanIps: [], hubTunnelIp: '10.8.0.1' });
    const plan = mgr.plan([
      { id: 7, vip_ip: '192.168.2.250', vip_prefix: 24, lan_listen_port: 14450, near_peers: ['192.168.2.151'] },
    ]);
    assert.match(plan.conf, /unicast_src_ip\s+192\.168\.2\.228/);
    assert.match(plan.conf, /unicast_peer\s*\{[^}]*192\.168\.2\.151/s);
  });
});

describe('NearManager.apply', () => {
  it('skips apply (no exec / no write) when selfLanIp is null and there are near routes', async () => {
    const io = makeIO({ pgrepsRunning: [] });
    const mgr = new NearManager({ io, iface: 'eth0', selfLanIp: null, peerLanIps: [], hubTunnelIp: '10.8.0.1' });
    await mgr.apply([ROUTE]);

    const problematicCalls = io.calls.filter(c =>
      c.bin === 'keepalived' || c.bin === 'iptables' ||
      (c.bin === 'sh' && c.args.some(a => typeof a === 'string' && (a.includes('pkill') || a.includes('HUP') || a.includes('pgrep'))))
    );
    assert.equal(problematicCalls.length, 0, `expected no keepalived/iptables/sh exec calls, got: ${JSON.stringify(problematicCalls)}`);
    assert.deepEqual(Object.keys(io.files), [], 'expected no config writeFile');
  });

  it('adds iptables REDIRECT and starts keepalived on first apply', async () => {
    const io = makeIO({ pgrepsRunning: [false] });
    const mgr = new NearManager({ io, iface: 'eth0', selfLanIp: '192.168.2.228', peerLanIps: [], hubTunnelIp: '10.8.0.1' });
    await mgr.apply([ROUTE]);

    const iptablesAdd = io.calls.find(c => c.bin === 'iptables' && c.args[2] === '-A');
    assert.ok(iptablesAdd, 'expected iptables -A call for REDIRECT');
    assert.deepEqual(iptablesAdd.args, ['-t', 'nat', '-A', 'PREROUTING', '-d', '192.168.2.250', '-p', 'tcp', '--dport', '445', '-j', 'REDIRECT', '--to-ports', '14450']);

    const started = io.calls.find(c => c.bin === 'keepalived');
    assert.ok(started, 'expected keepalived start call');
  });

  it('churn guard: second apply with identical config skips keepalived reload', async () => {
    const io = makeIO({ pgrepsRunning: [false, true] }); // 1st probe: not running; 2nd: running
    const mgr = new NearManager({ io, iface: 'eth0', selfLanIp: '192.168.2.228', peerLanIps: [], hubTunnelIp: '10.8.0.1' });

    await mgr.apply([ROUTE]);
    const callsAfterFirst = io.calls.length;

    await mgr.apply([ROUTE]); // same config, keepalived now "running"
    const newCalls = io.calls.slice(callsAfterFirst);

    const reload = newCalls.find(c =>
      (c.bin === 'sh' && c.args.some(a => typeof a === 'string' && a.includes('-HUP'))) ||
      c.bin === 'keepalived'
    );
    assert.ok(!reload, `unexpected reload/start on 2nd apply: ${JSON.stringify(reload)}`);
  });

  it('removes REDIRECT and stops keepalived when all routes removed', async () => {
    const io = makeIO({ pgrepsRunning: [false, true] }); // 1st not running, 2nd running
    const mgr = new NearManager({ io, iface: 'eth0', selfLanIp: '192.168.2.228', peerLanIps: [], hubTunnelIp: '10.8.0.1' });

    await mgr.apply([ROUTE]);
    await mgr.apply([]);

    const iptablesDel = io.calls.find(c => c.bin === 'iptables' && c.args[2] === '-D');
    assert.ok(iptablesDel, 'expected iptables -D call');
    assert.deepEqual(iptablesDel.args, ['-t', 'nat', '-D', 'PREROUTING', '-d', '192.168.2.250', '-p', 'tcp', '--dport', '445', '-j', 'REDIRECT', '--to-ports', '14450']);

    const pkill = io.calls.find(c =>
      c.bin === 'sh' && c.args.some(a => typeof a === 'string' && a.includes('pkill keepalived'))
    );
    assert.ok(pkill, 'expected pkill keepalived call');
  });
});
