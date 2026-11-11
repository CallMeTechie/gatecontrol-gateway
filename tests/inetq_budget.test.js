'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SpeedBudget, DEFAULT_DAY_BYTES, MIN_TEST_BYTES, STATE_FILE } = require('../src/inetq/budget');

const HOUR = 3600_000;
const T0 = Date.UTC(2026, 10, 5, 12, 20, 0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iq-budget-'));

function setup(stateDir = tmp()) {
  let t = T0;
  const b = new SpeedBudget({ stateDir, now: () => t });
  return { b, stateDir, at: (ms) => { t = ms; }, advance: (ms) => { t += ms; } };
}

describe('speed test budget (state dir)', () => {
  it('counts the volume and the tests of the last 24 hours', () => {
    const { b, advance } = setup();
    assert.equal(b.usedBytes(), 0);
    b.record(700_000_000);
    advance(2 * HOUR);
    b.record(300_000_000);
    assert.equal(b.usedBytes(), 1_000_000_000);
    assert.equal(b.tests(), 2);
    assert.equal(b.remaining(), DEFAULT_DAY_BYTES - 1_000_000_000);
    advance(22 * HOUR); // das erste Stundenfach ist älter als 24 h
    assert.equal(b.usedBytes(), 300_000_000);
    assert.equal(b.tests(), 1);
    advance(3 * HOUR);
    assert.equal(b.usedBytes(), 0);
  });

  it('survives a restart: a new instance reads the file in the state dir', () => {
    const a = setup();
    a.b.record(5_000_000_000);
    a.b.refused(T0 + 3 * HOUR);
    assert.ok(fs.existsSync(path.join(a.stateDir, STATE_FILE)));
    const n = setup(a.stateDir);
    assert.equal(n.b.usedBytes(), 5_000_000_000);
    assert.equal(n.b.tests(), 1);
    assert.equal(n.b.blockedUntil(), T0 + 3 * HOUR);
    assert.deepEqual(n.b.snapshot(8_000_000_000), { usedBytes: 5_000_000_000, limitBytes: 8_000_000_000, tests: 1, blockedUntil: T0 + 3 * HOUR });
  });

  it('used up: blocked until the oldest hour leaves the window', () => {
    const { b, advance } = setup();
    const limit = 1_000_000_000;
    b.record(600_000_000);
    assert.equal(b.blockedUntil(limit), null);
    advance(3 * HOUR);
    b.record(400_000_000 - MIN_TEST_BYTES + 1);
    // erst wenn die 600 MB von 12 Uhr aus dem Fenster sind, passt wieder ein Test
    assert.equal(b.blockedUntil(limit), Date.UTC(2026, 10, 6, 12, 0, 0));
    advance(21 * HOUR);
    assert.equal(b.blockedUntil(limit), null);
  });

  it('the refusal of the server holds for an hour without a time, never longer than a day', () => {
    const { b, advance } = setup();
    b.refused(null);
    assert.equal(b.blockedUntil(), T0 + HOUR);
    advance(HOUR);
    assert.equal(b.blockedUntil(), null);
    b.refused(T0 + 900 * HOUR);
    assert.equal(b.blockedUntil(), T0 + HOUR + 24 * HOUR);
  });

  it('a broken or foreign file counts as empty; slots from the future are dropped', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, STATE_FILE), '{"slots":"x","refusedUntil":"y"}');
    assert.equal(setup(dir).b.usedBytes(), 0);
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({
      slots: [{ t: T0 + 5 * HOUR, bytes: 9e9, tests: 1 }, { t: T0 - HOUR, bytes: -5, tests: 1.5 }, null, { t: T0 - 2 * HOUR, bytes: 1000, tests: 1 }],
      refusedUntil: T0 + 99 * 24 * HOUR,
    }));
    const { b } = setup(dir);
    assert.equal(b.usedBytes(), 1000);
    assert.equal(b.tests(), 1);
    assert.equal(b.blockedUntil(), null);
    fs.writeFileSync(path.join(dir, STATE_FILE), 'not json');
    assert.equal(setup(dir).b.usedBytes(), 0);
  });

  it('a read-only state dir does not break counting', () => {
    const b = new SpeedBudget({ stateDir: path.join(tmp(), 'missing', 'dir'), now: () => T0 });
    b.record(1000);
    assert.equal(b.usedBytes(), 1000);
  });
});
