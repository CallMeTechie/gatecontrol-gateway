'use strict';

// 429 vom Server auf /cache/*: Lauf sofort beenden (keine drei weiteren
// Versuche), Retry-After abwarten, dann weiter. Blob-Anfragen gedrosselt.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BlobStore } = require('../src/cache/store');
const { HomeCache } = require('../src/cache/cache');
const { makeCacheClient, retryAfterMs } = require('../src/cache/fetcher');
const { startCacheServer } = require('./helpers/fakeCacheServer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gccache-rl-'));
const hex = (i) => i.toString(16).padStart(64, '0');
const rl = (ms) => Object.assign(new Error('HTTP 429'), { code: 'rate_limited', retryAfterMs: ms });

async function makeCache({ want, blob, post, blobGapMs = 0 }) {
  const store = new BlobStore({ dir: tmp() });
  await store.open();
  let t = 1_000_000;
  const c = new HomeCache({
    reporter: { post: post || (async () => ({ ok: true, status: 200 })) },
    client: { want, blob },
    stateDir: store.dir, tls: {}, addresses: () => [], freeBytes: () => null, now: () => t, blobGapMs,
  });
  c.cfg = { enabled: true, kinds: { drive: true }, maxBytes: 1e9 };
  c.store = store;
  return { c, store, advance: (ms) => { t += ms; } };
}

const items = (n) => Array.from({ length: n }, (_, i) => ({ sha256: hex(i + 1), size: 10, kind: 'drive', priority: n - i }));

describe('cache: server rate limit (429)', () => {
  it('Retry-After: seconds, HTTP date, missing/garbage → 60 s, clamped to 1 s … 1 h', () => {
    const now = Date.parse('2026-11-07T20:00:00Z');
    assert.equal(retryAfterMs('120', now), 120_000);
    assert.equal(retryAfterMs(['5'], now), 5_000);
    assert.equal(retryAfterMs('Sat, 07 Nov 2026 20:02:00 GMT', now), 120_000);
    assert.equal(retryAfterMs(undefined, now), 60_000);
    assert.equal(retryAfterMs('', now), 60_000);
    assert.equal(retryAfterMs('soon', now), 60_000);
    assert.equal(retryAfterMs('0', now), 1_000);
    assert.equal(retryAfterMs('999999', now), 3_600_000);
  });

  it('429 on a blob ends the run at once, pauses sync and report until Retry-After', async () => {
    let wants = 0;
    const gets = [];
    const posts = [];
    const { c, store, advance } = await makeCache({
      want: async () => { wants++; return items(10); },
      blob: async (sha, size, part) => {
        gets.push(sha);
        if (gets.length === 3) throw rl(120_000);
        await fs.promises.writeFile(part, Buffer.alloc(size));
        return { fetched: size };
      },
      post: async (_p, body) => { posts.push(body); return { ok: true, status: 200 }; },
    });
    await c.sync();
    assert.equal(gets.length, 3, 'no further requests after the 429');
    assert.equal(store.count, 2);
    assert.equal(c.status.lastError.message, 'rate_limited');
    assert.equal(c.pausedUntil, c.now() + 120_000);
    assert.equal(posts.length, 0, 'no report while paused');

    await c.sync();
    await c.report();
    assert.equal(wants, 1, 'no want request while paused');
    assert.equal(posts.length, 0);

    advance(120_001);
    await c.sync();
    assert.equal(wants, 2);
    assert.equal(store.count, 10, 'resumes after Retry-After');
    assert.equal(posts.length, 1);
    assert.equal(c.status.lastError, null);
  });

  it('429 on want and on the report pause too', async () => {
    let wants = 0;
    const { c, advance } = await makeCache({
      want: async () => { wants++; throw rl(30_000); },
      blob: async () => { throw new Error('unused'); },
      post: async () => ({ ok: false, status: 429, retryAfter: '45' }),
    });
    await c.sync();
    assert.equal(c.pausedUntil, c.now() + 30_000);
    await c.sync();
    assert.equal(wants, 1);
    advance(30_000);
    await c.report();
    assert.equal(c.pausedUntil, c.now() + 45_000, 'report 429 → Retry-After of the report');
    assert.equal(c.needFull, true);
  });

  it('real HTTP: the client turns 429 + Retry-After into rate_limited', async () => {
    const srv = await startCacheServer();
    try {
      const client = makeCacheClient({ serverUrl: srv.url, apiToken: srv.token });
      srv.state.wantStatus = 429;
      srv.state.retryAfter = '90';
      await assert.rejects(client.want(), (e) => e.code === 'rate_limited' && e.retryAfterMs === 90_000);
      srv.state.blobStatus = 429;
      const part = path.join(tmp(), `${hex(1)}.part`);
      await assert.rejects(client.blob(hex(1), 10, part), (e) => e.code === 'rate_limited' && e.retryAfterMs === 90_000);
    } finally { srv.close(); }
  });

  it('blob requests are spaced out (blobGapMs)', async () => {
    const { c, store } = await makeCache({
      want: async () => items(4),
      blob: async (sha, size, part) => { await fs.promises.writeFile(part, Buffer.alloc(size)); return { fetched: size }; },
      blobGapMs: 60,
    });
    const t0 = performance.now();
    await c.sync();
    assert.equal(store.count, 4);
    assert.ok(performance.now() - t0 >= 170, 'at least 3 gaps of 60 ms');
  });
});
