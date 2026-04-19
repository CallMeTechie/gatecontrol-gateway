'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Poller, computeBackoff } = require('../src/sync/poller');

describe('Poller', () => {
  it('computeBackoff follows exponential curve with cap', () => {
    assert.equal(computeBackoff(0, { baseMs: 5000, maxMs: 300000 }), 5000);
    assert.equal(computeBackoff(1, { baseMs: 5000, maxMs: 300000 }), 10000);
    assert.equal(computeBackoff(2, { baseMs: 5000, maxMs: 300000 }), 20000);
    // cap at 300000
    assert.equal(computeBackoff(20, { baseMs: 5000, maxMs: 300000 }), 300000);
  });

  it('Poller.triggerImmediate debounces rapid calls', async () => {
    let calls = 0;
    const p = new Poller({
      intervalMs: 999999,
      fetcher: async () => { calls++; return { changed: false }; },
      debounceMs: 50,
    });
    p.triggerImmediate();
    p.triggerImmediate();
    p.triggerImmediate();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(calls, 1);
  });

  it('Poller backs off after failures and recovers on success', async () => {
    let attempts = 0;
    const p = new Poller({
      intervalMs: 999999,
      fetcher: async () => {
        attempts++;
        if (attempts < 3) throw new Error('sim-fail');
        return { changed: true };
      },
      debounceMs: 0,
      baseMs: 5,
      maxMs: 100,
    });
    p.triggerImmediate();
    await new Promise(r => setTimeout(r, 500));
    assert.ok(attempts >= 3, `expected at least 3 attempts, got ${attempts}`);
    assert.equal(p.consecutiveFails, 0);
  });
});
