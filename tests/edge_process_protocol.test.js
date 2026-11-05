'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EdgeProcess, execArgvFor, BOOTSTRAP } = require('../src/edge/pluginProcess');
const { parseState, parseCall } = require('../src/edge/protocol');
const { RESTART_BACKOFF_MS } = require('../src/edge/constants');
const { EdgeLink, resolveServer } = require('../src/edge/gatewayLink');

test('Neustart-Backoff 1 s … 5 min, nach 10 min stabil wieder von vorn', () => {
  let t = 0;
  const p = new EdgeProcess({ id: 'x', version: '1.0.0', dir: '/x', entry: 'e/i.js', memoryMb: 32 }, { now: () => t, hooks: {} });
  const seq = [];
  p.startedAt = 1;
  for (let i = 0; i < 9; i++) seq.push(p.nextBackoff());
  assert.deepStrictEqual(seq, [...RESTART_BACKOFF_MS, 300000, 300000]);
  assert.strictEqual(seq[0], 1000);
  assert.strictEqual(Math.max(...seq), 5 * 60 * 1000);
  t = 1 + 10 * 60 * 1000 + 1; // lief länger als 10 min
  assert.strictEqual(p.nextBackoff(), 1000);
});

test('execArgv: Permission-Model, nur Bootstrap + Code-Ordner lesbar, kein Schreiben, Heap = memoryMb', () => {
  const a = execArgvFor({ dir: '/state-edge/packages/x/1.0.0', memoryMb: 48 });
  assert.ok(a[0] === '--permission' || a[0] === '--experimental-permission');
  assert.ok(a.includes(`--allow-fs-read=${BOOTSTRAP}`));
  assert.ok(a.includes('--allow-fs-read=/state-edge/packages/x/1.0.0'));
  assert.ok(a.includes('--max-old-space-size=48'));
  assert.ok(!a.some((x) => x.startsWith('--allow-fs-write') || x.startsWith('--allow-child-process') || x.startsWith('--allow-worker') || x.startsWith('--allow-addons')));
});

test('Aufrufe: nicht laufend, max. 32 offen, Timeout ≤ 30 s', async () => {
  const p = new EdgeProcess({ id: 'x', version: '1.0.0', dir: '/x', entry: 'e/i.js', memoryMb: 32 }, { hooks: {} });
  await assert.rejects(p.call('m'), (e) => e.code === 'not_running');
  const sent = [];
  p.state = 'running';
  p.child = { connected: true, send: (m) => sent.push(m) };
  const calls = [];
  for (let i = 0; i < 32; i++) calls.push(p.call('m', i, 30000).catch((e) => e.code));
  await assert.rejects(p.call('m'), (e) => e.code === 'busy');
  assert.strictEqual(sent.length, 32);
  // Antwort zuordnen
  p.onMessage({ t: 'result', id: sent[0].id, ok: true, value: 'ok' });
  assert.strictEqual(await calls[0], 'ok');
  p.onMessage({ t: 'result', id: sent[1].id, ok: false, code: 'x_code', error: 'nein' });
  assert.strictEqual(await calls[1], 'x_code');
  // Prozessende bricht offene Aufrufe ab
  p.wanted = false;
  p.onExit(0, null, null, p.child);
  assert.strictEqual(await calls[2], 'not_running');
  // Timeout wird auf 30 s begrenzt
  p.state = 'running';
  p.child = { connected: true, send: () => {} };
  const start = Date.now();
  await assert.rejects(p.call('m', null, 1), (e) => e.code === 'timeout');
  assert.ok(Date.now() - start < 1000);
});

test('gc.*-Aufrufe aus dem Prozess: höchstens 64 gleichzeitig', async () => {
  const replies = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = new EdgeProcess({ id: 'x', version: '1.0.0', dir: '/x', entry: 'e/i.js', memoryMb: 32 }, { hooks: { hostCall: () => gate } });
  p.child = { connected: true, send: (m) => replies.push(m) };
  for (let i = 0; i < 65; i++) p.onMessage({ t: 'host', id: i, api: 'store.get', args: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(replies.map((r) => r.code), ['busy']);
  release(1);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(replies.filter((r) => r.ok).length, 64);
});

test('Logs: 20/s, Zeile ≤ 2 KB', () => {
  const p = new EdgeProcess({ id: 'x', version: '1.0.0', dir: '/x', entry: 'e/i.js', memoryMb: 32 }, { hooks: {}, now: () => 1000 });
  const lines = [];
  p.on('log', (_l, line) => lines.push(line));
  for (let i = 0; i < 30; i++) p.onMessage({ t: 'log', level: 'info', line: 'x'.repeat(5000) });
  assert.strictEqual(lines.length, 20);
  assert.ok(lines.every((l) => Buffer.byteLength(l) <= 2048));
});

test('state wird vollständig geprüft', () => {
  const sha = 'a'.repeat(64);
  const st = parseState({ t: 'state', edgeEnabled: true, plugins: [{ id: 'p-1', version: '1.2.3', sha256: sha.toUpperCase(), caps: { udp: { ports: [5683] } }, memoryMb: 48 }],
    mqtt: { enabled: true, accounts: [{ user: 'shelly', hash: '$7$101$c2FsdA==$aGFzaA==', acl: [{ access: 'readwrite', topic: 'shellies/#' }] }], pluginTopics: { 'p-1': ['shellies/#'] } } });
  assert.strictEqual(st.plugins[0].sha256, sha);
  assert.strictEqual(st.plugins[0].enabled, true);
  assert.strictEqual(st.allowUnsigned, false);
  assert.strictEqual(st.mqtt.accounts[0].user, 'shelly');
  const bad = [
    { plugins: [{ id: 'P', version: '1.0.0', sha256: sha }] },
    { plugins: [{ id: 'p', version: 'x', sha256: sha }] },
    { plugins: [{ id: 'p', version: '1.0.0', sha256: 'xyz' }] },
    { plugins: [{ id: 'p', version: '1.0.0', sha256: sha, memoryMb: 1024 }] },
    { plugins: [{ id: 'pp', version: '1.0.0', sha256: sha }, { id: 'pp', version: '1.0.0', sha256: sha }] },
    { mqtt: { accounts: [{ user: 'gc-edge', hash: '$7$101$c2FsdA==$aGFzaA==' }] } },
    { mqtt: { accounts: [{ user: 'a b', hash: '$7$101$c2FsdA==$aGFzaA==' }] } },
    { mqtt: { accounts: [{ user: 'a', hash: 'klartext' }] } },
    { mqtt: { accounts: [{ user: 'a', hash: '$7$101$c2FsdA==$aGFzaA==', acl: [{ access: 'all', topic: 'x' }] }] } },
    { mqtt: { accounts: [{ user: 'a', hash: '$7$101$c2FsdA==$aGFzaA==', acl: [{ access: 'read', topic: '$SYS/#' }] }] } },
    { mqtt: { accounts: [{ user: 'a', hash: '$7$101$c2FsdA==$aGFzaA==\nuser x' }] } },
    { mqtt: { pluginTopics: { p: ['#'] } } },
  ];
  for (const b of bad) assert.throws(() => parseState({ t: 'state', ...b }), JSON.stringify(b));
  // ungültige Fähigkeiten eines Plugins → nur dieses Plugin wird abgelehnt
  const c = parseState({ t: 'state', plugins: [{ id: 'pp', version: '1.0.0', sha256: sha, caps: { shell: true } }] });
  assert.match(c.plugins[0].capsError, /unknown capability/);
});

test('call wird geprüft, Timeout begrenzt', () => {
  assert.strictEqual(parseCall({ id: 'u1', plugin: 'pp', method: 'm', timeoutMs: 999999 }).timeoutMs, 30000);
  assert.strictEqual(parseCall({ id: 'u1', plugin: 'pp', method: 'm' }).params, null);
  assert.throws(() => parseCall({ id: 'u1', plugin: 'pp', method: 'a b' }));
  assert.throws(() => parseCall({ plugin: 'pp', method: 'm' }));
});

test('Gateway-Seite: Zugangsdatei nur mit Edge-Volume, Adressen aufgelöst, Status geklemmt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-link-'));
  try {
    const config = { serverUrl: 'https://gc.example.com', apiToken: 'gc_gw_' + 'a'.repeat(64), tunnelIp: '10.8.0.5' };
    const none = new EdgeLink({ config, runDir: path.join(dir, 'missing'), statusDir: dir });
    assert.deepStrictEqual(await none.sync(), { deployed: false });
    assert.strictEqual(none.telemetry(), null);
    const run = path.join(dir, 'run');
    fs.mkdirSync(run);
    const link = new EdgeLink({ config, runDir: run, statusDir: dir, lookup: async () => [{ address: '203.0.113.7', family: 4 }] });
    await link.sync();
    const file = path.join(run, 'credentials');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(c, { v: 1, serverUrl: config.serverUrl, apiToken: config.apiToken, serverAddrs: ['203.0.113.7'], tunnelIp: '10.8.0.5' });
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o440);
    // DNS-Ausfall: letzte Adressen bleiben
    link.lookup = async () => { throw Object.assign(new Error('x'), { code: 'EAI_AGAIN' }); };
    await link.sync();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).serverAddrs, ['203.0.113.7']);
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: new Date().toISOString(), connected: true, edgeEnabled: true, hostRssMb: 41.234,
      plugins: [{ id: 'x'.repeat(200), version: '1.0.0', state: 'running', rssMb: 30, restarts: 1, extra: 'weg' }], mqtt: { running: true, clients: 3 } }));
    const t = link.telemetry();
    assert.strictEqual(t.host.connected, true);
    assert.strictEqual(t.host.stale, false);
    assert.strictEqual(t.host.host_rss_mb, 41.2);
    assert.strictEqual(t.host.plugins[0].id.length, 64);
    assert.strictEqual(t.host.plugins[0].extra, undefined);
    assert.deepStrictEqual(t.host.mqtt, { running: true, clients: 3 });
    assert.deepStrictEqual(await resolveServer('http://192.0.2.1:3000'), { host: '192.0.2.1', port: 3000, addrs: ['192.0.2.1'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
