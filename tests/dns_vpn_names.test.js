'use strict';

// „Namen im VPN“ im Heimnetz: die Zonen der VPN-Gerätenamen gehen durch den
// Tunnel an den DNS des Servers oder bekommen NXDOMAIN – nie an DoH/Router.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wire = require('../src/dnsfilter-core/wire');
const { Policy } = require('../src/dnsfilter-core/policy');
const { udpQuery, tcpQuery, UpstreamError } = require('../src/dnsfilter-core/upstream');
const { ListManager } = require('../src/dnsfilter-core/lists');
const { DnsFilter } = require('../src/dns/dns');
const { normalizeDns } = require('../src/dns/config');
const { normalizeInternalDns, parseCidrs, isTunnelAddress, VpnNamesForwarder, DOWN_AFTER, DOWN_MS, MAX_ZONES } = require('../src/dns/vpnNames');
const { normalizeFeatures } = require('../src/features/config');
const { FeatureManager, CAPABILITIES } = require('../src/features/manager');
const { startRouter, answer } = require('./helpers/dnsFakes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vpnn-'));
const { RCODE, TYPE } = wire;
const ZONES = { server: '10.8.0.1', domains: ['vpn.example.com', 'gc.internal'], primary: 'vpn.example.com' };
const TABLE = { 'laptop-buero.vpn.example.com': { A: ['10.8.0.14'], ttl: 0 }, 'laptop-buero.gc.internal': { A: ['10.8.0.14'], ttl: 0 } };

function emptyCfg() {
  return { alwaysAllow: [], categories: {}, profiles: [], defaultProfile: null, pauses: [], extensions: [] };
}

/** Filter mit gezählten Wegen: DoH/Router-Rückfall (query), Router (local), Tunnel (queryFn des Weiterleiters). */
function makeFilter({ allowedIps = '10.8.0.0/24', tunnel = async (ip, w) => answer(w, TABLE), now = Date.now, serverUrl = 'https://gc.example.net' } = {}) {
  const calls = { public: [], router: [], tunnel: [] };
  const name = (w) => wire.parseQuery(w).name;
  const forwarder = new VpnNamesForwarder({
    tunnelIp: '10.8.0.7', allowedIps, now,
    queryFn: async (ip, w, opts) => { calls.tunnel.push({ ip, name: name(w), opts }); return tunnel(ip, w); },
  });
  const f = new DnsFilter({
    reporter: { post: async () => ({ ok: true }) }, stateDir: tmp(), serverUrl, port: 0, now,
    addresses: () => [], neighbors: { macFor: async () => null }, localSuffixes: ['fritz.box'],
    lists: new ListManager({ stateDir: tmp(), fetch: async () => { throw Object.assign(new Error('x'), { code: 'network' }); } }),
    vpnForwarder: forwarder,
    upstreamFactory: () => ({
      state: { provider: 'quad9', dohDownUntil: 0 },
      query: async (w) => { calls.public.push(name(w)); return { wire: answer(w, { 'example.org': { A: ['93.184.216.34'] } }), via: 'doh' }; },
      local: async (w) => { calls.router.push(name(w)); return { wire: answer(w, {}), via: 'router' }; },
      close() {},
    }),
  });
  const cfg = (internal) => {
    const c = normalizeDns({ enabled: true, logQueries: true, profiles: [{ id: 's' }], defaultProfile: 's' });
    c.vpnNames = normalizeInternalDns(internal);
    return c;
  };
  const ask = async (n, qtype = TYPE.A) => wire.parseResponse(await f.resolver.handle(wire.buildQuery({ id: 7, name: n, qtype }), { ip: '192.168.1.9', udp: true }));
  return { f, calls, cfg, ask, forwarder };
}

describe('vpn names: what the server sends is checked', () => {
  it('keeps valid zones, lower-case and without duplicates; primary must be one of them', () => {
    assert.deepEqual(normalizeInternalDns({ ...ZONES, resolve: true }), { ...ZONES, forward: true });
    assert.deepEqual(
      normalizeInternalDns({ server: '10.8.0.1', domains: ['VPN.Example.com.', 'vpn.example.com', 'gc.internal'], primary: 'other.example' }),
      { server: '10.8.0.1', domains: ['vpn.example.com', 'gc.internal'], primary: 'vpn.example.com', forward: false },
    );
  });

  it('drops what cannot be a zone: single labels, addresses, wildcards, other types', () => {
    const n = normalizeInternalDns({ server: '10.8.0.1', domains: ['internal', 'com', '10.8.0.1', '*.example.com', 'a b.example', '', null, 42, { x: 1 }, 'ok.example'] });
    assert.deepEqual(n.domains, ['ok.example']);
    assert.equal(normalizeInternalDns({ server: '10.8.0.1', domains: ['internal', '.'] }), null);
    for (const raw of [undefined, null, 'x', [], {}, { domains: 'vpn.example.com' }]) assert.equal(normalizeInternalDns(raw), null);
  });

  it('caps the number of zones', () => {
    const many = Array.from({ length: 40 }, (_, i) => `z${i}.example.com`);
    assert.equal(normalizeInternalDns({ server: '10.8.0.1', domains: many }).domains.length, MAX_ZONES);
  });

  it('the server address must be one a VPN hands out; `resolve` only as a real true', () => {
    for (const bad of ['9.9.9.9', '127.0.0.1', '0.0.0.0', 'dns.example.com', '10.8.0.1:53', 'fd00::1', 42, null]) {
      assert.equal(normalizeInternalDns({ server: bad, domains: ['vpn.example.com'], resolve: true }).server, null, String(bad));
    }
    assert.equal(isTunnelAddress('100.64.0.1'), true);
    assert.equal(isTunnelAddress('192.168.7.1'), true);
    assert.equal(isTunnelAddress('100.128.0.1'), false);
    for (const v of ['true', 1, 'yes', null, undefined]) assert.equal(normalizeInternalDns({ ...ZONES, resolve: v }).forward, false);
  });

  it('features: only with `features` and `internal_dns`; an older server changes nothing', () => {
    assert.equal(normalizeFeatures(undefined).dns.vpnNames, null);
    assert.equal(normalizeFeatures({ dns: { enabled: true } }).dns.vpnNames, null);
    assert.equal(normalizeFeatures({ dns: { enabled: true }, internal_dns: null }).dns.vpnNames, null);
    assert.deepEqual(normalizeFeatures({ dns: { enabled: true }, internal_dns: { ...ZONES, resolve: true } }).dns.vpnNames, { ...ZONES, forward: true });
    assert.ok(CAPABILITIES.includes('dns-vpn-names'));
  });

  it('parseCidrs reads the routes of the tunnel', () => {
    assert.deepEqual(parseCidrs('10.8.0.0/24, 10.9.0.0/16'), [{ network: '10.8.0.0', prefix: 24 }, { network: '10.9.0.0', prefix: 16 }]);
    assert.deepEqual(parseCidrs('10.8.0.0/33, x, 999.1.1.1/8, fd00::/8'), []);
    assert.deepEqual(parseCidrs(undefined), []);
  });
});

describe('vpn names: policy', () => {
  it('without zones gc.internal stays a local name (router), as before', () => {
    const p = new Policy(emptyCfg());
    assert.deepEqual(p.decide('laptop-buero.gc.internal', null), { profileId: null, action: 'allow', reason: 'local', local: true });
    assert.equal(p.inZone('laptop-buero.gc.internal'), false);
  });

  it('a zone wins over the local suffix; only the delivered zones change', () => {
    const p = new Policy(emptyCfg(), { zones: { names: ZONES.domains, forward: true } });
    for (const n of ['laptop-buero.gc.internal', 'gc.internal', 'a.b.vpn.example.com', 'vpn.example.com']) {
      assert.deepEqual(p.decide(n, null), { profileId: null, action: 'allow', reason: 'zone', zone: 'forward' }, n);
    }
    // andere *.internal und die Domain über der Zone: unverändert
    assert.equal(p.decide('nas.internal', null).reason, 'local');
    assert.equal(p.decide('xgc.internal', null).reason, 'local');
    assert.equal(p.decide('example.com', null).reason, 'no_profile');
    assert.equal(p.decide('notvpn.example.com', null).reason, 'no_profile');
    assert.equal(p.decide('fritz.box', null).reason, 'local');
  });

  it('switch off: the zone is answered here; a pause or a profile does not change that', () => {
    const cfg = normalizeDns({ enabled: true, profiles: [{ id: 'k', deny: ['vpn.example.com'], macs: ['aa:bb:cc:00:00:01'] }], pauses: [{ macs: ['aa:bb:cc:00:00:01'], until: 9e12 }] });
    const off = new Policy(cfg, { zones: { names: ZONES.domains, forward: false } });
    assert.equal(off.decide('x.vpn.example.com', 'aa:bb:cc:00:00:01').zone, 'nxdomain');
    const on = new Policy(cfg, { zones: { names: ZONES.domains, forward: true } });
    assert.equal(on.decide('x.vpn.example.com', 'aa:bb:cc:00:00:01').zone, 'forward');
    // `forward` nur als echtes true
    assert.equal(new Policy(cfg, { zones: { names: ZONES.domains, forward: 'yes' } }).decide('x.gc.internal', null).zone, 'nxdomain');
  });

  it('invalid zone names are ignored by the engine as well', () => {
    const p = new Policy(emptyCfg(), { zones: { names: ['internal', '', null, 'com'], forward: true } });
    assert.equal(p.zones, null);
    assert.equal(p.decide('nas.internal', null).reason, 'local');
  });
});

describe('vpn names: the filter', () => {
  it('switch on: the zones go through the tunnel to the server, nothing else does', async () => {
    const { f, calls, cfg, ask } = makeFilter();
    await f.apply(cfg({ ...ZONES, resolve: true }));
    const a = await ask('Laptop-Buero.VPN.example.com');
    assert.equal(a.rcode, RCODE.NOERROR);
    assert.deepEqual(a.answers.map((x) => [...x.rdata].join('.')), ['10.8.0.14']);
    assert.equal((await ask('laptop-buero.gc.internal')).rcode, RCODE.NOERROR);
    assert.equal((await ask('gibtesnicht.vpn.example.com')).rcode, RCODE.NXDOMAIN);
    assert.equal((await ask('laptop-buero.vpn.example.com', TYPE.AAAA)).an, 0);
    assert.deepEqual(calls.tunnel.map((c) => c.ip), ['10.8.0.1', '10.8.0.1', '10.8.0.1', '10.8.0.1']);
    assert.deepEqual(calls.tunnel[0].opts, { timeoutMs: 1500, localAddress: '10.8.0.7' }, 'bound to the tunnel address');
    assert.deepEqual(calls.public, []);
    assert.deepEqual(calls.router, []);
    // alles andere wie zuvor
    await ask('example.org');
    await ask('nas.internal');
    assert.deepEqual(calls.public, ['example.org']);
    assert.deepEqual(calls.router, ['nas.internal']);
    assert.equal(calls.tunnel.length, 4);
    assert.equal(f.queryLog({ limit: 1 })[0].reason, 'local');
    assert.deepEqual(f.test('laptop-buero.vpn.example.com'), { domain: 'laptop-buero.vpn.example.com', profileId: 's', action: 'allow', reason: 'zone' });
    const t = f.telemetry().vpnNames;
    assert.deepEqual({ zones: t.zones, primary: t.primary, forward: t.forward, routed: t.routed, down: t.down }, { zones: ZONES.domains, primary: 'vpn.example.com', forward: true, routed: true, down: false });
    f.stop();
  });

  it('switch off: NXDOMAIN from the gateway itself, no way is asked', async () => {
    const { f, calls, cfg, ask } = makeFilter();
    await f.apply(cfg({ ...ZONES, resolve: false }));
    for (const n of ['laptop-buero.vpn.example.com', 'laptop-buero.gc.internal', 'gc.internal']) {
      const a = await ask(n);
      assert.equal(a.rcode, RCODE.NXDOMAIN, n);
      assert.equal(a.an, 0);
    }
    assert.deepEqual(calls, { public: [], router: [], tunnel: [] });
    const { body } = f.stats.take();
    assert.equal(body.blocked, 0, 'not counted as blocked');
    f.stop();
  });

  it('older server (no zones): gc.internal goes to the router as before', async () => {
    const { f, calls, cfg, ask } = makeFilter();
    await f.apply(cfg(undefined));
    await ask('laptop-buero.gc.internal');
    await ask('laptop-buero.vpn.example.com');
    assert.deepEqual(calls, { public: ['laptop-buero.vpn.example.com'], router: ['laptop-buero.gc.internal'], tunnel: [] });
    assert.equal(f.telemetry().vpnNames, null);
    f.stop();
  });

  it('takes over a change of the zones and of the switch while running', async () => {
    const { f, calls, cfg, ask } = makeFilter();
    await f.apply(cfg({ ...ZONES, resolve: true }));
    await ask('laptop-buero.vpn.example.com');
    // der Admin stellt auf eine andere Zone um
    await f.apply(cfg({ server: '10.8.0.1', domains: ['geraete.example.net', 'gc.internal'], primary: 'geraete.example.net', resolve: true }));
    await ask('laptop-buero.geraete.example.net');
    await ask('laptop-buero.vpn.example.com');
    assert.deepEqual(calls.tunnel.map((c) => c.name), ['laptop-buero.vpn.example.com', 'laptop-buero.geraete.example.net']);
    assert.deepEqual(calls.public, ['laptop-buero.vpn.example.com'], 'the old zone is an ordinary name again');
    // Schalter aus
    await f.apply(cfg({ server: '10.8.0.1', domains: ['geraete.example.net', 'gc.internal'], primary: 'geraete.example.net', resolve: false }));
    assert.equal((await ask('laptop-buero.geraete.example.net')).rcode, RCODE.NXDOMAIN);
    assert.equal(calls.tunnel.length, 2);
    // zurück zur alten Zone allein
    await f.apply(cfg({ server: '10.8.0.1', domains: ['gc.internal'], primary: 'gc.internal', resolve: true }));
    await ask('laptop-buero.gc.internal');
    assert.equal(calls.tunnel.at(-1).name, 'laptop-buero.gc.internal');
    assert.deepEqual(calls.router, []);
    f.stop();
  });

  it('the server DNS does not answer: SERVFAIL, no other way, and soon without waiting', async () => {
    let t = 1_000_000;
    const { f, calls, cfg, ask, forwarder } = makeFilter({ now: () => t, tunnel: async () => { throw new UpstreamError('timeout'); } });
    await f.apply(cfg({ ...ZONES, resolve: true }));
    for (let i = 0; i < DOWN_AFTER; i++) assert.equal((await ask(`n${i}.vpn.example.com`)).rcode, RCODE.SERVFAIL);
    assert.equal(calls.tunnel.length, DOWN_AFTER);
    assert.equal(forwarder.telemetry().down, true);
    // gestört: sofort SERVFAIL, der Tunnel wird nicht mehr gefragt
    assert.equal((await ask('n9.vpn.example.com')).rcode, RCODE.SERVFAIL);
    assert.equal(calls.tunnel.length, DOWN_AFTER);
    assert.deepEqual(calls.public, []);
    assert.deepEqual(calls.router, []);
    assert.equal(f.telemetry().vpnNames.lastError.code, 'timeout');
    // danach wird wieder versucht
    t += DOWN_MS + 1;
    await ask('n10.vpn.example.com');
    assert.equal(calls.tunnel.length, DOWN_AFTER + 1);
    f.stop();
  });

  it('never forwards when the server address is not behind the tunnel', async () => {
    for (const internal of [
      { ...ZONES, server: '192.168.178.1', resolve: true }, // im Heimnetz, nicht im Tunnel
      { ...ZONES, server: '9.9.9.9', resolve: true }, // öffentlich
      { ...ZONES, server: '10.8.0.7', resolve: true }, // das Gateway selbst
      { domains: ZONES.domains, resolve: true }, // keine Adresse
    ]) {
      const { f, calls, cfg, ask } = makeFilter();
      await f.apply(cfg(internal));
      assert.equal((await ask('laptop-buero.vpn.example.com')).rcode, RCODE.SERVFAIL, JSON.stringify(internal));
      assert.deepEqual(calls, { public: [], router: [], tunnel: [] });
      assert.equal(f.telemetry().vpnNames.routed, false);
      f.stop();
    }
    // ohne Tunnel-Routen (leere AllowedIPs) ebenso
    const { f, calls, cfg, ask } = makeFilter({ allowedIps: '' });
    await f.apply(cfg({ ...ZONES, resolve: true }));
    assert.equal((await ask('laptop-buero.gc.internal')).rcode, RCODE.SERVFAIL);
    assert.deepEqual(calls, { public: [], router: [], tunnel: [] });
    f.stop();
  });

  it('a zone that would cover the server itself is left out', async () => {
    const { f, calls, cfg, ask } = makeFilter({ serverUrl: 'https://gc.vpn.example.com' });
    await f.apply(cfg({ ...ZONES, resolve: false }));
    assert.deepEqual(f.telemetry().vpnNames.zones, ['gc.internal']);
    assert.equal(f.test('gc.vpn.example.com').reason, 'always_allow');
    assert.equal((await ask('x.gc.internal')).rcode, RCODE.NXDOMAIN);
    assert.deepEqual(calls.tunnel, []);
    f.stop();
  });

  it('answers are not kept: a new device name is there at once', async () => {
    const table = {};
    const { f, calls, cfg, ask } = makeFilter({ tunnel: async (ip, w) => answer(w, table) });
    await f.apply(cfg({ ...ZONES, resolve: true }));
    assert.equal((await ask('neu.vpn.example.com')).rcode, RCODE.NXDOMAIN);
    table['neu.vpn.example.com'] = { A: ['10.8.0.20'] };
    assert.equal((await ask('neu.vpn.example.com')).rcode, RCODE.NOERROR);
    assert.equal(calls.tunnel.length, 2);
    assert.equal(f.cache.size, 0);
    f.stop();
  });
});

describe('vpn names: the query is bound to the tunnel address', () => {
  it('udp/tcp: with an own address it works, with one that does not exist it fails at once and nothing is sent', async () => {
    const router = await startRouter({ 'laptop-buero.vpn.example.com': { A: ['10.8.0.14'] } });
    try {
      const q = wire.buildQuery({ name: 'laptop-buero.vpn.example.com', qtype: TYPE.A });
      const ok = wire.parseResponse(await udpQuery('127.0.0.1', q, { port: router.port, localAddress: '127.0.0.1' }));
      assert.equal(ok.rcode, RCODE.NOERROR);
      assert.equal(wire.parseResponse(await tcpQuery('127.0.0.1', q, { port: router.port, localAddress: '127.0.0.1' })).rcode, RCODE.NOERROR);
      const before = { ...router.seen };
      // 192.0.2.0/24 (TEST-NET-1) gehört keiner Schnittstelle
      await assert.rejects(udpQuery('127.0.0.1', q, { port: router.port, localAddress: '192.0.2.77' }), (e) => e instanceof UpstreamError && e.code === 'udp');
      await assert.rejects(tcpQuery('127.0.0.1', q, { port: router.port, localAddress: '192.0.2.77' }), (e) => e instanceof UpstreamError);
      assert.deepEqual(router.seen, before, 'nothing reached the resolver');
    } finally {
      await router.close();
    }
  });
});

describe('vpn names: restart', () => {
  it('the zones survive a restart together with the DNS setting', async () => {
    const stateDir = tmp();
    const part = () => ({ apply() {}, stop() {}, telemetry: () => ({}), featureTelemetry: () => ({}) });
    const applied = [];
    const parts = { netwatch: part(), inetq: part(), presence: part(), ups: { ...part(), telemetry: () => null } };
    const dns = { apply: async (c) => applied.push(c), stop() {}, telemetry: () => null, featureTelemetry: () => ({ enabled: false }) };
    const mgr = new FeatureManager({ ...parts, dns, stateDir });
    await mgr.apply({ dns: { enabled: true, profiles: [{ id: 'a' }] }, internal_dns: { ...ZONES, resolve: true } });
    assert.deepEqual(applied.at(-1).vpnNames, { ...ZONES, forward: true });
    const mgr2 = new FeatureManager({ ...parts, dns, stateDir });
    await mgr2.restoreBoot();
    assert.equal(applied.length, 2);
    assert.deepEqual(applied.at(-1).vpnNames, { ...ZONES, forward: true });
    // Server ohne Zonen (älter): beim nächsten Start auch keine
    await mgr.apply({ dns: { enabled: true, profiles: [{ id: 'a' }] } });
    await mgr2.restoreBoot();
    assert.equal(applied.at(-1).vpnNames, null);
  });
});
