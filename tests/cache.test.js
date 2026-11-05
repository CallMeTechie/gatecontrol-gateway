'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const tlsMod = require('node:tls');
const { sign, verify } = require('../src/cache/signature');
const { parseRange, makeHandler, LanBlobServer } = require('../src/cache/lanServer');
const { BlobStore } = require('../src/cache/store');
const { makeCacheClient, parseWant } = require('../src/cache/fetcher');
const { normalizeCache, safePath } = require('../src/cache/config');
const { makeSelfSigned, loadOrCreate } = require('../src/cache/selfsigned');
const { HomeCache } = require('../src/cache/cache');
const { makeReporter } = require('../src/features/reporter');
const { startCacheServer } = require('./helpers/fakeCacheServer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gccache-'));
const SECRET = 's'.repeat(40);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('cache: config', () => {
  it('path must stay under the cache root; secret and sizes checked', () => {
    const root = '/cache';
    assert.equal(safePath(undefined, root), '/cache');
    assert.equal(safePath('/cache/sub/dir', root), '/cache/sub/dir');
    assert.equal(safePath('sub', root), '/cache/sub');
    assert.equal(safePath('/cache/../etc', root), null);
    assert.equal(safePath('/cachefoo', root), null);
    assert.equal(safePath('../x', root), null);
    assert.equal(safePath('/etc/passwd', root), null);
    assert.equal(safePath('/cache/a\0b', root), null);
    const c = normalizeCache({ enabled: true, path: '/cache/gc', maxBytes: 5, kinds: { vault: true, photos: 'yes' }, secret: SECRET }, { root });
    assert.deepEqual({ en: c.enabled, p: c.path, m: c.maxBytes, k: c.kinds, port: c.port }, {
      en: true, p: '/cache/gc', m: 256 * 1024 * 1024, k: { drive: true, photos: true, updates: true, vault: true }, port: 8443,
    });
    assert.equal(normalizeCache({ enabled: true, path: '/etc', secret: SECRET }, { root }).problem, 'path_not_allowed');
    assert.equal(normalizeCache({ enabled: true, secret: 'short' }, { root }).problem, 'no_secret');
    assert.equal(normalizeCache(undefined).enabled, false);
  });
});

describe('cache: signature', () => {
  const h = 'a'.repeat(64);
  const now = 1_800_000_000_000;
  const exp = String(now / 1000 + 300);
  it('accepts a valid signature, upper-case hex too', () => {
    assert.equal(verify(SECRET, h, exp, sign(SECRET, h, exp), now), 'ok');
    assert.equal(verify(SECRET, h, exp, sign(SECRET, h, exp).toUpperCase(), now), 'ok');
    assert.equal(sign(SECRET, h, exp), crypto.createHmac('sha256', SECRET).update(`${h}\n${exp}`).digest('hex'));
  });
  it('rejects expired, too far ahead, wrong secret/sha/exp, malformed', () => {
    const past = String(now / 1000 - 1);
    assert.equal(verify(SECRET, h, past, sign(SECRET, h, past), now), 'expired');
    const far = String(now / 1000 + 661);
    assert.equal(verify(SECRET, h, far, sign(SECRET, h, far), now), 'too_far');
    const edge = String(now / 1000 + 660);
    assert.equal(verify(SECRET, h, edge, sign(SECRET, h, edge), now), 'ok');
    assert.equal(verify('t'.repeat(40), h, exp, sign(SECRET, h, exp), now), 'bad_signature');
    assert.equal(verify(SECRET, 'b'.repeat(64), exp, sign(SECRET, h, exp), now), 'bad_signature');
    assert.equal(verify(SECRET, h, String(Number(exp) + 1), sign(SECRET, h, exp), now), 'bad_signature');
    for (const [s, e, g] of [[h, exp, 'xyz'], [h, '12a', sign(SECRET, h, exp)], [h, null, sign(SECRET, h, exp)], ['../etc', exp, 'a'.repeat(64)], [h, exp, sign(SECRET, h, exp) + '00']]) {
      assert.equal(verify(SECRET, s, e, g, now), 'bad_request');
    }
    assert.equal(verify(null, h, exp, sign(SECRET, h, exp), now), 'bad_request');
  });
  it('parseRange', () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
    for (const bad of ['bytes=100-', 'bytes=5-1', 'bytes=-0', 'bytes=0-1,5-6', 'items=0-1', 'bytes=-']) assert.equal(parseRange(bad, 100), 'invalid', bad);
  });
});

describe('cache: blob store', () => {
  it('only sha256 names map to paths (no traversal)', () => {
    const s = new BlobStore({ dir: '/cache/x' });
    assert.equal(s.filePath('a'.repeat(64)), '/cache/x/' + 'a'.repeat(64));
    for (const bad of ['../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}/..`, '', null]) assert.throws(() => s.filePath(bad));
  });

  it('open reconciles with the directory, makeRoom evicts by rank then LRU, clear', async () => {
    const dir = tmp();
    let t = 1000;
    const a = Buffer.from('aaaa');
    const b = Buffer.from('bbbbbb');
    fs.writeFileSync(path.join(dir, sha(a)), a);                   // ohne Index → wird geprüft und übernommen
    fs.writeFileSync(path.join(dir, 'f'.repeat(64)), 'falsch');    // Inhalt passt nicht → gelöscht
    fs.writeFileSync(path.join(dir, 'fremde-datei.txt'), 'bleibt');
    const s = new BlobStore({ dir, now: () => t });
    await s.open();
    assert.equal(s.has(sha(a)), true);
    assert.equal(fs.existsSync(path.join(dir, 'f'.repeat(64))), false);
    assert.equal(fs.existsSync(path.join(dir, 'fremde-datei.txt')), true);
    fs.writeFileSync(s.partPath(sha(b)), b);
    await s.commit(sha(b), b.length, 'drive');
    assert.equal(s.usedBytes, 10);
    t = 2000; s.touch(sha(a));
    // b zuletzt nie abgegeben → fliegt zuerst
    assert.equal(await s.makeRoom(4, 12, () => 0), true);
    assert.equal(s.has(sha(b)), false);
    assert.equal(s.has(sha(a)), true);
    assert.deepEqual([...s.removed], [sha(b)]);
    assert.equal(await s.makeRoom(100, 12, () => 0), false, 'cannot make room → nothing deleted');
    assert.equal(s.has(sha(a)), true);
    assert.equal(await s.makeRoom(10, 12, () => null), false, 'protected items stay');
    s.persist();
    const s2 = new BlobStore({ dir });
    await s2.open();
    assert.equal(s2.get(sha(a)).lastUsedAt, 2000, 'LRU info survives restart');
    await s2.clear();
    assert.equal(s2.count, 0);
    assert.equal(fs.existsSync(path.join(dir, sha(a))), false);
  });

  it('open fails on an unwritable path', async () => {
    const f = path.join(tmp(), 'file');
    fs.writeFileSync(f, 'x');
    await assert.rejects(new BlobStore({ dir: path.join(f, 'sub') }).open());
  });
});

describe('cache: fetcher', () => {
  let srv;
  before(async () => { srv = await startCacheServer(); });
  after(() => srv.close());

  it('parseWant accepts arrays and filters junk', () => {
    const ok = { sha256: 'A'.repeat(64), size: 10, kind: 'updates', priority: 2 };
    assert.deepEqual(parseWant([ok, ok, { ...ok, sha256: 'x' }, { ...ok, sha256: 'b'.repeat(64), size: -1 }, { ...ok, sha256: 'c'.repeat(64), kind: '../x' }]), [{ ...ok, sha256: 'a'.repeat(64) }]);
    assert.equal(parseWant({ want: [] }).length, 0);
    assert.equal(parseWant({ nope: 1 }), null);
  });

  it('downloads, resumes with Range after a broken connection, verifies sha256', async () => {
    const c = makeCacheClient({ serverUrl: srv.url, apiToken: srv.token });
    const item = srv.add(300_000);
    const part = path.join(tmp(), `${item.sha256}.part`);
    srv.state.cutAfter = 100_000;
    await assert.rejects(c.blob(item.sha256, item.size, part), (e) => ['short', 'network'].includes(e.code));
    const have = fs.statSync(part).size;
    assert.ok(have > 0 && have < item.size);
    const r = await c.blob(item.sha256, item.size, part);
    assert.equal(r.fetched, item.size - have);
    assert.equal(srv.state.blobGets.at(-1).range, `bytes=${have}-`);
    assert.equal(sha(fs.readFileSync(part)), item.sha256);
  });

  it('sha256 mismatch deletes the part; wrong size and 404 fail', async () => {
    const c = makeCacheClient({ serverUrl: srv.url, apiToken: srv.token });
    const item = srv.add(1000);
    const part = path.join(tmp(), 'p.part');
    srv.state.corrupt.add(item.sha256);
    await assert.rejects(c.blob(item.sha256, item.size, part), (e) => e.code === 'sha256_mismatch');
    assert.equal(fs.existsSync(part), false);
    srv.state.corrupt.delete(item.sha256);
    await assert.rejects(c.blob(item.sha256, 500, part), (e) => e.code === 'too_large');
    await assert.rejects(c.blob('d'.repeat(64), 10, part), (e) => e.code === 'not_found');
    await assert.rejects(c.blob('../x', 10, part), (e) => e.code === 'bad_sha');
  });
});

describe('cache: LAN endpoint (real HTTPS)', () => {
  let server;
  let store;
  let port;
  let tls;
  const counters = { hits: 0, misses: 0, bytesServed: 0, denied: 0 };
  const data = crypto.randomBytes(5000);
  const h = sha(data);
  before(async () => {
    const dir = tmp();
    store = new BlobStore({ dir });
    await store.open();
    fs.writeFileSync(store.partPath(h), data);
    await store.commit(h, data.length, 'updates');
    fs.symlinkSync('/etc/hostname', path.join(dir, 'e'.repeat(64)));
    store.items.set('e'.repeat(64), { size: 1, kind: 'x', storedAt: 0, lastUsedAt: 0 }); // Symlink untergeschoben
    tls = makeSelfSigned();
    server = new LanBlobServer({
      handler: makeHandler({ secret: () => SECRET, store, now: Date.now, counters }),
      tls, port: 0, addresses: () => [{ address: '127.0.0.1', family: 4 }],
    });
    const st = await server.reconcile();
    assert.equal(st.state, 'running');
    port = server.servers.get('127.0.0.1').address().port;
  });
  after(() => server.close());

  // Client mit Fingerabdruck-Pinning (wie die Apps)
  function get(p, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1', port, path: p, method, headers, ca: tls.cert,
        checkServerIdentity: (_h, cert) => (crypto.createHash('sha256').update(cert.raw).digest('hex') === tls.sha256 ? undefined : new Error('pin')),
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  const signed = (s, ahead = 300) => {
    const exp = String(Math.floor(Date.now() / 1000) + ahead);
    return `/blob/${s}?exp=${exp}&sig=${sign(SECRET, s, exp)}`;
  };

  it('serves a signed blob; pinned fingerprint matches', async () => {
    const r = await get(signed(h));
    assert.equal(r.status, 200);
    assert.equal(sha(r.body), h);
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers.etag, `"${h}"`);
    assert.ok(counters.hits >= 1 && counters.bytesServed >= 5000);
    assert.ok(store.get(h).lastUsedAt > 0);
  });

  it('range requests → 206 / 416; HEAD', async () => {
    const r = await get(signed(h), { range: 'bytes=100-199' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 100-199/5000');
    assert.deepEqual(r.body, data.subarray(100, 200));
    const t = await get(signed(h), { range: 'bytes=-10' });
    assert.deepEqual(t.body, data.subarray(4990));
    assert.equal((await get(signed(h), { range: 'bytes=6000-' })).status, 416);
    const hd = await get(signed(h), {}, 'HEAD');
    assert.equal(hd.status, 200);
    assert.equal(hd.headers['content-length'], '5000');
    assert.equal(hd.body.length, 0);
  });

  it('403 without/with bad or expired signature, 404 when missing, no traversal', async () => {
    const denied = counters.denied;
    assert.equal((await get(`/blob/${h}`)).status, 403);
    assert.equal((await get(signed(h, -10))).status, 403);
    assert.deepEqual(JSON.parse((await get(signed(h, 3600))).body), { error: 'too_far' });
    assert.equal((await get(signed(h).replace(/sig=./, 'sig=0'))).status, 403);
    assert.equal(counters.denied, denied + 4);
    const missing = 'c'.repeat(64);
    assert.equal((await get(signed(missing))).status, 404);
    for (const p of ['/blob/../../etc/passwd', '/blob/%2e%2e%2fetc%2fpasswd', `/blob/${h}/x`, `/blob/${h.toUpperCase()}`, '/', '/index.json', '/blob/.gc-index.json']) {
      assert.equal((await get(p)).status, 404, p);
    }
    assert.equal((await get(signed('e'.repeat(64)))).status, 404, 'symlinks are not followed');
    assert.equal((await get(signed(h), {}, 'POST')).status, 405);
  });

  it('a different certificate fails the pin', async () => {
    const other = makeSelfSigned();
    await assert.rejects(new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: '/', agent: false, ca: tls.cert, checkServerIdentity: (_h, cert) => (sha(cert.raw) === other.sha256 ? undefined : new Error('pin')) }, resolve).on('error', reject);
    }), /pin/);
  });

  it('port in use → port_busy', async () => {
    const other = new LanBlobServer({ handler: () => {}, tls, port, addresses: () => [{ address: '127.0.0.1', family: 4 }] });
    assert.equal((await other.reconcile()).state, 'port_busy');
    other.close();
  });

  it('certificate persists across restarts', () => {
    const dir = tmp();
    const a = loadOrCreate(dir);
    const b = loadOrCreate(dir);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.sha256, b.sha256);
    assert.equal((fs.statSync(path.join(dir, 'key.pem')).mode & 0o777), 0o600);
    assert.ok(tlsMod.createSecureContext({ key: b.key, cert: b.cert }));
  });
});

describe('cache: HomeCache flow against a fake server', () => {
  let srv;
  before(async () => { srv = await startCacheServer(); });
  after(() => srv.close());

  it('fetches the wanted blobs (kinds, priority, limit), reports full then delta, serves them', async () => {
    const root = tmp();
    const stateDir = tmp();
    const upd = srv.add(400_000, 'updates', 10);
    const photo = srv.add(300_000, 'photos', 5);
    const vault = srv.add(100_000, 'vault', 9);
    const big = srv.add(900_000, 'drive', 1);
    srv.state.want = [photo, upd, vault, big].map(({ data: _data, ...w }) => w);
    let free = 1_000_000_000;
    const c = new HomeCache({
      reporter: makeReporter({ serverUrl: srv.url, apiToken: srv.token }),
      serverUrl: srv.url, apiToken: srv.token, stateDir, addresses: () => [{ address: '127.0.0.1', family: 4 }],
      freeBytes: () => free, syncMs: 3600_000, reportMs: 3600_000,
    });
    const cfg = normalizeCache({ enabled: true, path: `${root}/c`, maxBytes: 1, secret: SECRET, port: 18443 + Math.floor(Math.random() * 1000) }, { root });
    cfg.maxBytes = 1_000_000; // unter der Untergrenze, nur für den Test
    await c.apply(cfg);
    await c.sync();
    assert.equal(c.store.has(upd.sha256), true);
    assert.equal(c.store.has(photo.sha256), true);
    assert.equal(c.store.has(vault.sha256), false, 'vault off by default');
    assert.equal(c.store.has(big.sha256), false, 'does not fit next to higher priorities');
    let p = srv.state.posts.at(-1);
    assert.equal(p.full, true);
    assert.deepEqual(p.have.sort(), [upd.sha256, photo.sha256].sort());
    assert.equal(p.bytesFetched, 700_000);
    assert.equal(p.usedBytes, 700_000);

    // höhere Priorität verdrängt niedrigere
    const urgent = srv.add(500_000, 'updates', 20);
    srv.state.want = [urgent, upd, photo].map(({ data: _data, ...w }) => w);
    await c.sync();
    assert.equal(c.store.has(urgent.sha256), true);
    assert.equal(c.store.has(photo.sha256), false);
    p = srv.state.posts.at(-1);
    assert.equal(p.full, false);
    assert.deepEqual(p.have, [urgent.sha256]);
    assert.deepEqual(p.gone, [photo.sha256]);

    // Abgabe im LAN über den echten Endpunkt
    await c._reconcile();
    const tel = c.telemetry();
    assert.equal(tel.state, 'running');
    assert.match(tel.tlsSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(tel.urls, [`https://127.0.0.1:${cfg.port}`]);
    const ft = c.featureTelemetry();
    assert.deepEqual([ft.enabled, ft.state, ft.port, ft.url, ft.tlsSha256, ft.usedBytes], [true, 'running', cfg.port, tel.urls[0], tel.tlsSha256, 900_000]);
    const exp = String(Math.floor(Date.now() / 1000) + 60);
    const body = await new Promise((resolve, reject) => {
      https.get(`${tel.urls[0]}/blob/${upd.sha256}?exp=${exp}&sig=${sign(SECRET, upd.sha256, exp)}`, {
        ca: c.tls.cert, // selbstsigniert als Vertrauensanker + Pinning wie die Apps
        checkServerIdentity: (_h, cert) => (sha(cert.raw) === tel.tlsSha256 ? undefined : new Error('pin')),
      }, (res) => {
        const chunks = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    assert.equal(sha(body), upd.sha256);
    await c.report();
    p = srv.state.posts.at(-1);
    assert.equal(p.hits, 1);
    assert.equal(p.bytesServed, 400_000);

    // fehlgeschlagener Bericht → Zähler bleiben, nächster Bericht ist full
    srv.state.postStatus = 503;
    await c.report();
    srv.state.postStatus = 200;
    await c.report();
    assert.equal(srv.state.posts.at(-1).full, true);

    // wenig Platz auf dem Datenträger: Reserve bleibt frei
    free = 0;
    assert.equal(c.effectiveMax(), 0);
    assert.ok(c.featureTelemetry().enabled);
    // > 5000 Einträge: full-Bericht in Teilen
    for (let i = 0; i < 5003; i++) c.store.items.set(i.toString(16).padStart(64, '0'), { size: 1, kind: 'x', storedAt: 0, lastUsedAt: 0 });
    c.needFull = true;
    const n = srv.state.posts.length;
    await c.report();
    const parts = srv.state.posts.slice(n);
    assert.deepEqual(parts.map((x) => [x.full, x.have.length]), [[true, 5000], [false, 5]]); // 5005 Blobs gesamt
    for (let i = 0; i < 5003; i++) c.store.items.delete(i.toString(16).padStart(64, '0'));
    assert.equal(await c.clear(), 'accepted');
    assert.equal(c.store.count, 0);
    await c.apply(normalizeCache({ enabled: false }));
    assert.equal(c.telemetry(), null);
    assert.equal(await c.clear(), 'disabled');
    c.stop();
  });

  it('unusable path → path_unwritable in telemetry', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'file'), 'x');
    const c = new HomeCache({ reporter: { post: async () => ({ ok: true }) }, serverUrl: srv.url, apiToken: srv.token, stateDir: tmp(), addresses: () => [] });
    await c.apply(normalizeCache({ enabled: true, path: `${root}/file/sub`, secret: SECRET }, { root }));
    assert.equal(c.telemetry().state, 'path_unwritable');
    await c.apply(normalizeCache({ enabled: true, path: '/elsewhere', secret: SECRET }, { root }));
    assert.equal(c.telemetry().state, 'path_not_allowed');
    c.stop();
  });
});
