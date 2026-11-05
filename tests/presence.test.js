'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Presence, REPORT_PATH } = require('../src/presence/presence');

const MIN = 60_000;
const PHONE = 'da:a1:19:00:00:01';
const TABLET = '02:00:00:00:00:02';

function setup({ neigh = [], probeOnline = new Map(), sweepOnline = new Map(), postOk = true, knownIp = () => null, ownSweep = () => true } = {}) {
  let t = 1_000_000_000_000;
  const posts = [];
  const calls = { probe: [], sweep: 0 };
  const env = { neigh, probeOnline, sweepOnline, postOk };
  const p = new Presence({
    scanner: {
      readNeighbors: async () => env.neigh,
      probe: async (ips) => { calls.probe.push(ips); return { online: new Map([...env.probeOnline].filter(([ip]) => ips.includes(ip))), names: new Map(), responders: new Set() }; },
      sweep: async () => { calls.sweep++; return { online: env.sweepOnline, names: new Map() }; },
    },
    reporter: { post: async (path, body) => { posts.push({ path, body: JSON.parse(JSON.stringify(body)) }); return env.postOk ? { ok: true } : { ok: false, status: 503 }; } },
    knownIp, ownSweep,
    getSubnets: () => [{ cidr: '192.168.1.0/24', localIp: '192.168.1.2' }],
    now: () => t,
  });
  return { p, posts, calls, env, advance: (ms) => { t += ms; }, now: () => t };
}

describe('Presence hysteresis', () => {
  it('online at once, offline only after awayAfterSec without a sign of life', () => {
    const { p, advance, now } = setup();
    p.apply({ enabled: true, macs: [PHONE], awayAfterSec: 600 });
    p.loop.stop();
    let ev = p.transitions(new Set([PHONE]), now());
    assert.deepEqual(ev, [{ mac: PHONE, online: true, at: now(), lastSeen: now() }]);
    const seenAt = now();
    advance(MIN);
    assert.deepEqual(p.transitions(new Set([PHONE]), now()), []); // keine Wiederholung
    const lastSeen = now();
    for (let i = 1; i < 10; i++) { advance(MIN); assert.deepEqual(p.transitions(new Set(), now()), [], `minute ${i}`); }
    advance(MIN);
    ev = p.transitions(new Set(), now());
    assert.deepEqual(ev, [{ mac: PHONE, online: false, at: now(), lastSeen }]);
    assert.ok(seenAt < lastSeen);
    advance(MIN);
    assert.deepEqual(p.transitions(new Set(), now()), []);
    assert.equal(p.transitions(new Set([PHONE]), now())[0].online, true);
  });

  it('short gaps (phone asleep) do not produce events', () => {
    const { p, advance, now } = setup();
    p.apply({ enabled: true, macs: [PHONE], awayAfterSec: 600 });
    p.loop.stop();
    p.transitions(new Set([PHONE]), now());
    let events = 0;
    for (let i = 0; i < 60; i++) {
      advance(MIN);
      events += p.transitions(i % 8 === 7 ? new Set([PHONE]) : new Set(), now()).length;
    }
    assert.equal(events, 0);
  });

  it('never seen since start → offline after awayAfterSec (counted from start)', () => {
    const { p, advance, now } = setup();
    p.apply({ enabled: true, macs: [PHONE], awayAfterSec: 120 });
    p.loop.stop();
    advance(MIN);
    assert.deepEqual(p.transitions(new Set(), now()), []);
    advance(MIN);
    assert.deepEqual(p.transitions(new Set(), now()), [{ mac: PHONE, online: false, at: now(), lastSeen: null }]);
  });

  it('removed MACs are forgotten without an event', () => {
    const { p, now } = setup();
    p.apply({ enabled: true, macs: [PHONE, TABLET], awayAfterSec: 600 });
    p.loop.stop();
    p.transitions(new Set([PHONE, TABLET]), now());
    p.apply({ enabled: true, macs: [PHONE], awayAfterSec: 600 });
    assert.equal(p.telemetry().tracked, 1);
    assert.equal(p.telemetry().home, 1);
  });
});

describe('Presence detection + reporting', () => {
  it('REACHABLE neighbour counts directly; otherwise probe the known IP', async () => {
    const { p, posts, calls } = setup({
      neigh: [{ ip: '192.168.1.50', mac: PHONE, state: 'REACHABLE' }, { ip: '192.168.1.51', mac: TABLET, state: 'STALE' }],
      probeOnline: new Map([['192.168.1.51', TABLET]]),
    });
    p.apply({ enabled: true, macs: [PHONE, TABLET], awayAfterSec: 600 });
    p.loop.stop();
    await p.tick();
    assert.deepEqual(calls.probe, [['192.168.1.51']]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, REPORT_PATH);
    assert.deepEqual(posts[0].body.events.map((e) => [e.mac, e.online]).sort(), [[TABLET, true], [PHONE, true]].sort());
    assert.equal(calls.sweep, 0);
  });

  it('unknown IP: sweep at most every 10 min, not when the network watch sweeps anyway', async () => {
    const a = setup({ sweepOnline: new Map([['192.168.1.77', PHONE]]) });
    a.p.apply({ enabled: true, macs: [PHONE], awayAfterSec: 600 });
    a.p.loop.stop();
    await a.p.tick();
    assert.equal(a.calls.sweep, 1);
    assert.equal(a.posts[0].body.events[0].online, true);
    a.env.sweepOnline = new Map();
    a.advance(MIN);
    await a.p.tick();
    assert.deepEqual(a.calls.probe.at(-1), ['192.168.1.77']); // gemerkte IP wird gezielt geprüft
    assert.equal(a.calls.sweep, 1);
    a.advance(10 * MIN);
    await a.p.tick();
    assert.equal(a.calls.sweep, 2);

    const b = setup({ ownSweep: () => false, knownIp: (m) => (m === PHONE ? '192.168.1.80' : null) });
    b.p.apply({ enabled: true, macs: [PHONE], awayAfterSec: 600 });
    b.p.loop.stop();
    await b.p.tick();
    assert.equal(b.calls.sweep, 0);
    assert.deepEqual(b.calls.probe, [['192.168.1.80']]);
  });

  it('undeliverable events are kept and sent with the next run', async () => {
    const { p, posts, env, advance } = setup({ neigh: [{ ip: '192.168.1.50', mac: PHONE, state: 'REACHABLE' }], postOk: false });
    p.apply({ enabled: true, macs: [PHONE], awayAfterSec: 600 });
    p.loop.stop();
    await p.tick();
    assert.equal(p.telemetry().pending, 1);
    assert.match(p.telemetry().lastError.message, /503/);
    env.postOk = true;
    advance(MIN);
    await p.tick();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body.events.map((e) => e.online), [true]);
    assert.equal(p.telemetry().pending, 0);
    advance(MIN);
    await p.tick();
    assert.equal(posts.length, 2); // nichts Neues → kein Bericht
  });

  it('disabled → no checks, queue dropped', async () => {
    const { p, calls, posts } = setup({ neigh: [{ ip: '192.168.1.50', mac: PHONE, state: 'REACHABLE' }] });
    p.apply({ enabled: false, macs: [PHONE] });
    await p.tick();
    assert.equal(calls.probe.length, 0);
    assert.equal(posts.length, 0);
    assert.equal(p.telemetry().enabled, false);
  });
});
