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
    // gedrosselt (2 MB/s je Stream): eine Anfrage dauert so lange, dass sich die Streams sicher
    // überlappen – ungedrosselt war auf einem ausgelasteten Rechner jede fertig, bevor die nächste ankam
    const s1 = await startFakeServer({ streamBytesPerSec: 2_000_000 });
    try {
      const t0 = Date.now();
      const r = await runSpeedtest({
        serverUrl: s1.url, apiToken: s1.token, streams: 4, durationMs: 1200, warmupMs: 200,
        downBytes: 2_000_000, upBytes: 1_000_000, now: () => 123,
      });
      const took = Date.now() - t0;
      assert.equal(r.at, 123);
      assert.equal(r.streams, 4);
      assert.equal(r.error, undefined, JSON.stringify(r));
      assert.ok(r.downMbps > 0, JSON.stringify(r));
      assert.ok(r.upMbps > 0, JSON.stringify(r));
      assert.ok(r.bytes > 0);
      // je Richtung parallel; beim Wechsel zur nächsten Anfrage zählt der Server die alte kurz noch mit (≤ 2 × Streams)
      for (const k of ['maxActiveDown', 'maxActiveUp']) assert.ok(s1.counters[k] >= 2 && s1.counters[k] <= 8, `${k} ${s1.counters[k]}`);
      assert.ok(took < 4000, `took ${took} ms`);
      assert.equal(s1.counters.authFail, 0);
      assert.ok(s1.counters.up > 0);
    } finally {
      await s1.close();
    }
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

  it('volume caps: both directions end at their cap, before the time is up', async () => {
    const down0 = srv.counters.down;
    const up0 = srv.counters.up;
    const t0 = Date.now();
    // langsam genug, dass der Deckel erst nach der Anlaufzeit erreicht ist (4 Streams × 500 kB/s)
    const slow = await startFakeServer({ streamBytesPerSec: 500_000 });
    try {
      const r = await runSpeedtest({
        serverUrl: slow.url, apiToken: slow.token, streams: 4, durationMs: 8000, warmupMs: 200,
        downBytes: 400_000, upBytes: 300_000, maxDownBytes: 2_000_000, maxUpBytes: 1_500_000,
      });
      const took = Date.now() - t0;
      assert.equal(r.limited, true, JSON.stringify(r));
      assert.equal(r.error, undefined, JSON.stringify(r));
      assert.equal(slow.counters.down, 2_000_000);
      assert.equal(slow.counters.up, 1_500_000);
      assert.equal(r.bytes, 3_500_000);
      assert.ok(r.downMbps > 0 && r.upMbps > 0, JSON.stringify(r));
      assert.ok(took < 8000, `both directions would take 16 s without the caps, took ${took} ms`);
    } finally {
      await slow.close();
    }
    assert.equal(srv.counters.down, down0);
    assert.equal(srv.counters.up, up0);
  });

  it('maxTotalBytes: download takes at most half, upload what is left', async () => {
    const slow = await startFakeServer({ streamBytesPerSec: 500_000 });
    try {
      const r = await runSpeedtest({
        serverUrl: slow.url, apiToken: slow.token, streams: 2, durationMs: 8000, warmupMs: 100,
        downBytes: 250_000, upBytes: 250_000, maxTotalBytes: 2_000_000, maxUpBytes: 600_000,
      });
      assert.equal(slow.counters.down, 1_000_000);
      assert.equal(slow.counters.up, 600_000); // der kleinere der beiden Deckel
      assert.equal(r.limited, true);
    } finally {
      await slow.close();
    }
  });

  it('without caps nothing changes: no `limited`, requests of the usual size', async () => {
    const r = await runSpeedtest({ serverUrl: srv.url, apiToken: srv.token, streams: 2, durationMs: 2000, warmupMs: 200, downBytes: 500_000, upBytes: 500_000 });
    assert.equal(r.limited, undefined);
    assert.equal(r.refused, undefined);
    assert.deepEqual(Object.keys(r).sort(), ['at', 'bytes', 'downMbps', 'streams', 'upMbps']);
  });

  it('refused for the daily volume (429 budget): error and Retry-After, not part of the report', async () => {
    Object.assign(srv.status, { speedtest: 429, speedtestError: 'budget', speedtestRetryAfter: 1800 });
    try {
      const r = await runSpeedtest({ serverUrl: srv.url, apiToken: srv.token, durationMs: 500, warmupMs: 100 });
      assert.equal(r.error, 'budget');
      assert.deepEqual(r.refused, { retryAfterS: 1800 });
      assert.equal(JSON.parse(JSON.stringify(r)).refused, undefined);
    } finally {
      for (const k of ['speedtest', 'speedtestError', 'speedtestRetryAfter']) delete srv.status[k];
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
