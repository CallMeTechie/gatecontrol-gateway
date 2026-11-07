'use strict';

// Lokale KI – Restpunkte Phase 3c (docs/local-ai.md §2.1, §3): Grafikkarte
// (sysfs, Bericht des Wächters), Namen und IPv6 für den KI-Server im LAN (nur
// private Ziele, auch nach der Auflösung), API-Schlüssel (nie im Config-Pull,
// nie in der Telemetrie, verschlüsselt im Zustand) und der Verbindungstest
// POST /api/ai/probe.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createApiServer } = require('../src/api/server');
const { createFeaturesRouter } = require('../src/api/routes/features');
const { isLanAddress, isHostname, validKey } = require('../src/ai/config');
const { AiService, SUPPORTS } = require('../src/ai/ai');
const { createResolver, mdnsQuery } = require('../src/ai/resolve');
const { AiKeyStore, FILE: KEY_FILE } = require('../src/ai/creds');
const gpu = require('../src/ai/gpu');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(15); }
  throw new Error('timeout waiting for condition');
}

// KI-Server, der einen Schlüssel verlangt (wie Ollama hinter einem Proxy, vLLM --api-key …)
async function startKeyed({ key = null } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null, host: req.headers.host });
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (key && req.headers.authorization !== `Bearer ${key}`) return json(401, { error: 'unauthorized' });
    if (req.url === '/api/version') return json(200, { version: '0.40.8' });
    if (req.url === '/api/tags') return json(200, { models: [{ name: 'qwen2.5:14b', size: 9e9 }] });
    if (req.url === '/api/ps') return json(200, { models: [{ name: 'qwen2.5:14b', size: 10e9, size_vram: 10e9 }] });
    if (req.url === '/v1/models') return json(200, { data: [{ id: 'llama-3.2-3b-instruct' }] });
    return json(404, { error: 'not found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, seen, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

// Der Name zeigt im Test auf 127.0.0.1 (die echte Prüfung „nur privat“ steht im Resolver-Test)
const fakeResolver = (map) => ({
  lookupFor: (host) => (h, o, cb) => {
    if (typeof o === 'function') { cb = o; o = {}; }
    const a = map[host];
    if (!a) return cb(Object.assign(new Error('nope'), { code: 'unreachable' }));
    return o && o.all ? cb(null, [{ address: a, family: 4 }]) : cb(null, a, 4);
  },
  forget() {},
});

let stub = null;
afterEach(async () => { if (stub) { await stub.close(); stub = null; } });

// ─── Adressen ────────────────────────────────────────────────────────────

describe('ai lan: addresses and names', () => {
  it('only addresses in the home network: RFC 1918 and fc00::/7', () => {
    for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.178.20', 'fd00::1', 'fc12:3456::7']) assert.ok(isLanAddress(a), a);
    for (const a of ['8.8.8.8', '127.0.0.1', '169.254.169.254', '172.32.0.1', '100.64.0.1', '::1', 'fe80::1', '2001:db8::1', '::ffff:c0a8:102', 'fd.example']) {
      assert.ok(!isLanAddress(a), a);
    }
    for (const h of ['nas', 'nas.local', 'pc-1.fritz.box', 'xn--bcher-kva.home.arpa']) assert.ok(isHostname(h), h);
    for (const h of ['', 'localhost', 'a.localhost', 'nas_1', '-a', 'a-', 'a..b', '1.2.3', 'x'.repeat(64)]) assert.ok(!isHostname(h), h);
  });

  it('a name only resolves to private addresses (public ones are dropped; only public → not_private)', async () => {
    const calls = [];
    const r = createResolver({
      lookup: async (h) => {
        calls.push(h);
        if (h === 'pc.fritz.box') return [{ address: '2a02:8070::1', family: 6 }, { address: 'fd00::20', family: 6 }, { address: '192.168.178.20', family: 4 }];
        if (h === 'evil.example') return [{ address: '93.184.216.34', family: 4 }];
        if (h === 'rebind.example') return [{ address: '127.0.0.1', family: 4 }];
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      },
      mdns: async () => [],
    });
    assert.deepEqual(await r.resolve('pc.fritz.box'), ['192.168.178.20', 'fd00::20']);
    await r.resolve('pc.fritz.box');
    assert.equal(calls.filter((c) => c === 'pc.fritz.box').length, 1, 'cached');
    await assert.rejects(r.resolve('evil.example'), (e) => e.code === 'not_private');
    await assert.rejects(r.resolve('rebind.example'), (e) => e.code === 'not_private');
    await assert.rejects(r.resolve('nothere.lan'), (e) => e.code === 'unreachable');
    await assert.rejects(r.resolve('8.8.8.8'), (e) => e.code === 'not_private');
    assert.deepEqual(await r.resolve('fd00::1'), ['fd00::1']);
    // die Form, die http.request/net.connect braucht (mit und ohne all)
    const lk = r.lookupFor('pc.fritz.box');
    const one = await new Promise((res) => lk('pc.fritz.box', {}, (e, a, f) => res([e, a, f])));
    assert.deepEqual(one, [null, '192.168.178.20', 4]);
    const all = await new Promise((res) => lk('pc.fritz.box', { all: true }, (e, a) => res([e, a])));
    assert.deepEqual(all, [null, [{ address: '192.168.178.20', family: 4 }, { address: 'fd00::20', family: 6 }]]);
    const bad = await new Promise((res) => r.lookupFor('evil.example')('evil.example', { all: true }, (e) => res(e)));
    assert.equal(bad.code, 'not_private');
  });

  it('.local asks mDNS first (no nss-mdns in the image), then DNS', async () => {
    const asked = [];
    const r = createResolver({ lookup: async () => [{ address: '10.0.0.9', family: 4 }], mdns: async (n) => { asked.push(n); return n === 'ki-pc.local' ? ['192.168.1.44'] : []; } });
    assert.deepEqual(await r.resolve('ki-pc.local'), ['192.168.1.44']);
    assert.deepEqual(await r.resolve('other.local'), ['10.0.0.9'], 'no mDNS answer → DNS');
    assert.deepEqual(asked, ['ki-pc.local', 'other.local']);
  });

  it('mdnsQuery: A/AAAA answers of the asked name, nothing else; no answer → [] after the time limit', async () => {
    const { EventEmitter } = require('node:events');
    const fake = (answers) => () => {
      const m = new EventEmitter();
      m.destroy = () => {};
      m.query = (q) => {
        assert.deepEqual(q.questions.map((x) => x.type), ['A', 'AAAA']);
        if (answers) setTimeout(() => m.emit('response', { answers }), 5);
      };
      return m;
    };
    assert.deepEqual(await mdnsQuery('nas.local', { factory: fake([{ name: 'NAS.local', type: 'A', data: '192.168.1.5' }, { name: 'x.local', type: 'A', data: '192.168.1.6' }, { name: 'nas.local', type: 'TXT', data: 'x' }]) }),
      ['192.168.1.5']);
    assert.deepEqual(await mdnsQuery('nas.local', { factory: fake(null), timeoutMs: 30 }), []);
    assert.deepEqual(await mdnsQuery('nas.local', { factory: () => { throw new Error('no socket'); } }), []);
  });

  it('a name pointing outside the home network: the service never connects (state unreachable, error not_private)', async () => {
    stub = await startKeyed();
    const svc = new AiService({ ctlDir: '/nonexistent-gc-ai', resolver: createResolver({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], mdns: async () => [] }) });
    await svc.apply({ enabled: true, source: 'lan', lan: { url: 'http://ki.example:11434' } });
    await svc.tick();
    assert.equal(svc.state(), 'unreachable');
    assert.equal(svc.lastError.code, 'not_private');
    svc.stop();
  });

  it('a name in the home network: the service connects to the resolved address, with the name in Host', async () => {
    stub = await startKeyed();
    const svc = new AiService({ ctlDir: '/nonexistent-gc-ai', resolver: fakeResolver({ 'ki-pc.local': '127.0.0.1' }) });
    await svc.apply({ enabled: true, source: 'lan', lan: { url: `http://ki-pc.local:${stub.port}`, api: 'ollama' } });
    await svc.tick();
    assert.equal(svc.state(), 'running');
    assert.deepEqual(svc.models.map((m) => m.name), ['qwen2.5:14b']);
    assert.equal(stub.seen[0].host, `ki-pc.local:${stub.port}`);
    const t = svc.featureTelemetry();
    assert.deepEqual(t.lan, { url: `http://ki-pc.local:${stub.port}`, api: 'ollama', reachable: true, auth: false });
    assert.deepEqual(t.supports, SUPPORTS);
    svc.stop();
  });
});

// ─── API-Schlüssel ───────────────────────────────────────────────────────

describe('ai lan: API key', () => {
  it('keys: printable, no spaces or line breaks, at most 512 characters', () => {
    for (const k of ['sk-abc123', 'lm-studio', 'x'.repeat(512)]) assert.ok(validKey(k), k);
    for (const k of ['', 'a b', 'a\nb', 'ä', 'x'.repeat(513), null, 5]) assert.ok(!validKey(k), String(k));
  });

  it('without the key: unauthorized; keyRev → fetched once, sent as Bearer, never in the telemetry', async () => {
    const KEY = 'sk-local-0123456789';
    stub = await startKeyed({ key: KEY });
    const state = tmp('gc-ai-key-');
    let fetches = 0;
    const keys = new AiKeyStore({ apiToken: 'a'.repeat(64), stateDir: state, fetcher: async () => { fetches++; return { rev: '0123abcd0123abcd', key: KEY }; } });
    const svc = new AiService({ ctlDir: '/nonexistent-gc-ai', keyStore: keys, resolver: fakeResolver({ 'llm.home.arpa': '127.0.0.1' }) });
    const url = `http://llm.home.arpa:${stub.port}`;
    await svc.apply({ enabled: true, source: 'lan', lan: { url, api: 'ollama' } });
    await svc.tick();
    assert.equal(svc.state(), 'unreachable');
    assert.equal(svc.lastError.code, 'unauthorized');
    assert.equal(stub.seen[0].auth, null, 'no key without keyRev');
    await svc.apply({ enabled: true, source: 'lan', lan: { url, api: 'ollama', keyRev: '0123abcd0123abcd' } });
    await until(() => svc.state() === 'running');
    assert.equal(fetches, 1);
    assert.equal(stub.seen[stub.seen.length - 1].auth, `Bearer ${KEY}`);
    const tel = JSON.stringify(svc.featureTelemetry());
    assert.ok(!tel.includes(KEY), 'the key never goes into the telemetry');
    assert.equal(svc.featureTelemetry().lan.auth, true);
    assert.ok(!JSON.stringify(await svc.status()).includes(KEY));
    // im Zustand nur verschlüsselt (0600) – ein Neustart braucht den Server nicht
    const file = path.join(state, KEY_FILE);
    const raw = fs.readFileSync(file);
    assert.ok(!raw.toString('latin1').includes(KEY));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const again = new AiKeyStore({ apiToken: 'a'.repeat(64), stateDir: state, fetcher: async () => { throw new Error('offline'); } });
    assert.equal(await again.sync('0123abcd0123abcd'), false);
    assert.equal(again.get(), KEY);
    // anderes Gateway-Token: die Datei ist wertlos
    assert.equal(new AiKeyStore({ apiToken: 'b'.repeat(64), stateDir: state }).get(), null);
    // gleiche Revision: nicht neu holen
    await svc.apply({ enabled: true, source: 'lan', lan: { url, api: 'ollama', keyRev: '0123abcd0123abcd' } });
    await wait(30);
    assert.equal(fetches, 1);
    // Schlüssel entfernt (kein keyRev) → vergessen, auch die Datei
    await svc.apply({ enabled: true, source: 'lan', lan: { url, api: 'ollama' } });
    assert.equal(keys.get(), null);
    assert.ok(!fs.existsSync(file));
    svc.stop();
  });

  it('a failed fetch keeps the service running without a key (tries again with the next config pull)', async () => {
    const keys = new AiKeyStore({ apiToken: 'a'.repeat(64), fetcher: async () => { throw Object.assign(new Error('503'), { code: 'ERR_BAD_RESPONSE' }); } });
    const svc = new AiService({ ctlDir: '/nonexistent-gc-ai', keyStore: keys, lanBackend: () => ({ version: async () => null, models: async () => [], loaded: async () => [] }) });
    await svc.apply({ enabled: true, source: 'lan', lan: { url: 'http://192.168.1.5:8000', api: 'openai', keyRev: 'ffffffffffffffff' } });
    await until(() => svc.keysBusy === null);
    assert.equal(keys.get(), null);
    svc.stop();
  });

  it('the server answer is checked (rev, key)', () => {
    const { parse } = require('../src/ai/creds');
    assert.deepEqual(parse({ rev: 'abcdef0123', key: 'sk-1' }), { rev: 'abcdef0123', key: 'sk-1' });
    assert.deepEqual(parse({ rev: 'XYZ', key: 'a b' }), { rev: null, key: null });
    assert.deepEqual(parse(null), { rev: null, key: null });
  });
});

// ─── Verbindungstest ─────────────────────────────────────────────────────

const TOK = 'e'.repeat(64);
async function serve(ai) {
  const a = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: TOK, routerFactories: { '/api': () => createFeaturesRouter({ featureMgr: { ai } }) } });
  const srv = a.listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  return srv;
}
function post(srv, p, body) {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), 'X-Gateway-Token': TOK } }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    req.end(d);
  });
}

describe('ai lan: POST /api/ai/probe', () => {
  it('lists the models of a server that is not saved yet (also while the local AI is off), with the key', async () => {
    stub = await startKeyed({ key: 'sk-probe' });
    const svc = new AiService({ ctlDir: '/nonexistent-gc-ai', resolver: fakeResolver({ 'lmstudio.lan': '127.0.0.1' }) });
    const srv = await serve(svc);
    try {
      const url = `http://lmstudio.lan:${stub.port}/v1`;
      let r = await post(srv, '/api/ai/probe', { url, api: 'openai', key: 'sk-probe' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.probe, { reachable: true, url: `http://lmstudio.lan:${stub.port}`, api: 'openai', version: null,
        models: [{ name: 'llama-3.2-3b-instruct', size: 0, family: null, params: null, quant: null, modified: null }], auth: true, error: null });
      r = await post(srv, '/api/ai/probe', { url, api: 'openai' });
      assert.equal(r.body.probe.reachable, false);
      assert.equal(r.body.probe.error.code, 'unauthorized');
      assert.equal(svc.cfg.enabled, false, 'nothing saved');
      // falsche Eingaben, öffentliche Ziele
      for (const b of [{ url: 'http://8.8.8.8:11434' }, { url: 'http://127.0.0.1:11434' }, { url: 'nope' }]) assert.equal((await post(srv, '/api/ai/probe', b)).body.error, 'invalid_url');
      assert.equal((await post(srv, '/api/ai/probe', { url, api: 'evil' })).status, 400);
      assert.equal((await post(srv, '/api/ai/probe', { url, key: 'a b' })).status, 400);
    } finally { srv.close(); svc.stop(); }
  });

  it('one test at a time', async () => {
    const svc = new AiService({ ctlDir: '/nonexistent-gc-ai' });
    svc.probing = true;
    assert.deepEqual(await svc.probe({ url: 'http://192.168.1.2:11434' }), { error: 'busy' });
  });
});

// ─── Grafikkarte ─────────────────────────────────────────────────────────

function fakeSys() {
  const sys = tmp('gc-ai-gpu-sys-');
  const proc = tmp('gc-ai-gpu-proc-');
  const drv = path.join(sys, 'bus/pci/drivers');
  const dev = (n, cls, vendor, driver, extra = {}) => {
    const d = path.join(sys, 'bus/pci/devices', n);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'class'), cls + '\n');
    fs.writeFileSync(path.join(d, 'vendor'), vendor + '\n');
    if (driver) { fs.mkdirSync(path.join(drv, driver), { recursive: true }); fs.symlinkSync(path.join(drv, driver), path.join(d, 'driver')); }
    for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(d, k), v);
  };
  return { sys, proc, dev };
}

describe('ai: graphics card', () => {
  it('host: vendor, driver, memory (AMD), NVIDIA driver version and name, /dev/kfd, render nodes', () => {
    const { sys, proc, dev } = fakeSys();
    dev('0000:00:02.0', '0x030000', '0x8086', 'i915');
    dev('0000:01:00.0', '0x030000', '0x10de', 'nvidia');
    dev('0000:03:00.0', '0x030000', '0x1002', 'amdgpu', { mem_info_vram_total: String(16 * 1024 ** 3) + '\n' });
    dev('0000:05:00.0', '0x030000', '0x1002', 'amdgpu', { mem_info_vram_total: String(512 * 1024 ** 2) });
    dev('0000:00:1f.0', '0x060100', '0x8086', null);
    fs.mkdirSync(path.join(proc, 'driver/nvidia/gpus/0000:01:00.0'), { recursive: true });
    fs.writeFileSync(path.join(proc, 'driver/nvidia/gpus/0000:01:00.0/information'), 'Model: \t NVIDIA GeForce RTX 3060\nIRQ: 150\n');
    fs.mkdirSync(path.join(sys, 'module/nvidia'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'module/nvidia/version'), '550.54.14\n');
    fs.mkdirSync(path.join(sys, 'class/kfd/kfd'), { recursive: true });
    fs.mkdirSync(path.join(sys, 'class/drm/renderD128'), { recursive: true });
    assert.deepEqual(gpu.detectHost(sys, proc), {
      cards: [
        { vendor: 'intel', driver: 'i915', vramMb: null, integrated: true, name: null },
        { vendor: 'nvidia', driver: 'nvidia', vramMb: null, integrated: false, name: 'NVIDIA GeForce RTX 3060' },
        { vendor: 'amd', driver: 'amdgpu', vramMb: 16384, integrated: false, name: null },
        { vendor: 'amd', driver: 'amdgpu', vramMb: 512, integrated: true, name: null },
      ],
      nvidiaDriver: '550.54.14', kfd: true, render: true,
    });
    const none = gpu.detectHost('/nonexistent-gc', '/nonexistent-gc');
    assert.deepEqual(none, { cards: [], nvidiaDriver: null, kfd: false, render: false });
    // nouveau statt nvidia: der Treiber steht da, die Version fehlt
    const b = fakeSys();
    b.dev('0000:01:00.0', '0x030000', '0x10de', 'nouveau');
    assert.deepEqual(gpu.detectHost(b.sys, b.proc).cards[0], { vendor: 'nvidia', driver: 'nouveau', vramMb: null, integrated: false, name: null });
  });

  it('service: the report of the watcher (mode, devices, nvidia-smi); stale or missing → null', () => {
    const ctl = tmp('gc-ai-gpu-ctl-');
    const now = Date.now();
    const at = Math.floor(now / 1000);
    fs.writeFileSync(path.join(ctl, 'ki.gpu'), `mode nvidia\nat ${at}\ndev nvidia0\ndev nvidiactl\ndev renderD128\nnv NVIDIA GeForce RTX 3060, 12288, 550.54.14\nnv bad;name, x, 1.2.3; rm\n`);
    assert.deepEqual(gpu.readServiceGpu(ctl, now), { mode: 'nvidia', devices: ['dri', 'nvidia'], cards: [
      { name: 'NVIDIA GeForce RTX 3060', vramMb: 12288, driver: '550.54.14' },
      { name: 'bad;name', vramMb: null, driver: null },
    ] });
    assert.equal(gpu.serviceAccess(gpu.readServiceGpu(ctl, now)), true);
    assert.equal(gpu.readServiceGpu(ctl, now + 10 * 60_000), null, 'stale (the container is gone)');
    fs.writeFileSync(path.join(ctl, 'ki.gpu'), `mode amd\nat ${at}\ndev renderD128\n`);
    assert.equal(gpu.serviceAccess(gpu.readServiceGpu(ctl, now)), false, 'ROCm without /dev/kfd');
    fs.writeFileSync(path.join(ctl, 'ki.gpu'), `mode none\nat ${at}\n`);
    assert.equal(gpu.serviceAccess(gpu.readServiceGpu(ctl, now)), null);
    fs.writeFileSync(path.join(ctl, 'ki.gpu'), `mode evil\nat ${at}\n`);
    assert.equal(gpu.readServiceGpu(ctl, now), null);
    assert.equal(gpu.readServiceGpu('/nonexistent-gc', now), null);
  });

  it('telemetry: host facts and the service view (model in graphics memory = used)', async () => {
    const { sys, proc, dev } = fakeSys();
    dev('0000:01:00.0', '0x030000', '0x10de', 'nvidia');
    fs.mkdirSync(path.join(sys, 'module/nvidia'), { recursive: true });
    fs.writeFileSync(path.join(sys, 'module/nvidia/version'), '550.54.14\n');
    const ctl = tmp('gc-ai-gpu-ctl-');
    fs.writeFileSync(path.join(ctl, 'ki.state'), `running ${Math.floor(Date.now() / 1000)}\n`);
    fs.writeFileSync(path.join(ctl, 'ki.gpu'), `mode nvidia\nat ${Math.floor(Date.now() / 1000)}\ndev nvidia0\nnv NVIDIA GeForce RTX 3060, 12288, 550.54.14\n`);
    stub = await startKeyed();
    const { createOllama } = require('../src/ai/backends');
    const svc = new AiService({ ctlDir: ctl, sysRoot: sys, procRoot: proc, serviceBackend: createOllama({ protocol: 'http:', host: '127.0.0.1', port: stub.port }) });
    await svc.apply({ enabled: true, source: 'service' });
    await svc.tick();
    const t = svc.featureTelemetry();
    assert.deepEqual(t.host.gpu, [{ vendor: 'nvidia', driver: 'nvidia', vramMb: null, integrated: false, name: null }]);
    assert.equal(t.host.nvidiaDriver, '550.54.14');
    assert.deepEqual(t.gpu, { mode: 'nvidia', devices: ['nvidia'], access: true, cards: [{ name: 'NVIDIA GeForce RTX 3060', vramMb: 12288, driver: '550.54.14' }], used: true });
    assert.ok(JSON.stringify(t).length < 4096, 'small for the heartbeat');
    svc.stop();
  });
});

// ─── Wächter: GPU-Bericht ────────────────────────────────────────────────

describe('ai: watcher writes ki.gpu (docker-compose.example.yml)', () => {
  it('mode from GC_KI_GPU, the devices it sees and nvidia-smi', { timeout: 20000 }, async () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.example.yml'), 'utf8');
    const block = yml.slice(yml.indexOf('\n  ki:\n'));
    const m = /- \|\n((?: {8}.*\n)+)/.exec(block);
    assert.ok(m, 'watcher script found');
    assert.match(block.slice(0, block.indexOf('healthcheck:')), /- GC_KI_GPU=none/);
    const dir = tmp('gc-ai-watchgpu-');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'ollama'), '#!/bin/sh\nwhile :; do sleep 0.2; done\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'nvidia-smi'), '#!/bin/sh\necho "NVIDIA GeForce RTX 3060, 12288, 550.54.14"\n', { mode: 0o755 });
    const ctl = path.join(dir, 'ctl');
    fs.mkdirSync(ctl);
    const script = m[1].split('\n').map((l) => l.slice(8)).join('\n').replace(/\$\$/g, '$').replace('C=/gc-ai;', `C=${ctl};`);
    const child = spawn('/bin/sh', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GC_KI_GPU: 'nvidia' }, stdio: 'ignore' });
    try {
      await until(() => fs.existsSync(path.join(ctl, 'ki.gpu')), 8000);
      const r = gpu.readServiceGpu(ctl);
      assert.equal(r.mode, 'nvidia');
      assert.deepEqual(r.cards, [{ name: 'NVIDIA GeForce RTX 3060', vramMb: 12288, driver: '550.54.14' }]);
    } finally { child.kill('SIGTERM'); }
  });
});

// ─── GPU-Zusatzdateien ───────────────────────────────────────────────────

describe('ai: docker-compose.ki-*.yml', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  it('nvidia: device reservation; amd: the rocm image with /dev/kfd and /dev/dri; intel: /dev/dri – each says its GPU', () => {
    const nv = read('docker-compose.ki-nvidia.yml');
    assert.match(nv, /driver: nvidia\n\s+count: all\n\s+capabilities: \[gpu\]/);
    assert.match(nv, /GC_KI_GPU=nvidia/);
    const amd = read('docker-compose.ki-amd.yml');
    const base = /image: (ollama\/ollama:[0-9.]+)@sha256:[0-9a-f]{64}/.exec(read('docker-compose.example.yml'))[1];
    // the rocm image of the same Ollama version (compared as text, no pattern built from file contents)
    const img = /image: (\S+)/.exec(amd)[1];
    assert.ok(img.startsWith(`${base}-rocm@sha256:`), img);
    assert.match(img.slice(img.indexOf('@sha256:') + 8), /^[0-9a-f]{64}$/);
    assert.match(amd, /- \/dev\/kfd\n\s+- \/dev\/dri/);
    assert.match(amd, /GC_KI_GPU=amd/);
    const intel = read('docker-compose.ki-intel.yml');
    assert.match(intel, /- \/dev\/dri/);
    assert.match(intel, /GC_KI_GPU=intel/);
    for (const t of [nv, amd, intel]) assert.ok(!/privileged|cap_add|network_mode|ports:/.test(t), 'only the GPU, nothing else');
  });
});
