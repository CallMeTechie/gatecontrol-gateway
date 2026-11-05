'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NetWatch, isRandomMac, hostsFor, REPORT_PATH } = require('../src/netwatch/netwatch');

const MIN = 60_000;

function setup({ online = new Map(), names = new Map(), stateDir, postOk = true, ports = new Map(), nb = new Map() } = {}) {
  let t = Date.UTC(2026, 10, 5, 12, 0, 0);
  const posts = [];
  const portCalls = [];
  const sweeps = [];
  const env = {
    online, names, ports, nb, postOk,
    clock: { now: () => t, advance: (ms) => { t += ms; } },
  };
  const scanner = {
    sweep: async (hosts, opts) => { sweeps.push({ hosts, opts }); return { online: env.online, names: env.names }; },
    netbiosNames: async (ips) => new Map([...env.nb].filter(([ip]) => ips.includes(ip))),
    mode: () => 'ip',
  };
  const nw = new NetWatch({
    scanner,
    oui: { lookup: (mac) => (mac.startsWith('00:11:32') ? 'Synology' : null) },
    reporter: { post: async (p, body) => { posts.push({ p, body: JSON.parse(JSON.stringify(body)) }); return env.postOk ? { ok: true, status: 200 } : { ok: false, status: 502 }; } },
    stateDir: stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'nw-')),
    tunnelIp: '10.8.0.5',
    getSubnets: () => [{ cidr: '192.168.1.0/24', localIp: '192.168.1.2' }],
    reverseDns: async (ip) => (ip === '192.168.1.30' ? 'tv-wohnzimmer' : null),
    portScanner: async (ips, opts) => { portCalls.push({ ips, opts }); return new Map(ips.map((ip) => [ip, env.ports.get(ip) || []])); },
    ownIps: () => ['192.168.1.2'],
    now: env.clock.now,
    rand: () => 0.5,
  });
  return { nw, posts, portCalls, sweeps, env };
}

describe('NetWatch', () => {
  it('helpers: random MAC bit and host lists', () => {
    assert.equal(isRandomMac('02:00:00:00:00:01'), true);
    assert.equal(isRandomMac('da:a1:19:00:00:01'), true);
    assert.equal(isRandomMac('00:11:32:aa:bb:01'), false);
    assert.equal(hostsFor('192.168.1.0/24').length, 254);
    assert.equal(hostsFor('10.0.0.0/22').length, 1022);
    assert.equal(hostsFor('10.0.0.0/16', { maxPrefix: 22, localIp: '10.0.5.9' })[0], '10.0.5.1');
    assert.equal(hostsFor('10.0.0.0/16', { maxPrefix: 22 }).length, 0);
  });

  it('first run: full report, vendor/names/randomMac, port scan of new devices, own IP excluded', async () => {
    const { nw, posts, portCalls, sweeps, env } = setup({
      online: new Map([['192.168.1.10', '00:11:32:aa:bb:01'], ['192.168.1.20', '02:aa:bb:cc:dd:ee'], ['192.168.1.30', 'a8:23:fe:44:55:66']]),
      names: new Map([['192.168.1.20', 'Galaxy-A54']]),
      nb: new Map([['192.168.1.10', 'NAS-BUERO']]),
      ports: new Map([['192.168.1.10', [{ port: 445, service: 'smb' }]]]),
    });
    nw.apply({ enabled: true, portscan: true });
    nw.loop.stop();
    assert.equal(await nw.run(), true);
    assert.ok(!sweeps[0].hosts.includes('192.168.1.2'));
    assert.equal(sweeps[0].opts.bindIp, '192.168.1.2');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].p, REPORT_PATH);
    const b = posts[0].body;
    assert.equal(b.full, true);
    assert.equal(b.scanAt, env.clock.now());
    const byMac = Object.fromEntries(b.devices.map((d) => [d.mac, d]));
    assert.deepEqual(byMac['00:11:32:aa:bb:01'], {
      mac: '00:11:32:aa:bb:01', ip: '192.168.1.10', vendor: 'Synology', hostname: 'NAS-BUERO', nameSource: 'netbios',
      randomMac: false, online: true, firstSeen: env.clock.now(), lastSeen: env.clock.now(), ports: [{ port: 445, service: 'smb' }],
    });
    assert.equal(byMac['02:aa:bb:cc:dd:ee'].randomMac, true);
    assert.equal(byMac['02:aa:bb:cc:dd:ee'].hostname, 'Galaxy-A54');
    assert.equal(byMac['02:aa:bb:cc:dd:ee'].nameSource, 'mdns');
    assert.equal(byMac['a8:23:fe:44:55:66'].hostname, 'tv-wohnzimmer');
    assert.equal(byMac['a8:23:fe:44:55:66'].nameSource, 'dns');
    assert.equal(portCalls.length, 1);
    assert.deepEqual(portCalls[0].ips.sort(), ['192.168.1.10', '192.168.1.20', '192.168.1.30']);
    assert.equal(portCalls[0].opts.tunnelIp, '10.8.0.5');
    const t = nw.telemetry();
    assert.equal(t.enabled, true);
    assert.equal(t.devices, 3);
    assert.equal(t.online, 3);
    assert.equal(t.lastError, null);
  });

  it('later runs: deltas only, no port re-scan, offline transition, full again after 30 min', async () => {
    const { nw, posts, portCalls, env } = setup({
      online: new Map([['192.168.1.10', '00:11:32:aa:bb:01'], ['192.168.1.20', '02:aa:bb:cc:dd:ee']]),
    });
    nw.apply({ enabled: true, portscan: true });
    nw.loop.stop();
    await nw.run();
    env.clock.advance(5 * MIN);
    await nw.run();
    assert.equal(posts[1].body.full, false);
    assert.deepEqual(posts[1].body.devices, []); // nur lastSeen geändert → keine Änderung
    env.online = new Map([['192.168.1.10', '00:11:32:aa:bb:01']]);
    env.clock.advance(5 * MIN);
    await nw.run();
    assert.equal(posts[2].body.full, false);
    assert.deepEqual(posts[2].body.devices.map((d) => [d.mac, d.online]), [['02:aa:bb:cc:dd:ee', false]]);
    assert.equal(portCalls.length, 1);
    env.clock.advance(20 * MIN);
    await nw.run();
    assert.equal(posts[3].body.full, true);
    assert.equal(posts[3].body.devices.length, 2);
  });

  it('failed report → next report is full; run is marked failed', async () => {
    const { nw, posts, env } = setup({ online: new Map([['192.168.1.10', '00:11:32:aa:bb:01']]) });
    nw.apply({ enabled: true, portscan: false });
    nw.loop.stop();
    await nw.run();
    env.postOk = false;
    env.clock.advance(5 * MIN);
    assert.equal(await nw.run(), false);
    assert.match(nw.telemetry().lastError.message, /HTTP 502/);
    env.postOk = true;
    env.clock.advance(5 * MIN);
    await nw.run();
    assert.equal(posts[2].body.full, true);
    assert.equal(nw.telemetry().lastError, null);
  });

  it('portscan off: ports stay null; turned on later: unscanned devices get scanned', async () => {
    const { nw, posts, portCalls } = setup({ online: new Map([['192.168.1.10', '00:11:32:aa:bb:01']]) });
    nw.apply({ enabled: true, portscan: false });
    nw.loop.stop();
    await nw.run();
    assert.equal(posts[0].body.devices[0].ports, null);
    assert.equal(portCalls.length, 0);
    nw.apply({ enabled: true, portscan: true });
    await nw.run();
    assert.equal(portCalls.length, 1);
    assert.deepEqual(posts[1].body.devices[0].ports, []);
  });

  it('nightly scan of all online devices once the scheduled time has passed', async () => {
    const { nw, portCalls, env } = setup({ online: new Map([['192.168.1.10', '00:11:32:aa:bb:01']]) });
    nw.apply({ enabled: true, portscan: true });
    nw.loop.stop();
    await nw.run();
    assert.equal(portCalls.length, 1);
    const next = nw.telemetry().nextPortscanAt;
    assert.ok(next > env.clock.now());
    const h = new Date(next).getHours();
    assert.ok(h >= 2 && h < 5);
    env.clock.advance(next - env.clock.now() + 1000);
    await nw.run();
    assert.equal(portCalls.length, 2);
    assert.equal(nw.telemetry().lastPortscanAt, env.clock.now());
    assert.ok(nw.telemetry().nextPortscanAt > next);
  });

  it('firstSeen survives a restart (state file), forget after 30 days', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-'));
    const a = setup({ stateDir, online: new Map([['192.168.1.10', '00:11:32:aa:bb:01']]) });
    a.nw.apply({ enabled: true, portscan: false });
    a.nw.loop.stop();
    await a.nw.run();
    const first = a.posts[0].body.devices[0].firstSeen;
    a.nw.stop();
    const b = setup({ stateDir, online: new Map() });
    b.env.clock.advance(3 * 24 * 60 * MIN);
    b.nw.apply({ enabled: true, portscan: false });
    b.nw.loop.stop();
    await b.nw.run();
    assert.equal(b.posts[0].body.devices[0].firstSeen, first);
    assert.equal(b.posts[0].body.devices[0].online, false);
    b.env.clock.advance(31 * 24 * 60 * MIN);
    await b.nw.run();
    assert.equal(b.posts[1].body.devices.length, 0);
  });

  it('manual scan: accepted/busy/disabled', async () => {
    const { nw } = setup({ online: new Map() });
    assert.equal(nw.requestScan(), 'disabled');
    nw.apply({ enabled: true, portscan: true });
    nw.loop.stop();
    assert.equal(nw.requestScan({ ports: true }), 'accepted');
    assert.equal(nw.requestScan(), 'busy');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(nw.requestScan(), 'accepted');
  });
});
