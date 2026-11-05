'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { runSpeedtest } = require('../src/inetq/speedtest');
const { startFakeServer } = require('./helpers/fakeGcServer');

describe('speedtest against a fake server', () => {
  let srv;
  before(async () => { srv = await startFakeServer(); });
  after(async () => { await srv.close(); });

  it('measures both directions with parallel streams and stops on time', async () => {
    const t0 = Date.now();
    const r = await runSpeedtest({
      serverUrl: srv.url, apiToken: srv.token, streams: 4, durationMs: 1200, warmupMs: 200,
      downBytes: 2_000_000, upBytes: 1_000_000, now: () => 123,
    });
    const took = Date.now() - t0;
    assert.equal(r.at, 123);
    assert.equal(r.streams, 4);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.ok(r.downMbps > 0, JSON.stringify(r));
    assert.ok(r.upMbps > 0, JSON.stringify(r));
    assert.ok(r.bytes > 0);
    assert.ok(srv.counters.maxActive >= 2 && srv.counters.maxActive <= 4, `maxActive ${srv.counters.maxActive}`);
    assert.ok(took < 4000, `took ${took} ms`);
    assert.equal(srv.counters.authFail, 0);
    assert.ok(srv.counters.up > 0);
  });

  it('server busy (429) → error code from the body, no Mbps', async () => {
    srv.status.speedtest = 429;
    try {
      const r = await runSpeedtest({ serverUrl: srv.url, apiToken: srv.token, durationMs: 500, warmupMs: 100 });
      assert.equal(r.downMbps, null);
      assert.equal(r.upMbps, null);
      assert.equal(r.error, 'busy');
    } finally {
      delete srv.status.speedtest;
    }
  });

  it('wrong token → error, no hang', async () => {
    const r = await runSpeedtest({ serverUrl: srv.url, apiToken: 'wrong', durationMs: 400, warmupMs: 100 });
    assert.equal(r.downMbps, null);
    assert.equal(r.error, 'unauthorized');
  });

  it('unreachable server → network error, no hang', async () => {
    const r = await runSpeedtest({ serverUrl: 'http://127.0.0.1:1', apiToken: 'x', durationMs: 400, warmupMs: 100 });
    assert.equal(r.downMbps, null);
    assert.equal(r.error, 'network');
  });
});
