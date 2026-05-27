'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { hostsInSubnet, probePort, sweep, parseArp } = require('../src/discovery/tcpSweep');

test('hostsInSubnet enumerates usable hosts (excludes network + broadcast)', () => {
  const h = hostsInSubnet('192.168.1.0/24');
  assert.equal(h.length, 254);
  assert.equal(h[0], '192.168.1.1');
  assert.equal(h[h.length - 1], '192.168.1.254');
  assert.equal(hostsInSubnet('10.0.0.0/30').length, 2); // .1 .2
});

test('probePort: open vs closed', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;
  assert.equal(await probePort('127.0.0.1', port, 500), true);
  srv.close();
  assert.equal(await probePort('127.0.0.1', 1, 300), false); // almost certainly closed
});

test('sweep uses injected probeFn, bounded, returns open host:port', async () => {
  const open = new Set(['192.168.1.5:80', '192.168.1.9:443']);
  let inflightMax = 0, inflight = 0;
  const probeFn = async (ip, port) => {
    inflight++; inflightMax = Math.max(inflightMax, inflight);
    await new Promise(r => setTimeout(r, 1));
    inflight--;
    return open.has(`${ip}:${port}`);
  };
  const res = await sweep({ subnetCidr: '192.168.1.0/24', ports: [80, 443], concurrency: 8, timeoutMs: 200, jitterMs: 0, probeFn });
  const keys = res.map(r => `${r.ip}:${r.port}`).sort();
  assert.deepEqual(keys, ['192.168.1.5:80', '192.168.1.9:443']);
  assert.ok(inflightMax <= 8);
});

test('parseArp maps ip→mac, ignores incomplete entries', () => {
  const content = [
    'IP address       HW type     Flags       HW address            Mask     Device',
    '192.168.1.10     0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0',
    '192.168.1.11     0x1         0x0         00:00:00:00:00:00     *        eth0',
  ].join('\n');
  const m = parseArp(content);
  assert.equal(m.get('192.168.1.10'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(m.has('192.168.1.11'), false); // flag 0x0 = incomplete
});
