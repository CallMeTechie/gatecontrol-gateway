'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkFence, probe } = require('../src/edge/fence');

const blocked = async () => ({ v4: 'EPERM', v6: 'ENETUNREACH', blocked: true });
const open = async () => ({ v4: 'SENT', v6: 'SENT', blocked: false });

test('fail closed: Marker frisch + passende UID + Probe EPERM nötig', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edge-fence-'));
  const write = (m) => fs.writeFileSync(path.join(dir, 'fence.json'), JSON.stringify(m));
  const now = Date.now();
  try {
    assert.deepStrictEqual(await checkFence({ runDir: dir, probeFn: blocked }), { active: false, backend: null, reason: 'no_marker' });
    write({ active: true, backend: 'nft', uid: 61001, appliedAt: new Date(now).toISOString() });
    assert.deepStrictEqual(await checkFence({ runDir: dir, probeFn: blocked }), { active: true, backend: 'nft', reason: null });
    assert.strictEqual((await checkFence({ runDir: dir, probeFn: open })).reason, 'probe_sent', 'Regeln greifen nicht');
    assert.strictEqual((await checkFence({ runDir: dir, probeFn: blocked, now: () => now + 4 * 60 * 1000 })).reason, 'marker_stale');
    write({ active: true, backend: 'nft', uid: 1000, appliedAt: new Date(now).toISOString() });
    assert.strictEqual((await checkFence({ runDir: dir, probeFn: blocked })).reason, 'uid_mismatch');
    write({ active: false, backend: 'iptables', error: 'xt_owner fehlt', uid: 61001, appliedAt: new Date(now).toISOString() });
    assert.strictEqual((await checkFence({ runDir: dir, probeFn: blocked })).reason, 'xt_owner fehlt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Probe: nur EPERM bei IPv4 zählt; IPv6 darf auch ohne Route sein', async () => {
  const mk = (v4, v6) => async (type) => (type === 'udp4' ? v4 : v6);
  assert.strictEqual((await probe({ send: mk('EPERM', 'EPERM') })).blocked, true);
  assert.strictEqual((await probe({ send: mk('EPERM', 'ENETUNREACH') })).blocked, true);
  assert.strictEqual((await probe({ send: mk('EPERM', 'SENT') })).blocked, false);
  assert.strictEqual((await probe({ send: mk('ENETUNREACH', 'EPERM') })).blocked, false);
  assert.strictEqual((await probe({ send: mk('SENT', 'EPERM') })).blocked, false);
});
