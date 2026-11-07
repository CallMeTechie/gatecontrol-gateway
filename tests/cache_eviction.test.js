'use strict';

// Zwischenspeicher unter Last: Räumungsreihenfolge (einmal je Abgleich statt
// je gewolltem Blob) und eine Ereignisschleife, die beim Abgleich von 20 000
// Vorrat-Einträgen mit vollem Speicher ansprechbar bleibt.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BlobStore } = require('../src/cache/store');
const { HomeCache } = require('../src/cache/cache');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gccache-ev-'));
const hex = (i) => i.toString(16).padStart(64, '0');

async function openStore() {
  const s = new BlobStore({ dir: tmp() });
  await s.open();
  return s;
}

/** Eintrag ohne Datei (remove löscht mit force) – reicht für Rang/LRU. */
const put = (s, sha, size, used = 0) => s._set(sha, { size, kind: 'drive', storedAt: 1, lastUsedAt: used });

/** Gateway ohne Netz: Vorrat aus `want`, Downloads schreiben die .part-Datei. */
function makeCache(store, want, maxBytes, { onBlob } = {}) {
  const c = new HomeCache({
    reporter: { post: async () => ({ ok: true }) },
    client: {
      want: async () => want,
      blob: async (sha, size, part) => {
        if (onBlob) onBlob(sha);
        await fs.promises.writeFile(part, Buffer.alloc(size));
        return { fetched: size };
      },
    },
    stateDir: store.dir, tls: {}, addresses: () => [], freeBytes: () => null,
  });
  c.cfg = { enabled: true, kinds: { drive: true }, maxBytes };
  c.store = store;
  return c;
}

/** Größte Pause der Ereignisschleife während `fn` (Takt 5 ms). */
async function maxLag(fn) {
  let worst = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last - 5);
    last = t;
  }, 5);
  try { await fn(); } finally {
    worst = Math.max(worst, performance.now() - last - 5);
    clearInterval(iv);
  }
  return worst;
}

/** Bisheriger Ablauf (je Blob alles neu ranken) als Referenz für die Reihenfolge. */
async function referenceSync(store, want, limit) {
  const sorted = [...want].sort((a, b) => b.priority - a.priority);
  const prio = new Map(sorted.map((w) => [w.sha256, w.priority]));
  for (const w of sorted) {
    if (store.has(w.sha256) || w.size > limit) continue;
    const ok = await store.makeRoom(w.size, limit, (sha) => {
      if (!prio.has(sha)) return -1e15;
      const p = prio.get(sha);
      return p < w.priority ? p : null;
    });
    if (!ok) continue;
    await fs.promises.writeFile(store.partPath(w.sha256), Buffer.alloc(w.size));
    await store.commit(w.sha256, w.size, w.kind);
  }
}

describe('cache: eviction plan', () => {
  it('evicts unwanted first (LRU), then lower priority (LRU); equal/higher stays; all-or-nothing', async () => {
    const s = await openStore();
    put(s, hex(1), 10, 50);   // nicht gewollt, später benutzt
    put(s, hex(2), 10, 20);   // nicht gewollt, früher benutzt → zuerst
    put(s, hex(3), 10, 0);    // Prio 1
    put(s, hex(4), 10, 90);   // Prio 2, zuletzt benutzt
    put(s, hex(5), 10, 10);   // Prio 2
    put(s, hex(6), 10, 0);    // Prio 5
    const prio = new Map([[hex(3), 1], [hex(4), 2], [hex(5), 2], [hex(6), 5]]);
    const plan = s.evictionPlan((sha) => (prio.has(sha) ? prio.get(sha) : -Infinity));
    const order = [];
    const rm = s.remove.bind(s);
    s.remove = async (sha) => { order.push(sha); return rm(sha); };

    assert.equal(await plan.makeRoom(10, 70, 3), true, 'room left → nothing to do');
    assert.deepEqual(order, []);
    assert.equal(await plan.makeRoom(100, 60, 3), false, 'cannot ever fit below prio 3');
    assert.deepEqual(order, [], 'nothing deleted when it does not fit');
    assert.equal(await plan.makeRoom(15, 60, 3), true);
    assert.deepEqual(order, [hex(2), hex(1)]);
    assert.equal(await plan.makeRoom(10, 40, 2), true, 'prio 2 may only displace prio 1');
    assert.deepEqual(order, [hex(2), hex(1), hex(3)]);
    assert.equal(await plan.makeRoom(10, 30, 2), false, 'equal priority stays');
    assert.equal(await plan.makeRoom(20, 30, 9), true);
    assert.deepEqual(order, [hex(2), hex(1), hex(3), hex(5), hex(4)], 'same prio: least recently used first');
    assert.equal(await plan.makeRoom(30, 20, 9), false);
    assert.deepEqual([...s.items.keys()], [hex(6)]);
    assert.deepEqual([...s.removed].sort(), [hex(1), hex(2), hex(3), hex(4), hex(5)]);
  });

  it('skips entries that vanished in the meantime (e.g. cache cleared)', async () => {
    const s = await openStore();
    for (let i = 1; i <= 4; i++) put(s, hex(i), 10, i);
    const plan = s.evictionPlan(() => 0);
    await s.remove(hex(1));
    await s.remove(hex(2));
    assert.equal(await plan.makeRoom(30, 20, 1), false, 'stale sums must not evict partially');
    assert.equal(s.count, 2);
    assert.equal(await plan.makeRoom(10, 20, 1), true);
    assert.deepEqual([...s.items.keys()], [hex(4)]);
  });

  it('store.makeRoom keeps its old contract', async () => {
    const s = await openStore();
    put(s, hex(1), 4, 2000);
    put(s, hex(2), 6, 0);
    assert.equal(await s.makeRoom(4, 12, () => 0), true);
    assert.deepEqual([...s.items.keys()], [hex(1)]);
    assert.equal(await s.makeRoom(100, 12, () => 0), false);
    assert.equal(await s.makeRoom(10, 12, () => null), false);
    assert.equal(s.count, 1);
  });

  it('sync gives the same result as evaluating every blob anew (random cases)', async () => {
    let seed = 42;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 25; round++) {
      const a = await openStore();
      const b = await openStore();
      const want = [];
      let id = round * 1000 + 1;
      for (let i = 0; i < 40; i++) {
        const sha = hex(id++);
        const size = 1 + rnd(30);
        const priority = rnd(6);
        const used = rnd(100);
        const stored = rnd(3) === 0;
        if (stored) { put(a, sha, size, used); put(b, sha, size, used); }
        if (rnd(4) !== 0) want.push({ sha256: sha, size, kind: 'drive', priority });
      }
      const limit = Math.max(20, a.usedBytes + rnd(40) - 20);
      await makeCache(a, want, limit).sync();
      await referenceSync(b, want, limit);
      assert.deepEqual([...a.items.keys()].sort(), [...b.items.keys()].sort(), `round ${round}`);
      assert.equal(a.usedBytes, b.usedBytes);
    }
  });
});

describe('cache: sync under load', () => {
  it('20 000 wanted, store full of higher-priority blobs: event loop stays responsive', async () => {
    const s = await openStore();
    const want = [];
    for (let i = 0; i < 20_000; i++) want.push({ sha256: hex(i + 1), size: 50_000, kind: 'drive', priority: 20_000 - i });
    for (const w of want.slice(0, 10_000)) put(s, w.sha256, w.size);
    let blobs = 0;
    const c = makeCache(s, want, s.usedBytes, { onBlob: () => { blobs++; } });
    const t0 = performance.now();
    const lag = await maxLag(() => c.sync());
    const ms = performance.now() - t0;
    assert.equal(blobs, 0, 'nothing fits, nothing may be displaced');
    assert.equal(s.count, 10_000);
    assert.equal(c.status.lastError, null);
    assert.ok(lag < 200, `event loop blocked for ${Math.round(lag)} ms (sync ${Math.round(ms)} ms)`);
    assert.ok(ms < 5_000, `sync took ${Math.round(ms)} ms`);
  });

  it('20 000 wanted with mixed priorities: evicts unwanted and lower ones, stays responsive', async () => {
    const s = await openStore();
    const want = [];
    for (let i = 0; i < 20_000; i++) want.push({ sha256: hex(i + 1), size: 100, kind: 'drive', priority: (i * 7919) % 1000 });
    // voll: 9 000 gewollte Einträge + 100 nicht mehr gewollte
    for (let i = 0; i < 9_000; i++) put(s, want[i * 2].sha256, 100, i);
    for (let i = 0; i < 100; i++) put(s, hex(900_000 + i), 100, i);
    const max = s.usedBytes;
    const c = makeCache(s, want, max);
    const lag = await maxLag(() => c.sync());
    assert.ok(lag < 200, `event loop blocked for ${Math.round(lag)} ms`);
    assert.ok(s.usedBytes <= max);
    for (let i = 0; i < 100; i++) assert.equal(s.has(hex(900_000 + i)), false, 'unwanted blobs go first');
    // Ergebnis: genau die höchsten Prioritäten sind da
    const kept = want.filter((w) => s.has(w.sha256)).map((w) => w.priority);
    const missing = want.filter((w) => !s.has(w.sha256)).map((w) => w.priority);
    assert.equal(kept.length, 9_100);
    assert.ok(Math.min(...kept) >= Math.max(...missing), 'no lower priority kept while a higher one is missing');
    // Index landet asynchron auf dem Datenträger und lässt sich wieder öffnen
    const idx = JSON.parse(fs.readFileSync(path.join(s.dir, '.gc-index.json'), 'utf8'));
    assert.equal(Object.keys(idx.items).length, 9_100);
  });

  it('save(): big index written without blocking; overlapping calls coalesce; sync persist wins', async () => {
    const s = await openStore();
    for (let i = 0; i < 50_000; i++) put(s, hex(i + 1), 1, i);
    const lag = await maxLag(async () => {
      const p1 = s.save();
      s.touch(hex(1));
      const p2 = s.save();
      const p3 = s.save();
      assert.equal(p2, p3, 'one follow-up run at most');
      await Promise.all([p1, p2]);
    });
    assert.ok(lag < 200, `event loop blocked for ${Math.round(lag)} ms`);
    assert.equal(s.dirty, false);
    let idx = JSON.parse(fs.readFileSync(path.join(s.dir, '.gc-index.json'), 'utf8'));
    assert.equal(Object.keys(idx.items).length, 50_000);
    assert.equal(idx.items[hex(1)].lastUsedAt, s.get(hex(1)).lastUsedAt);

    // synchroner Abschluss während eines laufenden save(): der neuere Stand bleibt
    put(s, hex(1), 7);
    const p = s.save();
    s._unset(hex(2));
    s.persist();
    await p;
    idx = JSON.parse(fs.readFileSync(path.join(s.dir, '.gc-index.json'), 'utf8'));
    assert.equal(idx.items[hex(2)], undefined);
    assert.equal(idx.items[hex(1)].size, 7);
    assert.equal(fs.existsSync(path.join(s.dir, '.gc-index.json.tmp-async')), false);
  });
});
