'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Aggregator, OutageDetector } = require('../src/inetq/aggregate');

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const S = 1000;
const m = (at, o = {}) => ({ at, rttRouterMs: 2, rttInetMs: 14, rttServerMs: 30, sent: 10, received: 10, ...o });

describe('Aggregator (5-min values)', () => {
  it('closes a bucket when a measurement falls into the next one', () => {
    const a = new Aggregator();
    assert.equal(a.add(m(T0 + 5 * S)), null);
    assert.equal(a.add(m(T0 + 65 * S, { rttInetMs: 16, received: 9 })), null);
    assert.equal(a.add(m(T0 + 125 * S, { rttRouterMs: null, rttInetMs: null, received: 0, rttServerMs: null })), null);
    const closed = a.add(m(T0 + 301 * S));
    assert.deepEqual(closed, { t: T0, rttRouterMs: 2, rttInetMs: 15, lossInetPct: 36.7, rttServerMs: 30, n: 3 });
  });

  it('all-null bucket and flush after the interval without measurements', () => {
    const a = new Aggregator();
    a.add({ at: T0 + 10 * S, rttRouterMs: null, rttInetMs: null, rttServerMs: null, sent: 0, received: 0 });
    assert.equal(a.flush(T0 + 299 * S), null);
    assert.deepEqual(a.flush(T0 + 300 * S), { t: T0, rttRouterMs: null, rttInetMs: null, lossInetPct: null, rttServerMs: null, n: 1 });
    assert.equal(a.flush(T0 + 900 * S), null);
  });

  it('buckets are clock-aligned', () => {
    const a = new Aggregator();
    a.add(m(T0 + 299 * S));
    assert.equal(a.add(m(T0 + 300 * S)).t, T0);
  });
});

describe('OutageDetector', () => {
  const down = (at, routerOk = true) => ({ at, inetOk: false, routerOk });
  const up = (at) => ({ at, inetOk: true, routerOk: true });

  it('a blip under 60 s is not an outage', () => {
    const d = new OutageDetector();
    assert.equal(d.observe(down(T0)), null);
    assert.equal(d.active, true);
    assert.equal(d.observe(down(T0 + 50 * S)), null);
    assert.equal(d.observe(up(T0 + 59 * S)), null);
    assert.equal(d.active, false);
  });

  it('≥ 60 s without public targets → outage (isp), end on first success', () => {
    const d = new OutageDetector();
    d.observe(down(T0));
    d.observe(down(T0 + 30 * S));
    assert.deepEqual(d.observe(down(T0 + 60 * S)), { start: T0, end: null, cause: 'isp' });
    assert.equal(d.observe(down(T0 + 70 * S)), null);
    assert.deepEqual(d.observe(up(T0 + 420 * S)), { start: T0, end: T0 + 420 * S, cause: 'isp' });
    assert.equal(d.active, false);
  });

  it('router unreachable at any time → cause router (also when it happens later)', () => {
    const d = new OutageDetector();
    d.observe(down(T0, false));
    assert.deepEqual(d.observe(down(T0 + 60 * S)), { start: T0, end: null, cause: 'router' });
    const e = new OutageDetector();
    e.observe(down(T0));
    e.observe(down(T0 + 60 * S));
    assert.deepEqual(e.observe(down(T0 + 70 * S, false)), { start: T0, end: null, cause: 'router' });
    assert.deepEqual(e.observe(up(T0 + 80 * S)), { start: T0, end: T0 + 80 * S, cause: 'router' });
  });

  it('router unknown (no default route) is not counted as down', () => {
    const d = new OutageDetector();
    d.observe({ at: T0, inetOk: false, routerOk: null });
    assert.equal(d.observe({ at: T0 + 60 * S, inetOk: false, routerOk: null }).cause, 'isp');
  });

  it('restored open outage after restart: closes at the last down observation if the gap is long', () => {
    const d = new OutageDetector({ open: { start: T0, cause: 'isp', lastDownAt: T0 + 120 * S } });
    assert.equal(d.active, true);
    assert.deepEqual(d.observe(up(T0 + 3600 * S)), { start: T0, end: T0 + 120 * S, cause: 'isp' });
    const e = new OutageDetector({ open: { start: T0, cause: 'router', lastDownAt: T0 + 120 * S } });
    assert.deepEqual(e.observe(up(T0 + 180 * S)), { start: T0, end: T0 + 180 * S, cause: 'router' });
  });
});
