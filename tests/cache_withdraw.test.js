'use strict';

// Zurückgezogene Blobs (Server nimmt sie aus dem Vorrat, z. B. Tresor-Ordner
// „Nur auf diesem Gerät“): beim nächsten Abgleich mit vollständiger Liste
// sofort gelöscht – Datei, Index, halber Download –, auch mitten in einem
// laufenden Download. Fehlt die Liste oder ist sie unvollständig, bleibt alles.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BlobStore } = require('../src/cache/store');
const { HomeCache } = require('../src/cache/cache');
const { parseWant, MAX_WANT_ITEMS } = require('../src/cache/fetcher');
const { normalizeCache } = require('../src/cache/config');
const { makeReporter } = require('../src/features/reporter');
const { startCacheServer } = require('./helpers/fakeCacheServer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gccache-wd-'));
const hex = (i) => i.toString(16).padStart(64, '0');
const SECRET = 's'.repeat(40);
const plain = ({ data: _data, ...w }) => w;

async function storeWith(...entries) {
  const s = new BlobStore({ dir: tmp() });
  await s.open();
  for (const [sha, size, kind = 'drive'] of entries) {
    fs.writeFileSync(s.partPath(sha), Buffer.alloc(size));
    await s.commit(sha, size, kind);
  }
  return s;
}

/** Gateway ohne Netz; `want()` liefert, was `state.want()` gerade sagt. */
function makeCache(store, state, { kinds = { drive: true }, posts = [] } = {}) {
  const c = new HomeCache({
    reporter: { post: async (_p, body) => { posts.push(body); return { ok: true, status: 200 }; } },
    client: {
      want: async () => state.want(),
      blob: (sha, size, part, opts) => state.blob(sha, size, part, opts),
    },
    stateDir: store.dir, tls: {}, addresses: () => [], freeBytes: () => null, blobGapMs: 0,
  });
  c.cfg = { enabled: true, kinds, maxBytes: 1e9 };
  c.store = store;
  return c;
}

const writeBlob = async (_sha, size, part) => { await fs.promises.writeFile(part, Buffer.alloc(size)); return { fetched: size }; };
const item = (i, extra = {}) => ({ sha256: hex(i), size: 10, kind: 'drive', priority: 1, ...extra });

describe('cache: withdrawn blobs are deleted at once', () => {
  it('parseWant marks complete lists and every listed sha256', () => {
    const list = parseWant({ items: [item(1), { ...item(2), kind: '../x' }, { sha256: 'A'.repeat(64), size: -1 }] });
    assert.equal(list.length, 1);
    assert.equal(list.complete, true);
    assert.deepEqual([...list.listed].sort(), [hex(1), hex(2), 'a'.repeat(64)], 'also from entries dropped otherwise');
    assert.deepEqual(JSON.parse(JSON.stringify(list)), [item(1)], 'extra fields not enumerable');
    const full = parseWant(Array.from({ length: MAX_WANT_ITEMS }, (_, i) => item(i + 1)));
    assert.equal(full.complete, false, 'a list at the limit may be cut off');
    assert.equal(parseWant([]).complete, true, 'empty is complete');
  });

  it('withdrawn blob: file, index and .part gone right away (plenty of room), reported as gone', async () => {
    const keep = hex(1);
    const gone = hex(2);
    const store = await storeWith([keep, 10], [gone, 10]);
    fs.writeFileSync(store.partPath(hex(3)), 'half');   // halber Download, zurückgezogen
    fs.writeFileSync(store.partPath(hex(4)), 'half');   // halber Download, noch gewollt
    fs.writeFileSync(path.join(store.dir, 'fremde-datei.txt'), 'bleibt');
    const posts = [];
    let fetched = 0;
    const c = makeCache(store, {
      want: () => parseWant({ items: [item(1), item(4, { size: 4 })] }),
      blob: async (...a) => { fetched++; return writeBlob(...a); },
    }, { posts });
    await c.sync();
    assert.equal(store.has(keep), true);
    assert.equal(store.has(gone), false);
    assert.equal(fs.existsSync(store.filePath(gone)), false, 'file deleted');
    assert.equal(fs.existsSync(store.partPath(hex(3))), false, 'withdrawn .part deleted');
    assert.equal(fs.existsSync(path.join(store.dir, 'fremde-datei.txt')), true, 'foreign files stay');
    assert.equal(fetched, 1, 'still wanted .part is fetched on');
    assert.equal(store.has(hex(4)), true);
    assert.equal(store.usedBytes, 14);
    assert.ok(posts.some((p) => p.gone.includes(gone) || (p.full && !p.have.includes(gone))), 'server learns it is gone');
    const again = new BlobStore({ dir: store.dir });
    await again.open();
    assert.equal(again.has(gone), false, 'index saved without it');
    assert.equal(again.has(keep), true);
  });

  it('server unreachable, error, 429 or a cut-off list: nothing is deleted', async () => {
    const store = await storeWith([hex(1), 10], [hex(2), 10]);
    const err = (code) => () => { throw Object.assign(new Error(code), { code, retryAfterMs: 1000 }); };
    for (const want of [err('network'), err('timeout'), err('http_status'), err('bad_json'), err('rate_limited')]) {
      const c = makeCache(store, { want, blob: writeBlob });
      await c.sync();
      assert.equal(store.count, 2, 'kept after a failed want');
    }
    const cut = parseWant(Array.from({ length: MAX_WANT_ITEMS }, (_, i) => item(i + 100)));
    const c = makeCache(store, { want: () => cut, blob: async () => ({ fetched: 0 }) });
    c.cfg.maxBytes = 0;   // nichts laden, nur Liste prüfen
    await c.sync();
    assert.equal(store.has(hex(1)) && store.has(hex(2)), true, 'kept with a cut-off list');
    // ohne Angabe, ob vollständig (fremder Client): bisheriges Verhalten
    const old = makeCache(store, { want: () => [item(1)], blob: writeBlob });
    await old.sync();
    assert.equal(store.has(hex(2)), true);
  });

  it('a kind switched off here stays (only what the server withdraws is deleted)', async () => {
    const store = await storeWith([hex(1), 10, 'vault'], [hex(2), 10, 'drive']);
    const c = makeCache(store, { want: () => parseWant([item(1, { kind: 'vault' })]), blob: writeBlob });
    await c.sync();
    assert.equal(store.has(hex(1)), true, 'listed (kind off here): left to eviction as before');
    assert.equal(store.has(hex(2)), false);
  });

  it('requestSync while a withdrawn blob downloads: download aborted, .part deleted, nothing kept', async () => {
    const store = await storeWith();
    const big = hex(9);
    let listed = [item(9, { size: 1000 })];
    let started;
    const startedP = new Promise((r) => { started = r; });
    const calls = [];
    const c = makeCache(store, {
      want: () => parseWant(listed),
      blob: (sha, size, part, { signal }) => new Promise((resolve, reject) => {
        calls.push(sha);
        fs.writeFileSync(part, Buffer.alloc(100));
        started();
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })), { once: true });
      }),
    });
    const run = c.sync();
    await startedP;
    assert.equal(c.telemetry().downloading.sha256, big);
    listed = [];                               // Server zieht zurück
    assert.equal(c.requestSync(), 'accepted', 'also while running');
    await run;
    assert.equal(store.has(big), false);
    assert.equal(fs.existsSync(store.partPath(big)), false, '.part deleted');
    assert.deepEqual(calls, [big], 'not fetched again');
    assert.equal(c.syncing, null);
  });

  it('requestSync while a still wanted blob downloads: resumed in the next run', async () => {
    const store = await storeWith();
    const sha = hex(7);
    let first = true;
    let started;
    const startedP = new Promise((r) => { started = r; });
    const haves = [];
    const c = makeCache(store, {
      want: () => parseWant([item(7, { size: 200 })]),
      blob: (s, size, part, { signal }) => {
        haves.push(fs.existsSync(part) ? fs.statSync(part).size : 0);
        if (!first) return writeBlob(s, size, part);
        first = false;
        fs.writeFileSync(part, Buffer.alloc(100));
        started();
        return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })), { once: true }));
      },
    });
    const run = c.sync();
    await startedP;
    assert.equal(c.requestSync(), 'accepted');
    await run;
    assert.deepEqual(haves, [0, 100], 'second run found the .part (Range resume)');
    assert.equal(store.has(sha), true);
  });
});

describe('cache: withdrawal against the fake server', () => {
  let srv;
  before(async () => { srv = await startCacheServer(); });
  after(() => srv.close());

  it('real client: withdrawn blob deleted on the next sync; server down → kept', async () => {
    const root = tmp();
    const a = srv.add(1000, 'drive', 5);
    const b = srv.add(2000, 'drive', 4);
    srv.state.want = [a, b].map(plain);
    const c = new HomeCache({
      reporter: makeReporter({ serverUrl: srv.url, apiToken: srv.token }),
      serverUrl: srv.url, apiToken: srv.token, stateDir: tmp(), addresses: () => [],
      freeBytes: () => 1e12, syncMs: 3600_000, reportMs: 3600_000, listenMs: 3600_000, blobGapMs: 0,
    });
    const cfg = normalizeCache({ enabled: true, path: `${root}/c`, secret: SECRET, port: 19443 + Math.floor(Math.random() * 1000) }, { root });
    await c.apply(cfg);
    await c.sync();
    assert.equal(c.store.has(a.sha256) && c.store.has(b.sha256), true);

    srv.state.want = [a].map(plain);
    srv.state.wantStatus = 503;                // Server gestört → nichts löschen
    await c.sync();
    assert.equal(c.store.has(b.sha256), true);

    srv.state.wantStatus = 200;
    const n = srv.state.posts.length;
    await c.sync();
    assert.equal(c.store.has(b.sha256), false);
    assert.equal(fs.existsSync(path.join(cfg.path, b.sha256)), false);
    assert.equal(c.store.has(a.sha256), true);
    const p = srv.state.posts.slice(n).at(-1);
    assert.ok(p && (p.gone.includes(b.sha256) || (p.full && !p.have.includes(b.sha256))), 'reported right after');
    c.stop();
  });
});
