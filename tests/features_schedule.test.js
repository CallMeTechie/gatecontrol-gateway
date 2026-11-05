'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { nextNightly, nextSpeedtest } = require('../src/features/schedule');

const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

describe('nextNightly (port scan 02:00–05:00 local)', () => {
  it('today when the random time is still ahead, else tomorrow', () => {
    const t1 = nextNightly(local(2026, 11, 5, 1, 0), () => 0.5); // Minute 90 → 03:30
    assert.equal(t1, local(2026, 11, 5, 3, 30));
    const t2 = nextNightly(local(2026, 11, 5, 4, 0), () => 0.5);
    assert.equal(t2, local(2026, 11, 6, 3, 30));
  });

  it('always inside the window', () => {
    for (let i = 0; i < 200; i++) {
      const r = Math.random();
      const d = new Date(nextNightly(local(2026, 11, 5, 12, 0), () => r));
      assert.ok(d.getHours() >= 2 && d.getHours() < 5, d.toString());
    }
  });
});

describe('nextSpeedtest', () => {
  it("'4x' = 00/06/12/18 h + random minute", () => {
    assert.equal(nextSpeedtest('4x', local(2026, 11, 5, 7, 0), () => 0.25), local(2026, 11, 5, 12, 15));
    assert.equal(nextSpeedtest('4x', local(2026, 11, 5, 18, 30), () => 0.25), local(2026, 11, 6, 0, 15));
    assert.equal(nextSpeedtest('4x', local(2026, 11, 5, 5, 59), () => 0), local(2026, 11, 5, 6, 0));
  });

  it("'hourly' = next hour slot with random minute", () => {
    assert.equal(nextSpeedtest('hourly', local(2026, 11, 5, 7, 10), () => 0.5), local(2026, 11, 5, 7, 30));
    assert.equal(nextSpeedtest('hourly', local(2026, 11, 5, 7, 40), () => 0.5), local(2026, 11, 5, 8, 30));
  });

  it("'off' and unknown plans → null", () => {
    assert.equal(nextSpeedtest('off', Date.now()), null);
    assert.equal(nextSpeedtest('weekly', Date.now()), null);
  });
});
