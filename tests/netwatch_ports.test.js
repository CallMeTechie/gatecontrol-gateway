'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { PORTS, serviceFor, allowedTargets, scanPorts, MAX_CONCURRENCY } = require('../src/netwatch/ports');
const { probePort } = require('../src/discovery/tcpSweep');

describe('port scan limits', () => {
  it('fixed list from the contract (39 ports, all valid, no duplicates)', () => {
    assert.equal(PORTS.length, 39);
    assert.equal(new Set(PORTS).size, PORTS.length);
    for (const p of [21, 22, 23, 445, 3389, 5900, 6379, 8123, 32400, 62078]) assert.ok(PORTS.includes(p), String(p));
    assert.equal(serviceFor(23), 'telnet');
    assert.equal(serviceFor(3000), null);
    assert.equal(serviceFor('constructor'), null);
  });

  it('only RFC 1918 targets, never the tunnel IP or own addresses', () => {
    const got = allowedTargets(
      ['192.168.1.5', '10.8.0.3', '10.0.0.7', '172.16.4.4', '172.32.0.1', '8.8.8.8', '169.254.1.1', '127.0.0.1', '192.168.1.2', '192.168.1.5', 'x'],
      { tunnelIp: '10.8.0.3', ownIps: ['192.168.1.2'] },
    );
    assert.deepEqual(got, ['192.168.1.5', '10.0.0.7', '172.16.4.4']);
  });

  it('never more than 16 probes at once, even if more is requested', async () => {
    let active = 0;
    let max = 0;
    const probeFn = async (ip, port) => {
      active++; max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return ip === '192.168.1.5' && (port === 80 || port === 23);
    };
    const res = await scanPorts(['192.168.1.5', '192.168.1.6', '8.8.8.8'], { concurrency: 500, probeFn, tunnelIp: '10.8.0.2' });
    assert.ok(max <= MAX_CONCURRENCY, `max ${max}`);
    assert.ok(max > 1);
    assert.deepEqual([...res.keys()], ['192.168.1.5', '192.168.1.6']);
    assert.deepEqual(res.get('192.168.1.5'), [{ port: 23, service: 'telnet' }, { port: 80, service: 'http' }]);
    assert.deepEqual(res.get('192.168.1.6'), []);
  });

  it('no allowed targets → no probes', async () => {
    let calls = 0;
    const res = await scanPorts(['8.8.8.8', '10.8.0.2'], { tunnelIp: '10.8.0.2', probeFn: async () => { calls++; return true; } });
    assert.equal(res.size, 0);
    assert.equal(calls, 0);
  });

  it('real TCP probe: open and closed local port within the time limit', async () => {
    const srv = net.createServer((s) => s.end());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const t0 = Date.now();
    assert.equal(await probePort('127.0.0.1', port, 700), true);
    srv.close();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await probePort('127.0.0.1', port, 700), false);
    assert.ok(Date.now() - t0 < 1500);
  });
});
