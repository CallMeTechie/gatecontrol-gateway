'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { ListManager, fetchList } = require('../src/dnsfilter-core/lists');
const { DnsFilter, searchDomains } = require('../src/dns/dns');
const { normalizeDns } = require('../src/dns/config');
const { DnsStats } = require('../src/dnsfilter-core/stats');
const { makeSelfSigned } = require('../src/cache/selfsigned');
const { createFeaturesRouter } = require('../src/api/routes/features');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dnsf-'));

async function listServer() {
  const tls = makeSelfSigned({ altNames: [{ dns: 'localhost' }] });
  const files = {
    '/ads.txt': { body: 'doubleclick.net\nads.example.com\n', etag: '"v1"' },
    '/hosts.txt': { body: '0.0.0.0 tracker.example.org\n' },
    '/empty.txt': { body: '# nur Kommentare\n' },
    '/huge.txt': { body: 'x'.repeat(4096) },
  };
  const hits = [];
  const srv = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    hits.push({ url: req.url, inm: req.headers['if-none-match'] || null });
    if (req.url === '/redirect-http') { res.writeHead(302, { location: 'http://localhost/ads.txt' }); return res.end(); }
    if (req.url === '/redirect-ok') { res.writeHead(301, { location: '/ads.txt' }); return res.end(); }
    const f = files[req.url];
    if (!f) { res.writeHead(404); return res.end(); }
    if (f.etag && req.headers['if-none-match'] === f.etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain', ...(f.etag ? { etag: f.etag } : {}) });
    return res.end(f.body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://localhost:${srv.address().port}`;
  const agent = new https.Agent({ ca: tls.cert });
  return { srv, base, files, hits, fetch: (u, d, o) => fetchList(u, d, { ...o, agent }), close: () => new Promise((r) => srv.close(r)) };
}

describe('dns: list manager', () => {
  let ls;
  before(async () => { ls = await listServer(); });
  after(() => ls.close());

  it('downloads, parses, keeps last good version, uses ETag (304)', async () => {
    const dir = tmp();
    let t = 1_000_000;
    let changes = 0;
    const m = new ListManager({ stateDir: dir, fetch: ls.fetch, now: () => t, rand: () => 0, onChange: () => changes++ });
    const catalog = { ads: { url: `${ls.base}/ads.txt`, format: 'domains', sha256: null }, hosts: { url: `${ls.base}/hosts.txt`, format: 'hosts', sha256: null } };
    await m.setWanted(catalog, new Set(['ads', 'hosts', 'unknown']));
    await m.refreshDue();
    assert.equal(m.lists.get('ads').size, 2);
    assert.ok(m.lists.get('hosts').matches('tracker.example.org'));
    assert.ok(changes >= 2);
    assert.ok(fs.existsSync(path.join(dir, 'dns-lists', 'ads.txt')));
    // nicht fällig → kein Abruf
    const n = ls.hits.length;
    await m.refreshDue();
    assert.equal(ls.hits.length, n);
    // nach 24 h: bedingter Abruf → 304, Liste bleibt
    t += 25 * 3600_000;
    await m.refreshDue();
    assert.equal(ls.hits.find((h) => h.url === '/ads.txt' && h.inm === '"v1"').inm, '"v1"');
    assert.equal(m.lists.get('ads').size, 2);
    // Neustart: Liste kommt von der Platte, ohne Abruf
    const m2 = new ListManager({ stateDir: dir, fetch: async () => { throw new Error('no network'); }, now: () => t });
    await m2.setWanted(catalog, new Set(['ads']));
    assert.equal(m2.lists.get('ads').size, 2);
    assert.equal(m2.lists.has('hosts'), false, 'unused list not loaded');
    // Liste aus dem Katalog entfernt → Datei weg
    await m2.setWanted({ ads: catalog.ads }, new Set(['ads']));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.existsSync(path.join(dir, 'dns-lists', 'hosts.txt')), false);
  });

  it('errors keep the old list; sha256 pin, empty list, size limit, http redirects', async () => {
    const dir = tmp();
    const m = new ListManager({ stateDir: dir, fetch: ls.fetch, now: () => 5, rand: () => 0 });
    const good = { url: `${ls.base}/ads.txt`, format: 'domains', sha256: null };
    await m.setWanted({ a: good }, new Set(['a']));
    await m.refreshDue();
    assert.equal(m.lists.get('a').size, 2);
    const sha = crypto.createHash('sha256').update(ls.files['/ads.txt'].body).digest('hex');
    for (const [c, code] of [
      [{ url: `${ls.base}/ads.txt`, format: 'domains', sha256: 'f'.repeat(64) }, 'sha256_mismatch'],
      [{ url: `${ls.base}/empty.txt`, format: 'domains', sha256: null }, 'empty'],
      [{ url: `${ls.base}/redirect-http`, format: 'domains', sha256: null }, 'not_https'],
      [{ url: `${ls.base}/missing.txt`, format: 'domains', sha256: null }, 'http_status'],
    ]) {
      const mm = new ListManager({ stateDir: tmp(), fetch: ls.fetch, now: () => 5, rand: () => 0 });
      await mm.setWanted({ b: c }, new Set(['b']));
      await mm.refreshDue();
      assert.equal(mm.lists.has('b'), false, code);
      assert.equal(mm.telemetry().b.error.code, code);
    }
    const pinned = new ListManager({ stateDir: tmp(), fetch: ls.fetch, now: () => 5, rand: () => 0 });
    await pinned.setWanted({ p: { ...good, url: `${ls.base}/redirect-ok`, sha256: sha } }, new Set(['p']));
    await pinned.refreshDue();
    assert.equal(pinned.lists.get('p').size, 2, 'same-origin https redirect + matching pin');
    const dest = path.join(tmp(), 'x');
    await assert.rejects(ls.fetch(`${ls.base}/huge.txt`, dest, { maxBytes: 100 }), (e) => e.code === 'too_large');
    assert.equal(fs.existsSync(dest), false);
    await assert.rejects(fetchList('http://example.com/list', dest), (e) => e.code === 'not_https');
  });
});

describe('dns: DnsFilter', () => {
  it('test(), query log only with logQueries, reports with give-back, telemetry', async () => {
    const posts = [];
    let ok = false;
    const reporter = { post: async (p, b) => { posts.push({ p, b }); return ok ? { ok: true } : { ok: false, status: 503 }; } };
    const f = new DnsFilter({
      reporter, stateDir: tmp(), serverUrl: 'https://gc.example.net', port: 0,
      addresses: () => [], neighbors: { macFor: async () => null }, localSuffixes: ['fritz.box'],
      lists: new ListManager({ stateDir: tmp(), fetch: async () => { throw Object.assign(new Error('x'), { code: 'network' }); } }),
      upstreamFactory: () => ({ state: { provider: 'quad9', dohDownUntil: 0 }, query: async () => { throw new Error('offline'); }, local: async () => { throw new Error('x'); }, close() {} }),
    });
    assert.equal(f.telemetry(), null);
    assert.equal(f.featureTelemetry().state, 'off');
    await f.apply(normalizeDns({ enabled: true, logQueries: true, profiles: [{ id: 'k', deny: ['tiktok.com'], macs: ['aa:bb:cc:dd:ee:01'] }, { id: 's' }], defaultProfile: 's' }));
    assert.deepEqual(f.test('www.TikTok.com', 'AA:BB:CC:DD:EE:01'), { domain: 'www.tiktok.com', profileId: 'k', action: 'block', reason: 'profile_deny' });
    assert.deepEqual(f.test('www.tiktok.com'), { domain: 'www.tiktok.com', profileId: 's', action: 'allow', reason: 'default' });
    assert.equal(f.test('gc.example.net').reason, 'always_allow', 'server host always allowed');
    assert.deepEqual(f.test('bad domain'), { error: 'invalid_domain' });
    assert.deepEqual(f.test('a.com', 'xx'), { error: 'invalid_mac' });

    const wire = require('../src/dnsfilter-core/wire');
    await f.resolver.handle(wire.buildQuery({ id: 1, name: 'tiktok.com', qtype: 1 }), { ip: '192.168.1.9' });
    await f.resolver.handle(wire.buildQuery({ id: 2, name: 'example.com', qtype: 1 }), { ip: '192.168.1.9' });
    assert.equal(f.queryLog({ limit: 10 }).length, 2);
    assert.equal(f.queryLog({ limit: 1 })[0].name, 'example.com', 'newest first');
    assert.equal(f.queryLog({ mac: 'aa:bb:cc:dd:ee:02' }).length, 0);

    await f.report();
    assert.equal(posts.at(-1).p, '/api/v1/gateway/dns');
    assert.equal(posts.at(-1).b.queries, 2);
    ok = true;
    await f.report();
    assert.equal(posts.at(-1).b.queries, 2, 'failed period merged into the next report');
    assert.equal(posts.at(-1).b.blocked, 0, 'tiktok.com is only denied for profile k');
    await f.report();
    assert.equal(posts.at(-1).b.queries, 0);

    await f._reconcile();
    const t = f.telemetry();
    assert.equal(t.state, 'no_address');
    assert.equal(t.logQueries, true);
    assert.equal(t.totals.queries, 2);

    await f.apply(normalizeDns({ enabled: true, logQueries: false, profiles: [] }));
    assert.equal(f.queryLog().length, 0, 'switching logging off clears the log');
    await f.apply(normalizeDns({ enabled: false }));
    assert.equal(f.telemetry(), null);
    f.stop();
  });

  it('searchDomains from resolv.conf', () => {
    assert.deepEqual(searchDomains('nameserver 192.168.178.1\nsearch fritz.box Home.Lan\n# x\ndomain lan\n'), ['fritz.box', 'home.lan', 'lan']);
  });

  it('stats: top blocked limited to 20, per profile, give back', () => {
    let t = 0;
    const s = new DnsStats({ now: () => t });
    for (let i = 0; i < 30; i++) for (let j = 0; j <= i; j++) s.record({ profileId: 'p', mac: 'aa:aa:aa:aa:aa:aa', blocked: true, domain: `d${i}.example`, ms: 2 });
    s.record({ profileId: 'q', blocked: false, cached: true, ms: 0 });
    t = 300_000;
    const { body, period } = s.take();
    assert.equal(body.topBlocked.length, 20);
    assert.deepEqual(body.topBlocked[0], { domain: 'd29.example', count: 30, profileId: 'p' });
    assert.deepEqual(body.byProfile.q, { queries: 1, blocked: 0 });
    assert.deepEqual(body.period, { from: 0, to: 300_000 });
    s.giveBack(period);
    s.record({ profileId: 'p', blocked: true, domain: 'd29.example', ms: 1 });
    const again = s.take().body;
    assert.equal(again.period.from, 0);
    assert.equal(again.topBlocked[0].count, 31);
  });
});

describe('dns: management API', () => {
  let server;
  let base;
  const dns = { cfg: { enabled: false }, test: (d, m) => (d === 'bad' ? { error: 'invalid_domain' } : { domain: d, mac: m || null, profileId: 'p', action: 'allow', reason: 'default' }), queryLog: (o) => [o] };
  const cache = { requestSync: () => 'busy', clear: async () => 'accepted' };
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createFeaturesRouter({ featureMgr: { dns, cache, netwatch: {}, inetq: {} } }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });
  after(() => new Promise((r) => server.close(r)));
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  it('503 while off, 403 without logQueries, validates input', async () => {
    assert.deepEqual(await call('POST', '/dns/test', { domain: 'a.com' }), { status: 503, body: { error: 'feature_disabled' } });
    assert.equal((await call('GET', '/dns/log')).status, 503);
    dns.cfg = { enabled: true, logQueries: false };
    assert.deepEqual(await call('GET', '/dns/log'), { status: 403, body: { error: 'log_disabled' } });
    dns.cfg.logQueries = true;
    assert.deepEqual((await call('GET', '/dns/log?limit=5&mac=AA-BB-CC-DD-EE-FF')).body, { entries: [{ limit: 5, mac: 'AA-BB-CC-DD-EE-FF' }] });
    assert.equal((await call('GET', '/dns/log?mac=zz')).status, 400);
    assert.equal((await call('GET', '/dns/log?limit=abc')).body.entries[0].limit, 100);
    assert.deepEqual((await call('POST', '/dns/test', { domain: 'a.com', mac: 'aa:bb:cc:dd:ee:ff' })).body, { domain: 'a.com', mac: 'aa:bb:cc:dd:ee:ff', profileId: 'p', action: 'allow', reason: 'default' });
    assert.deepEqual(await call('POST', '/dns/test', { domain: 'bad' }), { status: 400, body: { error: 'invalid_domain' } });
    assert.equal((await call('POST', '/dns/test', { domain: 5 })).status, 400);
  });

  it('cache sync/clear', async () => {
    assert.deepEqual(await call('POST', '/cache/sync', {}), { status: 409, body: { error: 'sync_running' } });
    assert.deepEqual(await call('POST', '/cache/clear', {}), { status: 202, body: { accepted: true } });
  });
});
