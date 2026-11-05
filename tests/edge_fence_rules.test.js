'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FenceManager, buildNftRuleset, buildIptablesRestore, jumpArgs } = require('../src/edge/fenceRules');

const input = { uid: 61001, lanCidrs: ['192.168.1.0/24'], serverAddrs: ['203.0.113.7', '2001:db8::7'], serverPort: 443, tunnelIp: '10.8.0.5' };

test('nft: eigene Tabelle, atomar ersetzt, Owner-Match, Erlaubtes vor DROP', () => {
  const r = buildNftRuleset(input);
  const lines = r.split('\n').map((l) => l.trim());
  assert.deepStrictEqual(lines.slice(0, 3), ['table inet gc_edge', 'delete table inet gc_edge', 'table inet gc_edge {']);
  assert.ok(lines.includes('meta skuid 61001 jump edge'));
  const order = ['oifname "lo" tcp dport 1883 accept', 'ip daddr { 203.0.113.7 } tcp dport 443 accept', 'ip6 daddr { 2001:db8::7 } tcp dport 443 accept',
    'ip daddr 10.8.0.5 drop', 'oifname "gatecontrol0" drop', 'ip daddr 224.0.0.0/4 accept', 'ip daddr { 192.168.1.0/24 } accept', 'counter drop'];
  let last = -1;
  for (const o of order) { const i = lines.indexOf(o); assert.ok(i > last, o); last = i; }
  // ohne Server/LAN keine leeren Mengen
  const r2 = buildNftRuleset({ ...input, lanCidrs: [], serverAddrs: [] });
  assert.ok(!r2.includes('{  }') && !r2.includes('{ }'));
  assert.throws(() => buildNftRuleset({ ...input, lanCidrs: ['192.168.1.0/24; flush ruleset'] }));
  assert.throws(() => buildNftRuleset({ ...input, serverAddrs: ['evil host'] }));
  assert.throws(() => buildNftRuleset({ ...input, uid: 0 }));
});

test('iptables-legacy: Kette GC_EDGE per restore, IPv6 nur Broker + Server', () => {
  const r4 = buildIptablesRestore(input, 4).split('\n');
  assert.deepStrictEqual(r4.slice(0, 2), ['*filter', ':GC_EDGE - [0:0]']);
  assert.ok(r4.includes('-A GC_EDGE -d 203.0.113.7/32 -p tcp --dport 443 -j ACCEPT'));
  assert.ok(r4.includes('-A GC_EDGE -d 10.8.0.5/32 -j DROP'));
  assert.ok(r4.includes('-A GC_EDGE -d 192.168.1.0/24 -j ACCEPT'));
  assert.strictEqual(r4[r4.length - 3], '-A GC_EDGE -j DROP');
  const r6 = buildIptablesRestore(input, 6);
  assert.ok(r6.includes('-A GC_EDGE -d 2001:db8::7/128 -p tcp --dport 443 -j ACCEPT'));
  assert.ok(!r6.includes('192.168'));
  assert.deepStrictEqual(jumpArgs('-I', 61001), ['-I', 'OUTPUT', '1', '-m', 'owner', '--uid-owner', '61001', '-j', 'GC_EDGE']);
});

function fakeExec(behaviour) {
  const calls = [];
  const exec = async (bin, args, stdin) => {
    calls.push({ bin, args, stdin });
    return behaviour(bin, args, stdin) || { ok: false, stderr: 'nope', stdout: '' };
  };
  return { exec, calls };
}

test('auto: nft zuerst; schlägt nft fehl (DSM), dann iptables-legacy; Marker mit Ergebnis', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-fence-'));
  try {
    let loaded = null;
    const nftOk = fakeExec((bin, args) => {
      if (bin !== 'nft') return null;
      if (args[0] === '-f') loaded = fs.readFileSync(args[1], 'utf8'); // Skript als Datei (nicht über stdin)
      return { ok: true, stdout: args[0] === 'list' ? 'meta skuid 61001 jump edge' : '', stderr: '' };
    });
    const f = new FenceManager({ runDir: dir, exec: nftOk.exec, env: {} });
    assert.deepStrictEqual(await f.apply(input), { active: true, backend: 'nft', error: null });
    assert.match(loaded, /^table inet gc_edge\ndelete table inet gc_edge\n/);
    assert.ok(!fs.existsSync(nftOk.calls.find((c) => c.args[0] === '-f').args[1]), 'Skriptdatei wieder gelöscht');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'fence.json'), 'utf8'));
    assert.strictEqual(m.active, true);
    assert.strictEqual(m.uid, 61001);
    assert.strictEqual(fs.statSync(path.join(dir, 'fence.json')).mode & 0o777, 0o440);
    // unverändert → nur prüfen, nicht neu laden
    nftOk.calls.length = 0;
    await f.apply(input);
    assert.deepStrictEqual(nftOk.calls.map((c) => c.args[0]), ['list']);

    const jump = new Set();
    const dsm = fakeExec((bin, args) => {
      if (bin === 'nft') return { ok: false, stderr: 'Error: Could not process rule: Operation not supported' };
      if (bin.endsWith('-restore')) return { ok: true, stdout: '', stderr: '' };
      if (args[0] === '-C') return jump.has(bin) ? { ok: true } : { ok: false, stderr: 'no rule' };
      if (args[0] === '-I') { jump.add(bin); return { ok: true }; }
      return null;
    });
    const g = new FenceManager({ runDir: dir, exec: dsm.exec, env: {}, hasIpv6: () => true });
    assert.deepStrictEqual(await g.apply(input), { active: true, backend: 'iptables', error: null });
    assert.ok(dsm.calls.some((c) => c.bin === 'iptables-restore' && c.args[0] === '--noflush' && c.stdin.includes(':GC_EDGE')));
    assert.ok(dsm.calls.some((c) => c.bin === 'ip6tables' && c.args[0] === '-I'));
    // beim nächsten Mal zuerst das funktionierende Backend
    dsm.calls.length = 0;
    await g.apply(input);
    assert.strictEqual(dsm.calls[0].bin, 'iptables-restore');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail closed: nichts geht → Marker active:false mit Grund; IPv6 ohne ip6tables nur ohne IPv6 ok', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-fence-'));
  try {
    const none = fakeExec(() => null);
    const f = new FenceManager({ runDir: dir, exec: none.exec, env: {} });
    const st = await f.apply(input);
    assert.strictEqual(st.active, false);
    assert.match(st.error, /nft/);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'fence.json'), 'utf8'));
    assert.strictEqual(m.active, false);

    const v4only = fakeExec((bin) => (bin.startsWith('ip6') ? null : (bin === 'nft' ? null : { ok: true, stdout: '', stderr: '' })));
    const withV6 = new FenceManager({ runDir: dir, exec: v4only.exec, env: { GC_FENCE_BACKEND: 'iptables' }, hasIpv6: () => true });
    assert.strictEqual((await withV6.apply(input)).active, false);
    const noV6 = new FenceManager({ runDir: dir, exec: v4only.exec, env: { GC_FENCE_BACKEND: 'iptables' }, hasIpv6: () => false });
    assert.strictEqual((await noV6.apply(input)).active, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
