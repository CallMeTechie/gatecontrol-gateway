'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InetQuality, serverTarget, REPORT_PATH } = require('../src/inetq/inetq');

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const flush = () => new Promise((r) => setTimeout(r, 5));

function setup({ stateDir, postOk = true, speedtest } = {}) {
  let t = T0 + 10_000;
  const env = { inetOk: true, routerOk: true, postOk };
  const posts = [];
  const q = new InetQuality({
    reporter: { post: async (p, body) => { posts.push({ p, body: JSON.parse(JSON.stringify(body)) }); return env.postOk ? { ok: true } : { ok: false, error: 'ENETUNREACH' }; } },
    serverUrl: 'https://gc.example.com', apiToken: 'tok',
    stateDir: stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'iq-')),
    routerIp: () => '192.168.1.1',
    measure: async ({ now, targets, server }) => {
      assert.deepEqual(server, { host: 'gc.example.com', port: 443 });
      const ok = env.inetOk;
      return { at: now(), routerOk: env.routerOk, rttRouterMs: env.routerOk ? 2 : null, inetOk: ok, rttInetMs: ok ? 14 : null, sent: 5 * targets.length, received: ok ? 5 * targets.length : 0, rttServerMs: ok ? 30 : null };
    },
    pinger: { mode: () => 'icmp' },
    speedtest: speedtest || (async ({ now }) => ({ at: now(), downMbps: 250, upMbps: 45, bytes: 123, streams: 4 })),
    now: () => t,
    rand: () => 0.5,
  });
  return { q, posts, env, advance: (ms) => { t += ms; }, now: () => t };
}

describe('InetQuality', () => {
  it('serverTarget', () => {
    assert.deepEqual(serverTarget('https://gc.example.com'), { host: 'gc.example.com', port: 443 });
    assert.deepEqual(serverTarget('http://10.0.0.1:3000/x'), { host: '10.0.0.1', port: 3000 });
    assert.equal(serverTarget('::'), null);
  });

  it('every minute measures; a closed 5-min bucket is reported', async () => {
    const { q, posts, advance } = setup();
    q.apply({ enabled: true, speedtest: 'off', targets: ['1.1.1.1', '9.9.9.9'] });
    q.loop.stop();
    for (let i = 0; i < 6; i++) { await q.tick(); advance(MIN); }
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].p, REPORT_PATH);
    assert.deepEqual(posts[0].body.samples, [{ t: T0, rttRouterMs: 2, rttInetMs: 14, lossInetPct: 0, rttServerMs: 30, n: 5 }]);
    assert.deepEqual(posts[0].body.outages, []);
    assert.equal(q.telemetry().buffered.samples, 0);
    assert.equal(q.telemetry().now.rttInetMs, 14);
    assert.equal(q.telemetry().now.lossInetPct, 0);
  });

  it('outage: buffered while the server is unreachable, survives a restart, sent afterwards', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-'));
    const a = setup({ stateDir, postOk: false });
    a.q.apply({ enabled: true, speedtest: 'off', targets: ['1.1.1.1'] });
    a.q.loop.stop();
    await a.q.tick();
    a.env.inetOk = false;
    for (let i = 0; i < 12; i++) { a.advance(MIN); await a.q.tick(); await flush(); } // 12 Min. kein Internet
    const tel = a.q.telemetry();
    assert.equal(tel.outage.cause, 'isp');
    assert.ok(tel.buffered.samples >= 2);
    assert.ok(tel.reportError);
    a.q.stop();

    // Neustart: neuer Prozess liest den Puffer, Internet wieder da, Server erreichbar
    const b = setup({ stateDir, postOk: true });
    b.advance(13 * MIN);
    b.q.apply({ enabled: true, speedtest: 'off', targets: ['1.1.1.1'] });
    b.q.loop.stop();
    assert.equal(b.q.telemetry().outage.cause, 'isp');
    await b.q.tick();
    await flush();
    const body = b.posts.at(-1).body;
    assert.ok(body.samples.length >= 2, JSON.stringify(body));
    assert.equal(body.samples.some((s) => s.lossInetPct === 100), true);
    assert.deepEqual(body.outages.map((o) => [o.start, o.end !== null, o.cause]).at(-1), [T0 + 10_000 + MIN, true, 'isp']);
    assert.equal(b.q.telemetry().outage, null);
    assert.deepEqual(b.q.telemetry().buffered, { samples: 0, outages: 0, speedtests: 0 });
  });

  it('router down during the outage → cause router; fast re-checks while suspect', async () => {
    const { q, env, advance } = setup();
    q.apply({ enabled: true, speedtest: 'off', targets: ['1.1.1.1'] });
    q.loop.stop();
    env.inetOk = false; env.routerOk = false;
    await q.tick();
    assert.equal(q.detector.active, true);
    advance(60_000);
    await q.tick();
    assert.equal(q.telemetry().outage.cause, 'router');
  });

  it('speedtest on schedule and on request; result reported; no measuring while running', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const { q, posts, advance, now } = setup({ speedtest: async ({ now: n }) => { calls++; await gate; return { at: n(), downMbps: 99.5, upMbps: 20, bytes: 1000, streams: 4 }; } });
    q.apply({ enabled: true, speedtest: '4x', targets: ['1.1.1.1'] });
    q.loop.stop();
    const next = q.telemetry().nextSpeedtestAt;
    assert.ok(next > now());
    assert.equal(new Date(next).getMinutes(), 30);
    assert.ok([0, 6, 12, 18].includes(new Date(next).getHours()));
    advance(next - now());
    await q.tick();
    assert.equal(calls, 1);
    assert.equal(q.requestSpeedtest(), 'busy');
    const before = q.last;
    advance(MIN);
    await q.tick();
    assert.equal(q.last, before); // keine Messung während des Tests
    release();
    await flush();
    assert.equal(q.telemetry().lastSpeedtest.downMbps, 99.5);
    const sent = posts.find((p) => p.body.speedtests.length);
    assert.deepEqual(sent.body.speedtests[0].downMbps, 99.5);
    assert.equal(q.requestSpeedtest(), 'accepted');
    await flush();
    assert.equal(calls, 2);
    q.apply({ enabled: false });
    assert.equal(q.requestSpeedtest(), 'disabled');
  });

  it('speed test budget: counted in the state dir, survives a restart, caps and blocks the next test', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-'));
    const seen = [];
    const run = async (o) => { seen.push({ maxDownBytes: o.maxDownBytes, maxUpBytes: o.maxUpBytes, maxTotalBytes: o.maxTotalBytes }); return { at: o.now(), downMbps: 300, upMbps: 40, bytes: 700_000_000, streams: 4 }; };
    const a = setup({ stateDir, speedtest: run });
    a.q.apply({ enabled: true, speedtest: 'off', targets: ['1.1.1.1'], speedVolume: { dayBytes: 1_000_000_000, downBytes: 200_000_000, upBytes: 150_000_000 } });
    a.q.loop.stop();
    assert.equal(a.q.requestSpeedtest(), 'accepted');
    await flush();
    assert.deepEqual(seen[0], { maxDownBytes: 200_000_000, maxUpBytes: 150_000_000, maxTotalBytes: 1_000_000_000 });
    assert.deepEqual(a.q.telemetry().speedBudget, { usedBytes: 700_000_000, limitBytes: 1_000_000_000, tests: 1, blockedUntil: null });
    a.q.stop();

    // Neustart: das Budget kommt aus /state/inetq-budget.json, der nächste Test bekommt nur den Rest
    const b = setup({ stateDir, speedtest: run });
    b.q.apply({ enabled: true, speedtest: 'off', targets: ['1.1.1.1'], speedVolume: { dayBytes: 1_000_000_000 } });
    b.q.loop.stop();
    assert.equal(b.q.telemetry().speedBudget.usedBytes, 700_000_000);
    assert.equal(b.q.requestSpeedtest(), 'accepted');
    await flush();
    assert.deepEqual(seen[1], { maxDownBytes: null, maxUpBytes: null, maxTotalBytes: 300_000_000 });

    // aufgebraucht: kein Test mehr, dem Server als abgelehnt gemeldet
    assert.equal(b.q.requestSpeedtest(), 'accepted');
    await flush();
    assert.equal(seen.length, 2);
    assert.equal(b.q.telemetry().lastSpeedtest.error, 'budget');
    assert.equal(b.q.telemetry().lastSpeedtest.bytes, 0);
    assert.ok(b.q.telemetry().speedBudget.blockedUntil > b.now());
    const sent = b.posts.filter((p) => p.body.speedtests.some((x) => x.error === 'budget'));
    assert.equal(sent.length, 1);
    // einen Tag später ist wieder Platz
    b.advance(25 * 3600_000);
    assert.equal(b.q.telemetry().speedBudget.usedBytes, 0);
    assert.equal(b.q.requestSpeedtest(), 'accepted');
    await flush();
    assert.equal(seen.length, 3);
  });

  it('speed test budget: without a limit from the server 12 GB a day; a refusal of the server pauses the tests', async () => {
    let n = 0;
    const { q, advance } = setup({ speedtest: async (o) => {
      n++;
      const r = { at: o.now(), downMbps: null, upMbps: null, bytes: 0, streams: 4, error: 'budget' };
      Object.defineProperty(r, 'refused', { value: { retryAfterS: 7200 }, enumerable: false });
      return r;
    } });
    q.apply({ enabled: true, speedtest: 'off', targets: ['1.1.1.1'] });
    q.loop.stop();
    assert.equal(q.telemetry().speedBudget.limitBytes, 12_000_000_000);
    q.requestSpeedtest();
    await flush();
    assert.equal(n, 1);
    q.requestSpeedtest();
    await flush();
    assert.equal(n, 1, 'no request while the server refuses');
    advance(2 * 3600_000 + 1000);
    q.requestSpeedtest();
    await flush();
    assert.equal(n, 2);
  });

  it('report batches at most 600 samples and keeps the rest', async () => {
    const { q, posts } = setup();
    q.apply({ enabled: true, speedtest: 'off', targets: ['1.1.1.1'] });
    q.loop.stop();
    for (let i = 0; i < 1300; i++) q._addSample({ t: T0 + i * 300_000, rttRouterMs: 1, rttInetMs: 2, lossInetPct: 0, rttServerMs: 3, n: 5 });
    await q.report();
    assert.deepEqual(posts.map((p) => p.body.samples.length), [600, 600, 100]);
    assert.equal(q.telemetry().buffered.samples, 0);
  });

  it('buffer is capped at 7 days of samples', () => {
    const { q } = setup();
    for (let i = 0; i < 2100; i++) q._addSample({ t: i });
    assert.equal(q.samples.length, 2016);
    assert.equal(q.samples[0].t, 84);
  });
});
