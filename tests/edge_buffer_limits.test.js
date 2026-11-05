'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventBuffer } = require('../src/edge/eventBuffer');
const { RateWindow, truncateUtf8 } = require('../src/edge/limits');
const { PluginStore } = require('../src/edge/store');

function clock(t0 = 1_700_000_000_000) {
  const c = { t: t0, now: () => c.t };
  return c;
}

test('seq aufsteigend, auch über einen Neustart (Startwert = Uhrzeit)', () => {
  const c = clock();
  const b = new EventBuffer({ now: c.now });
  const a1 = b.push('p', 'e', 1);
  const a2 = b.push('p', 'e', 2);
  assert.strictEqual(a1.seq, c.t);
  assert.strictEqual(a2.seq, c.t + 1);
  c.t += 5;
  const b2 = new EventBuffer({ now: c.now }); // "Neustart"
  assert.ok(b2.push('p', 'e', 3).seq > a2.seq);
  assert.strictEqual(a1.t, 'event');
  assert.strictEqual(a1.plugin, 'p');
  assert.strictEqual(typeof a1.at, 'string');
});

test('ack bis einschließlich seq; pending() liefert den Rest in Reihenfolge', () => {
  const c = clock();
  const b = new EventBuffer({ now: c.now });
  const s = [1, 2, 3, 4].map((i) => b.push('p', 'e', i).seq);
  assert.strictEqual(b.ack(s[1]), 2);
  assert.deepStrictEqual(b.pending().map((m) => m.data), [3, 4]);
  assert.strictEqual(b.ack(s[3] + 100), 2);
  assert.strictEqual(b.size, 0);
  assert.strictEqual(b.ack(NaN), 0);
});

test('offline höchstens 1000 Ereignisse / 1 h', () => {
  const c = clock();
  const b = new EventBuffer({ now: c.now });
  for (let i = 0; i < 1005; i++) b.push('p', 'e', i);
  assert.strictEqual(b.size, 1000);
  assert.strictEqual(b.lost, 5);
  assert.strictEqual(b.pending()[0].data, 5);
  c.t += 60 * 60 * 1000 + 1;
  b.push('p', 'e', 'neu');
  assert.deepStrictEqual(b.pending().map((m) => m.data), ['neu']);
});

test('RateWindow: 50/s, darüber verworfen und gezählt', () => {
  const c = clock();
  const r = new RateWindow(50, 1000, c.now);
  let ok = 0;
  for (let i = 0; i < 60; i++) if (r.take()) ok++;
  assert.strictEqual(ok, 50);
  assert.strictEqual(r.drainDropped(), 10);
  assert.strictEqual(r.drainDropped(), 0);
  c.t += 1000;
  assert.ok(r.take());
});

test('truncateUtf8: höchstens n Bytes, kein halbes Zeichen', () => {
  assert.strictEqual(truncateUtf8('abc', 10), 'abc');
  const s = 'ä'.repeat(2000); // 4000 Bytes
  const t = truncateUtf8(s, 2047);
  assert.ok(Buffer.byteLength(t) <= 2047);
  assert.strictEqual(t, 'ä'.repeat(1023));
  assert.strictEqual(truncateUtf8('a€', 3), 'a');
});

test('gc.store: ≤ 1 MB, Schlüsselregeln, Datei im eigenen Ordner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-store-'));
  try {
    const s = new PluginStore(dir, 'demo-edge', { maxBytes: 1024 });
    assert.strictEqual(s.get('a'), null);
    s.set('a', { x: 1 });
    assert.deepStrictEqual(new PluginStore(dir, 'demo-edge').get('a'), { x: 1 });
    assert.throws(() => s.set('big', 'x'.repeat(2000)), (e) => e.code === 'too_large');
    assert.deepStrictEqual(s.get('a'), { x: 1 }, 'unverändert nach Ablehnung');
    s.delete('a');
    assert.strictEqual(s.get('a'), null);
    assert.throws(() => s.set('../x', 1), (e) => e.code === 'bad_key');
    assert.throws(() => new PluginStore(dir, '../evil'));
    assert.ok(fs.existsSync(path.join(dir, 'demo-edge', 'store.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
