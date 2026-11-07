'use strict';

// Ende-zu-Ende (ohne echtes Netz): Funktionsschalter → Netzwerk-Wächter,
// Anwesenheit, Internetqualität inkl. Speedtest und USV gegen gefälschten
// GateControl-Server und gefälschten NUT-Server. Echte Berichts-HTTP-Aufrufe,
// echter Speedtest-Client, echtes NUT-Protokoll; nur Scanner/Ping sind ersetzt.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { FeatureManager } = require('../../src/features/manager');
const { makeReporter } = require('../../src/features/reporter');
const { NetWatch } = require('../../src/netwatch/netwatch');
const { makeOuiLookup } = require('../../src/netwatch/oui');
const { Presence } = require('../../src/presence/presence');
const { InetQuality } = require('../../src/inetq/inetq');
const { runSpeedtest } = require('../../src/inetq/speedtest');
const { UpsMonitor, queryUps } = require('../../src/ups/nut');
const { startFakeServer } = require('../helpers/fakeGcServer');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(20); }
  throw new Error('timeout waiting for condition');
}

describe('integration: Phase-3a features against a fake server', () => {
  let srv;
  let nut;
  let mgr;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3a-'));

  before(async () => {
    srv = await startFakeServer();
    nut = net.createServer((sock) => {
      sock.on('data', (c) => {
        for (const line of String(c).split('\n').filter(Boolean)) {
          if (line === 'LIST UPS') sock.write('BEGIN LIST UPS\nUPS nas "Synology"\nEND LIST UPS\n');
          else if (line === 'LIST VAR nas') sock.write('BEGIN LIST VAR nas\nVAR nas ups.status "OL"\nVAR nas battery.charge "100"\nVAR nas battery.runtime "2520"\nVAR nas device.model "Back-UPS 700"\nEND LIST VAR nas\n');
          else if (line === 'LOGOUT') sock.end();
        }
      });
    });
    await new Promise((r) => nut.listen(0, '127.0.0.1', r));

    const reporter = makeReporter({ serverUrl: srv.url, apiToken: srv.token });
    const scanner = {
      sweep: async () => ({ online: new Map([['192.168.1.10', '00:11:32:aa:bb:01'], ['192.168.1.50', 'da:a1:19:00:00:01']]), names: new Map([['192.168.1.50', 'Marcs-iPhone']]) }),
      probe: async () => ({ online: new Map(), names: new Map(), responders: new Set() }),
      readNeighbors: async () => [{ ip: '192.168.1.50', mac: 'da:a1:19:00:00:01', state: 'REACHABLE' }],
      netbiosNames: async () => new Map(),
      mode: () => 'ip',
    };
    const netwatch = new NetWatch({
      scanner, oui: makeOuiLookup(), reporter, stateDir, tunnelIp: '10.8.0.9',
      getSubnets: () => [{ cidr: '192.168.1.0/24', localIp: '192.168.1.2' }],
      reverseDns: async () => null,
      portScanner: async (ips) => new Map(ips.map((ip) => [ip, ip === '192.168.1.10' ? [{ port: 5001, service: null }] : []])),
      ownIps: () => ['192.168.1.2'],
      firstRunMs: 60_000,
    });
    const presence = new Presence({ scanner, reporter, knownIp: (m) => netwatch.knownIp(m), ownSweep: () => false });
    const inetq = new InetQuality({
      reporter, serverUrl: srv.url, apiToken: srv.token, stateDir,
      measure: async ({ now }) => ({ at: now(), routerOk: true, rttRouterMs: 2, inetOk: true, rttInetMs: 14, sent: 10, received: 10, rttServerMs: 20 }),
      pinger: { mode: () => 'icmp' },
      speedtest: (o) => runSpeedtest({ ...o, durationMs: 800, warmupMs: 200, downBytes: 1_000_000, upBytes: 500_000 }),
    });
    const ups = new UpsMonitor({
      query: (o) => queryUps({ ...o, connect: () => net.createConnection({ host: '127.0.0.1', port: nut.address().port }) }),
    });
    mgr = new FeatureManager({ netwatch, inetq, presence, ups });
  });

  after(async () => {
    mgr.stop();
    nut.close();
    await srv.close();
  });

  it('old server (no features): everything off, telemetry says so', () => {
    mgr.apply(undefined);
    const t = mgr.telemetry();
    assert.deepEqual(t.capabilities, ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'storage', 'timezone', 'print', 'print-convert', 'radio', 'radio-stacks', 'ai', 'cameras']);
    for (const k of ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache']) assert.equal(t.features[k].enabled, false, k);
    assert.equal(t.ups, null);
    assert.equal(t.dns, null);
    assert.equal(t.cache, null);
    assert.ok(t.process_mem.rss > 0);
    assert.equal(mgr.netwatch.requestScan(), 'disabled');
  });

  it('features on → reports arrive at the server', async () => {
    mgr.apply({
      netwatch: { enabled: true, portscan: true },
      inetq: { enabled: true, speedtest: 'off' },
      presence: { enabled: true, macs: ['DA:A1:19:00:00:01'] },
      ups: { enabled: true, host: '192.168.1.10', port: 3493, name: null },
    });
    for (const x of [mgr.netwatch, mgr.inetq, mgr.presence, mgr.ups]) x.loop.stop();

    assert.equal(mgr.netwatch.requestScan(), 'accepted');
    await until(() => srv.posts.some((p) => p.path === '/api/v1/gateway/netwatch'));
    const nw = srv.posts.find((p) => p.path === '/api/v1/gateway/netwatch').body;
    assert.equal(nw.full, true);
    const nas = nw.devices.find((d) => d.mac === '00:11:32:aa:bb:01');
    assert.equal(nas.vendor, 'Synology');
    assert.deepEqual(nas.ports, [{ port: 5001, service: null }]);
    const phone = nw.devices.find((d) => d.mac === 'da:a1:19:00:00:01');
    assert.equal(phone.randomMac, true);
    assert.equal(phone.hostname, 'Marcs-iPhone');

    await mgr.presence.tick();
    const pr = srv.posts.find((p) => p.path === '/api/v1/gateway/presence').body;
    assert.equal(pr.events.length, 1);
    assert.equal(pr.events[0].mac, 'da:a1:19:00:00:01');
    assert.equal(pr.events[0].online, true);

    await mgr.ups.tick();
    assert.equal(mgr.telemetry().ups.status, 'OL');
    assert.equal(mgr.telemetry().ups.runtimeSec, 2520);

    await mgr.inetq.tick();
    assert.equal(mgr.inetq.requestSpeedtest(), 'accepted');
    await until(() => srv.posts.some((p) => p.path === '/api/v1/gateway/inetq' && p.body.speedtests.length));
    const iq = srv.posts.find((p) => p.path === '/api/v1/gateway/inetq' && p.body.speedtests.length).body;
    assert.ok(iq.speedtests[0].downMbps > 0, JSON.stringify(iq.speedtests[0]));
    assert.ok(iq.speedtests[0].upMbps > 0, JSON.stringify(iq.speedtests[0]));

    const t = mgr.telemetry();
    assert.equal(t.features.netwatch.devices, 2);
    assert.equal(t.features.presence.home, 1);
    assert.equal(t.features.inetq.lastSpeedtest.streams, 4);
    assert.equal(t.features.ups.lastError, null);
    // Telemetrie bleibt JSON-tauglich und klein
    assert.ok(JSON.stringify(t).length < 4096);
  });

  it('features off again → everything stops, ups telemetry null', () => {
    mgr.apply({ netwatch: { enabled: false }, inetq: { enabled: false }, presence: { enabled: false }, ups: { enabled: false } });
    const t = mgr.telemetry();
    for (const k of ['netwatch', 'inetq', 'presence', 'ups']) assert.equal(t.features[k].enabled, false, k);
    assert.equal(t.ups, null);
    assert.ok(fs.existsSync(path.join(stateDir, 'netwatch.json')));
  });
});
