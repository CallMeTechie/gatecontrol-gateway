'use strict';

// DNS-Filter gegen echte UDP-/TCP-Anfragen: Listener + Resolver + DoH-Client
// gegen eine lokale DoH-Gegenstelle, Rückfall auf einen lokalen „Router“.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const wire = require('../src/dns/wire');
const { DnsListener, lanListenAddresses } = require('../src/dns/server');
const { Resolver } = require('../src/dns/resolver');
const { Policy } = require('../src/dns/policy');
const { normalizeDns } = require('../src/dns/config');
const { DohClient, Upstream, udpQuery, tcpQuery, routerQuery } = require('../src/dns/upstream');
const { DnsStats } = require('../src/dns/stats');
const { parseListText } = require('../src/dns/listParser');
const { startDoh, startRouter } = require('./helpers/dnsFakes');

const TABLE = {
  'example.com': { A: ['93.184.216.34'], AAAA: ['26062800022000010248189325c81946'], ttl: 120 },
  'forcesafesearch.google.com': { A: ['216.239.38.120'] },
  'strict.bing.com': { CNAME: 'edge.bing.example' },
  'edge.bing.example': { A: ['150.171.28.16'] },
  'big.example': { TXT: Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(60, 'x')) },
  'fail.example': { rcode: wire.RCODE.SERVFAIL },
  'nas.fritz.box': { A: ['192.168.178.20'] },
};
const KID = 'aa:bb:cc:00:00:01';

async function freePort() {
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  const p = s.address().port;
  s.close();
  return p;
}

const ask = (port, name, qtype = wire.TYPE.A, { tcp = false, edns = null, id = 4242 } = {}) => {
  const q = wire.buildQuery({ id, name, qtype, edns });
  return (tcp ? tcpQuery : udpQuery)('127.0.0.1', q, { port, timeoutMs: 4000 }).then((r) => ({ raw: r, ...wire.parseResponse(r) }));
};

describe('dns: wire', () => {
  it('parseQuery: EDNS, DO bit, odd names, malformed input', () => {
    const q = wire.parseQuery(wire.buildQuery({ id: 9, name: 'Ex.Com', qtype: 28, edns: { do: true }, cd: true }));
    assert.equal(q.id, 9);
    assert.equal(q.name, 'ex.com');
    assert.equal(q.qtype, 28);
    assert.deepEqual(q.edns, { udpSize: 1232, do: true, version: 0 });
    assert.equal(q.cd, true);
    assert.equal(wire.parseQuery(Buffer.alloc(5)), null);
    assert.equal(wire.parseQuery('nope'), null);
    const resp = wire.buildResponse(q, {});
    assert.equal(wire.parseQuery(resp), null, 'responses are not queries');
    // Label mit Punkt → nameOk false
    const odd = Buffer.from(wire.buildQuery({ id: 1, name: 'abc.de', qtype: 1 }));
    odd[13] = 0x2e;
    assert.equal(wire.parseQuery(odd).nameOk, false);
    // Kompressionszeiger in der Frage → keine Frage
    const ptr = Buffer.from('0001010000010000000000000c' + 'c00c00010001', 'hex');
    assert.equal(wire.parseQuery(ptr).question, null);
  });

  it('adaptResponse: id, original question case, TTL ageing', () => {
    const q = wire.parseQuery(wire.buildQuery({ id: 1, name: 'example.com', qtype: 1 }));
    const r = wire.buildResponse(q, { answers: [{ name: 'example.com', type: 1, ttl: 100, rdata: wire.ipv4Rdata('1.2.3.4') }] });
    const meta = wire.parseResponse(r);
    const client = wire.parseQuery(wire.buildQuery({ id: 77, name: 'ExAmPle.COM', qtype: 1 }));
    const out = wire.adaptResponse(r, { id: 77, question: client.question, ttlOffsets: meta.ttlOffsets, ageSec: 30 });
    const m = wire.parseResponse(out);
    assert.equal(m.id, 77);
    assert.equal(m.answers[0].ttl, 70);
    assert.ok(out.includes(Buffer.from('ExAmPle')));
    assert.equal(wire.parseResponse(wire.adaptResponse(r, { id: 1, ttlOffsets: meta.ttlOffsets, ageSec: 500 })).answers[0].ttl, 0);
  });
});

describe('dns: upstream', () => {
  let doh;
  let router;
  before(async () => {
    doh = await startDoh(TABLE);
    router = await startRouter(TABLE);
  });
  after(async () => { await doh.close(); await router.close(); });

  it('DoH over HTTP/2 with pinned IP and hostname check; reuses the session', async () => {
    const c = new DohClient({ url: doh.url, ips: ['127.0.0.1'], tlsOptions: { ca: doh.ca } });
    const r1 = wire.parseResponse(await c.query(wire.buildQuery({ id: 5, name: 'example.com', qtype: 1 })));
    const r2 = wire.parseResponse(await c.query(wire.buildQuery({ id: 6, name: 'example.com', qtype: 28 })));
    assert.equal(r1.answers[0].rdata.join('.'), '93.184.216.34');
    assert.equal(r2.answers[0].type, 28);
    assert.equal(doh.seen.at(-1).headers['content-type'], 'application/dns-message');
    assert.equal(doh.seen.at(-1).body.readUInt16BE(0), 0, 'DoH id = 0 (RFC 8484)');
    c.close();
  });

  it('DoH refuses a certificate that does not match', async () => {
    const c = new DohClient({ url: doh.url.replace('localhost', 'dns.quad9.net'), port: doh.port, ips: ['127.0.0.1'], tlsOptions: { ca: doh.ca }, timeoutMs: 2000 });
    await assert.rejects(c.query(wire.buildQuery({ name: 'example.com', qtype: 1 })), (e) => e.code === 'connect');
    c.close();
  });

  it('router: UDP, then TCP when truncated', async () => {
    const r = wire.parseResponse(await routerQuery('127.0.0.1', wire.buildQuery({ name: 'big.example', qtype: wire.TYPE.TXT }), { port: router.port }));
    assert.equal(r.answers.length, 12);
    assert.ok(router.seen.tcp >= 1);
  });

  it('Upstream falls back to the router when DoH fails; circuit opens after 3 failures', async () => {
    doh.server.status = 503;
    let t = 1000;
    const u = new Upstream({
      upstream: { provider: 'custom', url: doh.url, fallbackRouter: true },
      doh: new DohClient({ url: doh.url, ips: ['127.0.0.1'], tlsOptions: { ca: doh.ca } }),
      routerIp: () => '127.0.0.1',
      routerQueryFn: (ip, w) => routerQuery(ip, w, { port: router.port }),
      now: () => t,
    });
    const before = doh.seen.length;
    for (let i = 0; i < 3; i++) {
      const r = await u.query(wire.buildQuery({ name: 'example.com', qtype: 1 }));
      assert.equal(r.via, 'router');
    }
    assert.equal(doh.seen.length - before, 3);
    const r = await u.query(wire.buildQuery({ name: 'example.com', qtype: 1 }));
    assert.equal(r.via, 'router');
    assert.equal(doh.seen.length - before, 3, 'DoH skipped while marked down');
    assert.ok(u.state.dohDownUntil > t);
    doh.server.status = 200;
    t += 61_000;
    assert.equal((await u.query(wire.buildQuery({ name: 'example.com', qtype: 1 }))).via, 'doh');
    // Schleifenschutz und fallbackRouter=false
    doh.server.status = 503;
    await assert.rejects(u.query(wire.buildQuery({ name: 'example.com', qtype: 1 }), { fromIp: '127.0.0.1' }));
    u.cfg = { ...u.cfg, fallbackRouter: false };
    await assert.rejects(u.query(wire.buildQuery({ name: 'example.com', qtype: 1 })));
    doh.server.status = 200;
    u.close();
  });
});

describe('dns: listener + resolver over real UDP/TCP', () => {
  let doh;
  let router;
  let listener;
  let resolver;
  let port;
  let stats;
  let upstream;
  let mac = null;
  before(async () => {
    doh = await startDoh(TABLE);
    router = await startRouter(TABLE);
    const lists = new Map([['ads', (await parseListText('doubleclick.net\n', 'domains')).list]]);
    const cfg = normalizeDns({
      enabled: true,
      lists: { ads: { url: 'https://x.example/l', format: 'domains' } },
      profiles: [{ id: 'std', lists: ['ads'] }, { id: 'kids', safeSearch: true, deny: ['tiktok.com'], macs: [KID] }],
      defaultProfile: 'std',
    });
    const policy = new Policy(cfg, { lists });
    upstream = new Upstream({
      upstream: cfg.upstream,
      doh: new DohClient({ url: doh.url, ips: ['127.0.0.1'], tlsOptions: { ca: doh.ca } }),
      routerIp: () => '127.0.0.53', // Fake-Router lauscht auf 127.0.0.1 (routerQueryFn)
      routerQueryFn: (_ip, w) => routerQuery('127.0.0.1', w, { port: router.port }),
    });
    stats = new DnsStats();
    resolver = new Resolver({ getPolicy: () => policy, upstream, stats, neighbors: { macFor: async () => mac }, logEnabled: () => true });
    port = await freePort();
    listener = new DnsListener({ handle: (m, o) => resolver.handle(m, { ...o, ip: mac ? '192.168.1.50' : o.ip }), port, addresses: () => [{ address: '127.0.0.1', family: 4 }] });
    const st = await listener.reconcile();
    assert.equal(st.state, 'running');
  });
  after(async () => { listener.close(); upstream.close(); await doh.close(); await router.close(); });

  it('forwards allowed names (UDP and TCP), keeps the client id', async () => {
    const r = await ask(port, 'example.com', wire.TYPE.A, { id: 999 });
    assert.equal(r.rcode, 0);
    assert.equal(r.id, r.raw.readUInt16BE(0));
    assert.equal(r.answers[0].rdata.join('.'), '93.184.216.34');
    const t = await ask(port, 'example.com', wire.TYPE.AAAA, { tcp: true });
    assert.equal(t.answers[0].type, wire.TYPE.AAAA);
  });

  it('caches answers (second query does not reach DoH, TTL counts down)', async () => {
    await ask(port, 'example.com', wire.TYPE.A);
    const n = doh.seen.length;
    const r = await ask(port, 'example.com', wire.TYPE.A);
    assert.equal(doh.seen.length, n);
    assert.ok(r.answers[0].ttl <= 120);
    assert.equal(resolver.log.at(-1).cached, true);
  });

  it('blocks list entries with 0.0.0.0 / :: / NODATA and an EDE', async () => {
    const a = await ask(port, 'ads.doubleclick.net', wire.TYPE.A);
    assert.equal(a.answers[0].rdata.join('.'), '0.0.0.0');
    const aaaa = await ask(port, 'ads.doubleclick.net', wire.TYPE.AAAA, { tcp: true });
    assert.equal(aaaa.answers[0].rdata.toString('hex'), '0'.repeat(32));
    const txt = await ask(port, 'ads.doubleclick.net', wire.TYPE.TXT, { edns: { do: false } });
    assert.equal(txt.rcode, 0);
    assert.equal(txt.answers.length, 0);
    assert.ok(txt.raw.includes(Buffer.from([0x00, 0x0f, 0x00, 0x02, 0x00, 0x0f])), 'EDE 15 (Blocked)');
  });

  it('per-MAC profile with safe search (CNAME + addresses, chain followed)', async () => {
    mac = KID;
    try {
      const g = await ask(port, 'www.google.de', wire.TYPE.A);
      assert.deepEqual(g.answers.map((x) => [x.name, x.type]), [['www.google.de', 5], ['forcesafesearch.google.com', 1]]);
      assert.equal(g.answers[0].target, 'forcesafesearch.google.com');
      const b = await ask(port, 'www.bing.com', wire.TYPE.A);
      assert.deepEqual(b.answers.map((x) => x.target || x.rdata.join('.')), ['strict.bing.com', 'edge.bing.example', '150.171.28.16']);
      const h = await ask(port, 'www.google.de', wire.TYPE.HTTPS);
      assert.equal(h.answers.length, 0, 'HTTPS records of search engines are emptied');
      assert.equal((await ask(port, 'tiktok.com', wire.TYPE.A)).answers[0].rdata.join('.'), '0.0.0.0');
      assert.equal(resolver.log.at(-1).mac, KID);
    } finally { mac = null; }
  });

  it('local names go to the router; upstream SERVFAIL is passed on; NXDOMAIN', async () => {
    const before = router.seen.udp;
    const r = await ask(port, 'nas.fritz.box', wire.TYPE.A);
    assert.equal(r.answers[0].rdata.join('.'), '192.168.178.20');
    assert.equal(router.seen.udp, before + 1);
    assert.equal((await ask(port, 'fail.example')).rcode, wire.RCODE.SERVFAIL);
    assert.equal((await ask(port, 'nothing.example')).rcode, wire.RCODE.NXDOMAIN);
  });

  it('UDP answers larger than 512 bytes are truncated (TC), full over TCP or with EDNS', async () => {
    const u = await ask(port, 'big.example', wire.TYPE.TXT);
    assert.equal(u.tc, true);
    assert.equal(u.answers.length, 0);
    assert.equal((await ask(port, 'big.example', wire.TYPE.TXT, { tcp: true })).answers.length, 12);
    assert.equal((await ask(port, 'big.example', wire.TYPE.TXT, { edns: { do: false } })).answers.length, 12);
  });

  it('refuses non-IN classes, answers NOTIMP for other opcodes, drops garbage', async () => {
    const q = Buffer.from(wire.buildQuery({ id: 3, name: 'version.bind', qtype: 16, qclass: 3 }));
    const r = wire.parseResponse(await udpQuery('127.0.0.1', q, { port }));
    assert.equal(r.rcode, wire.RCODE.REFUSED);
    const op = Buffer.from(wire.buildQuery({ id: 4, name: 'example.com', qtype: 1 }));
    op.writeUInt16BE(op.readUInt16BE(2) | (2 << 11), 2);
    assert.equal(wire.parseResponse(await udpQuery('127.0.0.1', op, { port })).rcode, wire.RCODE.NOTIMP);
    await assert.rejects(udpQuery('127.0.0.1', Buffer.from('short'), { port, timeoutMs: 300 }), (e) => e.code === 'timeout');
  });

  it('TCP pipelining: several queries on one connection', async () => {
    const net = require('node:net');
    const msgs = [1, 2, 3].map((i) => wire.buildQuery({ id: 100 + i, name: 'example.com', qtype: 1 }));
    const framed = Buffer.concat(msgs.map((m) => { const l = Buffer.alloc(2); l.writeUInt16BE(m.length, 0); return Buffer.concat([l, m]); }));
    const ids = await new Promise((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port }, () => c.write(framed));
      let buf = Buffer.alloc(0);
      const got = [];
      c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
          got.push(buf.readUInt16BE(2));
          buf = buf.subarray(2 + buf.readUInt16BE(0));
        }
        if (got.length === 3) { c.destroy(); resolve(got.sort()); }
      });
      c.on('error', reject);
    });
    assert.deepEqual(ids, [101, 102, 103]);
  });

  it('stats count queries, blocks and cache hits', () => {
    const { body } = stats.take();
    assert.ok(body.queries >= 10);
    assert.ok(body.blocked >= 4);
    assert.ok(body.cached >= 1);
    assert.equal(body.topBlocked[0].domain, 'ads.doubleclick.net');
    assert.ok(body.byProfile.std.queries > 0 && body.byProfile.kids.blocked >= 1);
    assert.deepEqual(body.clientsSeen, [KID]);
    assert.equal(typeof body.avgMs, 'number');
  });

  it('port busy → state port_busy, nothing forced; frees up later', async () => {
    const blocker = dgram.createSocket('udp4');
    const p2 = await freePort();
    await new Promise((r) => blocker.bind(p2, '127.0.0.1', r));
    const l2 = new DnsListener({ handle: async () => null, port: p2, addresses: () => [{ address: '127.0.0.1', family: 4 }] });
    assert.equal((await l2.reconcile()).state, 'port_busy');
    blocker.close();
    assert.equal((await l2.reconcile()).state, 'running');
    l2.close();
    const l3 = new DnsListener({ handle: async () => null, port: p2, addresses: () => [] });
    assert.equal((await l3.reconcile()).state, 'no_address');
  });

  it('lanListenAddresses: private IPv4, ULA and link-local only, never tunnel/docker', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.1.23', family: 'IPv4', internal: false },
        { address: 'fd00::ba27:ebff:fe12:3456', family: 'IPv6', internal: false },
        { address: 'fe80::ba27:ebff:fe12:3456', family: 'IPv6', internal: false },
        { address: '2a02:810::1', family: 'IPv6', internal: false },
      ],
      wlan0: [{ address: '84.1.2.3', family: 'IPv4', internal: false }],
      gatecontrol0: [{ address: '10.8.0.14', family: 'IPv4', internal: false }],
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    };
    assert.deepEqual(lanListenAddresses({ ifaces }).map((a) => a.address), ['192.168.1.23', 'fd00::ba27:ebff:fe12:3456', 'fe80::ba27:ebff:fe12:3456%eth0']);
    assert.deepEqual(lanListenAddresses({ ifaces, linkLocal: false, exclude: ['192.168.1.23'] }).map((a) => a.address), ['fd00::ba27:ebff:fe12:3456']);
  });
});
