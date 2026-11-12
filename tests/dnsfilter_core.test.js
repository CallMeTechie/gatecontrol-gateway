'use strict';

// Engine des DNS-Filters (src/dnsfilter-core): in sich geschlossen (der
// GateControl-Server spiegelt das Verzeichnis, siehe VENDORED.md) und EDNS
// Client Subnet als Client-Adresse – im Gateway aus.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { builtinModules } = require('node:module');
const core = require('../src/dnsfilter-core');
const { DnsFilter } = require('../src/dns/dns');
const { normalizeDns } = require('../src/dns/config');

const { wire, Policy, Resolver, DnsStats } = core;
const DIR = path.join(__dirname, '..', 'src', 'dnsfilter-core');

describe('dnsfilter-core: self-contained', () => {
  const files = fs.readdirSync(DIR, { recursive: true }).map(String).filter((f) => f.endsWith('.js'));

  it('requires only node: modules and files inside the directory', () => {
    assert.ok(files.includes('index.js') && files.length >= 12);
    let seen = 0;
    for (const f of files) {
      const src = fs.readFileSync(path.join(DIR, f), 'utf8');
      // jedes require/import – auch dynamisch – muss ein festes Literal sein
      const calls = src.match(/\b(?:require|import)\s*\(/g) || [];
      const literal = [...src.matchAll(/\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
      assert.equal(literal.length, calls.length, `${f}: require/import with a non-literal argument`);
      assert.ok(!/^\s*import\s[^(]/m.test(src), `${f}: ESM import`);
      for (const spec of literal) {
        seen++;
        if (spec.startsWith('node:')) {
          assert.ok(builtinModules.includes(spec.slice(5)), `${f}: unknown builtin ${spec}`);
          continue;
        }
        assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${f}: "${spec}" is neither node: nor relative`);
        const target = path.resolve(DIR, path.dirname(f), spec);
        assert.ok(target.startsWith(DIR + path.sep), `${f}: "${spec}" leaves the directory`);
        assert.ok(fs.existsSync(target.endsWith('.js') ? target : `${target}.js`) || fs.existsSync(path.join(target, 'index.js')), `${f}: "${spec}" not found`);
      }
    }
    assert.ok(seen > 20);
  });

  it('ships the note for the mirrored copy and no other file types', () => {
    assert.ok(fs.existsSync(path.join(DIR, 'VENDORED.md')));
    for (const f of fs.readdirSync(DIR, { recursive: true }).map(String)) {
      if (fs.statSync(path.join(DIR, f)).isDirectory()) continue;
      assert.ok(f.endsWith('.js') || f === 'VENDORED.md', `unexpected file ${f}`);
    }
  });

  it('index exports the parts a filter service needs', () => {
    for (const k of ['wire', 'ListManager', 'Policy', 'Resolver', 'ResponseCache', 'Upstream', 'DohClient', 'DnsListener', 'DnsStats', 'cleanDomain', 'safeSearchTarget']) {
      assert.ok(core[k], k);
    }
  });
});

describe('dnsfilter-core: EDNS Client Subnet (wire)', () => {
  const q = (ecs, extra = {}) => wire.parseQuery(wire.buildQuery({ id: 7, name: 'example.com', qtype: wire.TYPE.A, edns: { do: false, ecs }, ...extra }));

  it('reads IPv4 and IPv6 addresses as dnsmasq sends them (add-subnet=32,128)', () => {
    assert.deepEqual(q({ address: '10.8.0.7' }).edns.ecs, { family: 4, sourcePrefix: 32, scopePrefix: 0, address: '10.8.0.7' });
    assert.deepEqual(q({ address: 'fd00:0:0:1::2a' }).edns.ecs, { family: 6, sourcePrefix: 128, scopePrefix: 0, address: 'fd00:0:0:1::2a' });
    assert.equal(q({ address: '::1' }).edns.ecs.address, '::1');
    assert.equal(q({ address: '2001:db8::' }).edns.ecs.address, '2001:db8::');
    assert.equal(q({ address: '2001:db8:1:2:3:4:5:6' }).edns.ecs.address, '2001:db8:1:2:3:4:5:6');
  });

  it('reads shortened prefixes, padded with zeros', () => {
    assert.deepEqual(q({ address: '192.168.77.9', sourcePrefix: 24 }).edns.ecs, { family: 4, sourcePrefix: 24, scopePrefix: 0, address: '192.168.77.0' });
    assert.equal(q({ address: '192.168.77.255', sourcePrefix: 20 }).edns.ecs.address, '192.168.64.0');
    assert.equal(q({ address: '2001:db8:abcd::1', sourcePrefix: 56 }).edns.ecs.address, '2001:db8:abcd::');
    assert.equal(q({ address: '1.2.3.4', sourcePrefix: 0 }).edns.ecs.address, '0.0.0.0');
  });

  it('no option → edns without ecs (unchanged shape)', () => {
    const p = wire.parseQuery(wire.buildQuery({ name: 'example.com', qtype: 1, edns: { do: true } }));
    assert.deepEqual(p.edns, { udpSize: 1232, do: true, version: 0 });
    assert.equal(wire.parseQuery(wire.buildQuery({ name: 'example.com', qtype: 1 })).edns, null);
  });

  it('finds the option behind other options', () => {
    const base = wire.buildQuery({ name: 'example.com', qtype: 1 });
    base.writeUInt16BE(1, 10);
    const cookie = Buffer.from([0, 10, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8]);
    const rdata = Buffer.concat([cookie, wire.ecsOption({ address: '10.8.0.9' })]);
    const h = Buffer.alloc(11);
    h.writeUInt16BE(wire.TYPE.OPT, 1);
    h.writeUInt16BE(1232, 3);
    h.writeUInt16BE(rdata.length, 9);
    assert.equal(wire.parseQuery(Buffer.concat([base, h, rdata])).edns.ecs.address, '10.8.0.9');
  });

  it('ignores malformed options without failing the query', () => {
    const withOpt = (opt) => {
      const base = wire.buildQuery({ name: 'example.com', qtype: 1 });
      base.writeUInt16BE(1, 10);
      const h = Buffer.alloc(11);
      h.writeUInt16BE(wire.TYPE.OPT, 1);
      h.writeUInt16BE(1232, 3);
      h.writeUInt16BE(opt.length, 9);
      return wire.parseQuery(Buffer.concat([base, h, opt]));
    };
    const good = wire.ecsOption({ address: '10.8.0.9' });
    const cases = {
      family: Buffer.from(good).fill(3, 5, 6),
      prefixTooLong: (() => { const b = Buffer.from(good); b[6] = 33; return b; })(),
      lengthMismatch: (() => { const b = Buffer.from(good); b[6] = 24; return b; })(),
      bitsBehindPrefix: (() => { const b = wire.ecsOption({ address: '10.8.0.0', sourcePrefix: 20 }); b[10] |= 0x01; return b; })(),
      tooShort: Buffer.from([0, 8, 0, 2, 0, 1]),
      overrun: Buffer.from([0, 8, 0, 40, 0, 1, 32, 0]),
    };
    for (const [name, opt] of Object.entries(cases)) {
      const p = withOpt(opt);
      assert.ok(p && p.name === 'example.com', name);
      assert.equal(p.edns.ecs, undefined, name);
    }
  });
});

describe('dnsfilter-core: client from ECS (resolver)', () => {
  const PEER = '10.8.0.7';
  const cfg = {
    alwaysAllow: [], categories: {}, defaultProfile: 'std', pauses: [{ clients: ['peer:9'], until: 2_000_000 }], extensions: [],
    profiles: [
      { id: 'std', allow: [], deny: [], lists: [], schedules: [], macs: [] },
      { id: 'kids', allow: [], deny: ['tiktok.com'], lists: [], schedules: [], macs: [PEER], clients: ['peer:7'] },
    ],
  };
  const setup = (opts = {}) => {
    const sent = [];
    const upstream = {
      query: async (w, o) => {
        sent.push({ w, o });
        const p = wire.parseQuery(w);
        return { wire: wire.buildResponse(p, { answers: [{ name: p.name, type: wire.TYPE.A, ttl: 60, rdata: wire.ipv4Rdata('1.2.3.4') }] }), via: 'doh' };
      },
      local: async () => { throw new Error('no router'); },
    };
    const stats = new DnsStats();
    const resolver = new Resolver({ getPolicy: () => new Policy(cfg), upstream, stats, now: () => 1_000_000, logEnabled: () => true, ...opts });
    const ask = async (name, { ip = '127.0.0.1', ecs = null } = {}) => {
      const out = await resolver.handle(wire.buildQuery({ id: 5, name, qtype: wire.TYPE.A, edns: ecs ? { do: false, ecs } : null }), { ip, udp: true });
      const r = wire.parseResponse(out);
      return { blocked: r.answers.length === 1 && r.answers[0].rdata.equals(Buffer.alloc(4)), log: resolver.log.at(-1), raw: out };
    };
    return { resolver, ask, sent, stats };
  };

  it('off (gateway): ECS is ignored, the sender counts', async () => {
    const { ask } = setup({ neighbors: { macFor: async (ip) => (ip === '192.168.1.50' ? PEER : null) } });
    const viaEcs = await ask('tiktok.com', { ip: '192.168.1.9', ecs: { address: PEER } });
    assert.equal(viaEcs.blocked, false);
    assert.deepEqual([viaEcs.log.profileId, viaEcs.log.mac, viaEcs.log.ip], ['std', null, '192.168.1.9']);
    const loop = await ask('tiktok.com', { ecs: { address: PEER } });
    assert.deepEqual([loop.blocked, loop.log.profileId, loop.log.ip], [false, 'std', '127.0.0.1']);
    const direct = await ask('tiktok.com', { ip: '192.168.1.50' });
    assert.deepEqual([direct.blocked, direct.log.profileId, direct.log.mac], [true, 'kids', PEER]);
  });

  it('on: the address from ECS selects the profile (address as key)', async () => {
    const { ask, stats } = setup({ ecsClient: true });
    const kid = await ask('tiktok.com', { ecs: { address: PEER } });
    assert.deepEqual([kid.blocked, kid.log.profileId, kid.log.mac, kid.log.ip], [true, 'kids', PEER, PEER]);
    const other = await ask('tiktok.com', { ecs: { address: '10.8.0.8' } });
    assert.deepEqual([other.blocked, other.log.profileId, other.log.mac], [false, 'std', '10.8.0.8']);
    assert.deepEqual(stats.take().body.clientsSeen, [PEER, '10.8.0.8']);
  });

  it('on: clientFor maps the address to a key (profiles, pauses)', async () => {
    const peers = { [PEER]: 'peer:7', '10.8.0.9': 'peer:9', 'fd00::9': 'peer:9' };
    const { ask } = setup({ ecsClient: true, clientFor: async (ip) => peers[ip] || null });
    const kid = await ask('tiktok.com', { ecs: { address: PEER } });
    assert.deepEqual([kid.blocked, kid.log.profileId, kid.log.mac], [true, 'kids', 'peer:7']);
    const paused = await ask('example.com', { ecs: { address: '10.8.0.9' } });
    assert.deepEqual([paused.blocked, paused.log.reason, paused.log.mac], [true, 'paused', 'peer:9']);
    const v6 = await ask('example.com', { ecs: { address: 'fd00::9' } });
    assert.deepEqual([v6.log.reason, v6.log.ip], ['paused', 'fd00::9']);
    const unknown = await ask('tiktok.com', { ecs: { address: '10.8.0.99' } });
    assert.deepEqual([unknown.blocked, unknown.log.profileId, unknown.log.mac], [false, 'std', null]);
  });

  it('on: only full addresses from a loopback sender are taken', async () => {
    const { ask } = setup({ ecsClient: true });
    const foreign = await ask('tiktok.com', { ip: '10.8.0.50', ecs: { address: PEER } });
    assert.deepEqual([foreign.blocked, foreign.log.mac, foreign.log.ip], [false, '10.8.0.50', '10.8.0.50']);
    const subnet = await ask('tiktok.com', { ecs: { address: PEER, sourcePrefix: 24 } });
    assert.deepEqual([subnet.blocked, subnet.log.mac, subnet.log.ip], [false, null, '127.0.0.1']);
    const none = await ask('tiktok.com');
    assert.deepEqual([none.blocked, none.log.profileId, none.log.mac], [false, 'std', null]);
    const self = await ask('tiktok.com', { ecs: { address: '127.0.0.1' } });
    assert.deepEqual([self.blocked, self.log.mac], [false, null]);
  });

  it('on with a function: the caller decides which senders may set ECS', async () => {
    const { ask } = setup({ ecsClient: (ip) => ip === '10.8.0.1' });
    assert.equal((await ask('tiktok.com', { ip: '10.8.0.1', ecs: { address: PEER } })).blocked, true);
    assert.equal((await ask('tiktok.com', { ip: '127.0.0.1', ecs: { address: PEER } })).blocked, false);
  });

  it('ECS never leaves the engine; loop protection keeps the real sender', async () => {
    const { ask, sent } = setup({ ecsClient: true });
    const r = await ask('example.com', { ecs: { address: PEER } });
    assert.equal(sent.length, 1);
    assert.equal(wire.parseQuery(sent[0].w).edns.ecs, undefined);
    assert.equal(sent[0].o.fromIp, '127.0.0.1');
    assert.equal(wire.parseQuery(Buffer.concat([r.raw.subarray(0, 2), Buffer.from([0x01, 0x00]), r.raw.subarray(4)])).edns.ecs, undefined);
  });
});

describe('dnsfilter-core: gateway wiring', () => {
  it('policy reads `clients` like `macs`; gateway config keeps using macs', () => {
    const p = new Policy({
      alwaysAllow: [], categories: {}, defaultProfile: null, extensions: [{ macs: ['aa:bb:cc:00:00:02'], clients: ['c2'], until: 50 }], pauses: [],
      profiles: [{ id: 'a', allow: [], deny: [], lists: [], schedules: [], macs: ['aa:bb:cc:00:00:01'], clients: ['c1'] }, { id: 'b', allow: [], deny: [], lists: [], schedules: [], clients: ['c1', 'c3'] }],
    });
    assert.equal(p.profileFor('aa:bb:cc:00:00:01').id, 'a');
    assert.equal(p.profileFor('c1').id, 'a');
    assert.equal(p.profileFor('c3').id, 'b');
    assert.equal(p.profileFor('c9'), null);
    assert.equal(p.extendedUntil('c2', 10), 50);
    assert.equal(p.extendedUntil('aa:bb:cc:00:00:02', 10), 50);
    const gw = new Policy(normalizeDns({ enabled: true, profiles: [{ id: 'k', macs: ['AA-BB-CC-00-00-01'] }] }));
    assert.equal(gw.profileFor('aa:bb:cc:00:00:01').id, 'k');
  });

  it('the gateway filter does not take the client from ECS', async () => {
    const f = new DnsFilter({
      reporter: { post: async () => ({ ok: true }) }, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gc-dnscore-')),
      neighbors: { macFor: async () => null }, addresses: () => [], localSuffixes: [],
    });
    assert.equal(f.resolver.ecsClient, false);
    assert.equal(f.resolver.clientFor, null);
    assert.equal(typeof f.lists.logger.info, 'function');
  });
});
