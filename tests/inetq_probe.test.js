'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { parsePingOutput, createPinger, measure, tcpRtt } = require('../src/inetq/probe');

const IPUTILS = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.

--- 1.1.1.1 ping statistics ---
5 packets transmitted, 4 received, 20% packet loss, time 812ms
rtt min/avg/max/mdev = 13.201/14.388/15.902/0.911 ms
`;
const BUSYBOX = `PING 9.9.9.9 (9.9.9.9): 56 data bytes

--- 9.9.9.9 ping statistics ---
3 packets transmitted, 3 packets received, 0% packet loss
round-trip min/avg/max = 9.1/10.5/12.0 ms
`;
const NONE = `--- 192.168.1.1 ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 2040ms
`;

describe('ping output', () => {
  it('parses iputils, busybox and total loss', () => {
    assert.deepEqual(parsePingOutput(IPUTILS), { sent: 5, received: 4, rttMs: 14.388 });
    assert.deepEqual(parsePingOutput(BUSYBOX), { sent: 3, received: 3, rttMs: 10.5 });
    assert.deepEqual(parsePingOutput(NONE), { sent: 3, received: 0, rttMs: null });
    assert.equal(parsePingOutput('ping: socket: Operation not permitted'), null);
    assert.equal(parsePingOutput(undefined), null);
  });
});

describe('pinger', () => {
  it('uses ping with safe arguments; only IPv4 literals', async () => {
    const calls = [];
    const p = createPinger({ exec: async (args) => { calls.push(args); return { code: 0, stdout: IPUTILS, stderr: '' }; } });
    assert.deepEqual(await p.ping('1.1.1.1', 5), { sent: 5, received: 4, rttMs: 14.388 });
    assert.deepEqual(calls[0], ['-n', '-q', '-c', '5', '-i', '0.2', '-W', '1', '-w', '3', '1.1.1.1']);
    assert.deepEqual(await p.ping('-f; rm', 3), { sent: 3, received: 0, rttMs: null });
    assert.equal(calls.length, 1);
    assert.equal(p.mode(), 'icmp');
  });

  it('falls back to TCP for good when ping is missing or not permitted', async () => {
    const tcpCalls = [];
    const p = createPinger({
      exec: async () => ({ code: 2, stdout: '', stderr: 'ping: socket: Operation not permitted' }),
      tcp: async (h, port) => { tcpCalls.push(port); return port === 443 ? 12.5 : null; },
    });
    assert.deepEqual(await p.ping('1.1.1.1', 2), { sent: 2, received: 2, rttMs: 12.5 });
    assert.equal(p.mode(), 'tcp');
    assert.deepEqual(tcpCalls, [53, 443, 53, 443]);
    const q = createPinger({ exec: async () => ({ code: 'ENOENT', stdout: '', stderr: '' }), tcp: async () => null });
    assert.deepEqual(await q.ping('1.1.1.1', 1), { sent: 1, received: 0, rttMs: null });
    assert.equal(q.mode(), 'tcp');
  });

  it('host down with ping available stays ICMP', async () => {
    const p = createPinger({ exec: async () => ({ code: 1, stdout: '', stderr: '' }) });
    assert.deepEqual(await p.ping('192.168.1.1', 3), { sent: 3, received: 0, rttMs: null });
    assert.equal(p.mode(), 'icmp');
  });
});

describe('measure', () => {
  it('combines router, public targets and server', async () => {
    const pinger = {
      ping: async (h, count) => (h === '192.168.1.1' ? { sent: count, received: count, rttMs: 1.5 }
        : h === '1.1.1.1' ? { sent: count, received: 5, rttMs: 12 } : { sent: count, received: 3, rttMs: 16 }),
    };
    const r = await measure({ pinger, routerIp: '192.168.1.1', targets: ['1.1.1.1', '9.9.9.9'], server: { host: 'gc.example', port: 443 }, tcp: async () => 30.2, now: () => 42 });
    assert.deepEqual(r, { at: 42, routerOk: true, rttRouterMs: 1.5, inetOk: true, rttInetMs: 14, sent: 10, received: 8, rttServerMs: 30.2 });
  });

  it('no default route → routerOk null', async () => {
    const pinger = { ping: async (h, count) => ({ sent: count, received: 0, rttMs: null }) };
    const r = await measure({ pinger, routerIp: null, targets: ['1.1.1.1'], server: null, now: () => 1 });
    assert.equal(r.routerOk, null);
    assert.equal(r.inetOk, false);
    assert.equal(r.rttServerMs, null);
  });
});

describe('tcpRtt', () => {
  it('open and refused ports both count as reachable', async () => {
    const srv = net.createServer((s) => s.end());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const open = await tcpRtt('127.0.0.1', port, 1000);
    assert.equal(typeof open, 'number');
    srv.close();
    await new Promise((r) => setTimeout(r, 20));
    const refused = await tcpRtt('127.0.0.1', port, 1000);
    assert.equal(typeof refused, 'number');
  });
});
