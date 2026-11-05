'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const gcplugin = require('../src/edge/gcplugin');
const packages = require('../src/edge/packages');
const { keyPair, makePackage } = require('./helpers/edgeFixtures');

const trusted = keyPair();
const keys = [trusted.publicKeyB64];

test('gcplugin: gleiche Pfadregeln wie der Server', () => {
  for (const p of ['../x', '/x', 'a/./b', '.hidden', 'a\\b', 'a//b']) assert.throws(() => gcplugin.checkPath(p), p);
  const dup = gcplugin.encode([['a.js', 'x']]);
  assert.strictEqual(gcplugin.decode(dup).get('a.js').toString(), 'x');
  assert.throws(() => gcplugin.decode(Buffer.from('nope'.repeat(10))), (e) => e.code === 'not_a_package');
  // Datei und Ordner gleichen Namens
  const zlib = require('node:zlib');
  const raw = gcplugin.MAGIC;
  const entry = (name, data) => {
    const n = Buffer.from(name);
    const h = Buffer.alloc(2); h.writeUInt16BE(n.length);
    const s = Buffer.alloc(4); s.writeUInt32BE(data.length);
    return Buffer.concat([h, n, s, Buffer.from(data)]);
  };
  const clash = zlib.gzipSync(Buffer.concat([raw, entry('a', 'x'), entry('a/b', 'y'), Buffer.alloc(2)]));
  assert.throws(() => gcplugin.decode(clash), (e) => e.code === 'bad_path');
  const twice = zlib.gzipSync(Buffer.concat([raw, entry('A.js', 'x'), entry('a.js', 'y'), Buffer.alloc(2)]));
  assert.throws(() => gcplugin.decode(twice), (e) => e.code === 'duplicate');
  const trailing = zlib.gzipSync(Buffer.concat([raw, entry('a.js', 'x'), Buffer.alloc(2), Buffer.from('junk')]));
  assert.throws(() => gcplugin.decode(trailing), (e) => e.code === 'corrupt');
});

test('entpackt nur den Edge-Ordner + plugin.json; prune()', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-pkg-'));
  try {
    const store = new packages.PackageStore({ packagesDir: root });
    const p = makePackage({ sign: 'trusted', trusted });
    const checked = packages.inspect(p.buf, { id: 'demo-edge', version: '1.0.0', sha256: p.sha256, keys });
    const inst = store.extract({ id: 'demo-edge', version: '1.0.0', sha256: p.sha256 }, checked);
    assert.ok(fs.existsSync(path.join(inst.dir, 'edge/index.js')));
    assert.ok(fs.existsSync(path.join(inst.dir, 'plugin.json')));
    assert.ok(!fs.existsSync(path.join(inst.dir, 'server')), 'Server-Teil bleibt draußen');
    assert.ok(!fs.existsSync(path.join(inst.dir, 'signature')));
    assert.strictEqual(store.installed('demo-edge', '1.0.0', p.sha256).signature, 'trusted');
    assert.strictEqual(store.installed('demo-edge', '1.0.0', '0'.repeat(64)), null);
    fs.mkdirSync(path.join(root, 'demo-edge', '0.9.0'));
    store.prune('demo-edge', '1.0.0');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'demo-edge')), ['1.0.0']);
    fs.mkdirSync(path.join(root, 'gone'));
    store.pruneExcept(new Set(['demo-edge']));
    assert.deepStrictEqual(fs.readdirSync(root), ['demo-edge']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('download(): Bearer-Token, 404 → not_found, Größenlimit', async () => {
  const p = makePackage({ sign: 'trusted', trusted });
  let auth = null;
  const srv = http.createServer((req, res) => {
    auth = req.headers.authorization;
    if (req.url === '/api/v1/gateway/edge/packages/demo-edge/1.0.0') { res.end(p.buf); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const creds = { serverUrl: `http://gc.example.test:${srv.address().port}`, apiToken: 'gc_gw_x', serverAddrs: ['127.0.0.1'] };
  try {
    const buf = await packages.download(creds, 'demo-edge', '1.0.0');
    assert.ok(buf.equals(p.buf));
    assert.strictEqual(auth, 'Bearer gc_gw_x');
    await assert.rejects(packages.download(creds, 'demo-edge', '2.0.0'), (e) => e.code === 'not_found');
    assert.throws(() => packages.download(creds, '../x', '1.0.0'));
  } finally {
    srv.close();
  }
});
