'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../src/features/persist');
const { FeatureStatus, loop } = require('../src/features/status');

describe('persist', () => {
  it('round trip, atomic, size cap, garbage → null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-'));
    assert.equal(writeJson(dir, 'a.json', { x: 1 }), true);
    assert.deepEqual(readJson(dir, 'a.json'), { x: 1 });
    assert.deepEqual(fs.readdirSync(dir), ['a.json']);
    fs.writeFileSync(path.join(dir, 'b.json'), '{nope');
    assert.equal(readJson(dir, 'b.json'), null);
    fs.writeFileSync(path.join(dir, 'c.json'), '[1,2]');
    assert.equal(readJson(dir, 'c.json'), null);
    fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify({ big: 'x'.repeat(2000) }));
    assert.equal(readJson(dir, 'd.json', 1000), null);
    assert.equal(readJson(dir, 'missing.json'), null);
  });

  it('unwritable directory → false, no throw', () => {
    assert.equal(writeJson('/nonexistent/dir', 'a.json', {}), false);
  });
});

describe('FeatureStatus / loop', () => {
  it('tracks runs, success and errors', () => {
    let t = 1;
    const s = new FeatureStatus(() => t);
    s.setEnabled(true);
    s.start();
    assert.equal(s.snapshot().running, true);
    t = 2;
    s.fail(new Error('x'.repeat(500)));
    assert.equal(s.snapshot().lastError.message.length, 200);
    assert.equal(s.snapshot().lastError.at, 2);
    t = 3;
    s.start(); s.ok();
    assert.deepEqual(s.snapshot({ extra: 1 }), { enabled: true, running: false, lastRunAt: 3, lastOkAt: 3, lastError: null, extra: 1 });
  });

  it('loop never overlaps and stops cleanly', async () => {
    let active = 0;
    let max = 0;
    let runs = 0;
    const l = loop(async () => { active++; max = Math.max(max, active); runs++; await new Promise((r) => setTimeout(r, 5)); active--; }, () => 1);
    l.start(0);
    await new Promise((r) => setTimeout(r, 60));
    l.stop();
    const n = runs;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(max, 1);
    assert.ok(n >= 3);
    assert.ok(runs <= n + 1);
  });
});
