'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChecks, ready, checkInternetAndClock, checkVpnDevice, checkConfigWritable, tunUsable } = require('../src/setup/checks');

const NOW = Date.parse('2026-11-11T10:00:00Z');
const now = () => NOW;

describe('setup page: self checks', () => {
  it('internet reachable and clock right', async () => {
    const r = await checkInternetAndClock({ probe: async () => ({ reachable: true, date: NOW - 20_000, clockError: false }), now, floor: 0 });
    assert.deepEqual(r, { internet: true, clock: true });
  });

  it('uses the second target when the first does not answer', async () => {
    const seen = [];
    const r = await checkInternetAndClock({
      probe: async (h) => { seen.push(h); return h === '9.9.9.9' ? { reachable: true, date: NOW, clockError: false } : { reachable: false, date: null, clockError: false }; },
      now, floor: 0,
    });
    assert.deepEqual(seen, ['1.1.1.1', '9.9.9.9']);
    assert.deepEqual(r, { internet: true, clock: true });
  });

  it('no internet: clock stays unknown unless it is before the build', async () => {
    const down = async () => ({ reachable: false, date: null, clockError: false });
    assert.deepEqual(await checkInternetAndClock({ probe: down, now, floor: NOW - 1000 }), { internet: false, clock: null });
    assert.deepEqual(await checkInternetAndClock({ probe: down, now, floor: NOW + 86_400_000 }), { internet: false, clock: false });
  });

  it('clock off by more than ten minutes is wrong', async () => {
    const r = await checkInternetAndClock({ probe: async () => ({ reachable: true, date: NOW + 11 * 60_000, clockError: false }), now, floor: 0 });
    assert.deepEqual(r, { internet: true, clock: false });
  });

  it('a certificate "not yet valid" means: reachable, own clock wrong', async () => {
    const r = await checkInternetAndClock({ probe: async () => ({ reachable: true, date: null, clockError: true }), now, floor: 0 });
    assert.deepEqual(r, { internet: true, clock: false });
  });

  it('VPN device: /dev/net/tun or kernel WireGuard', async () => {
    assert.deepEqual(await checkVpnDevice({ tunUsable: async () => true, kernelWireguard: async () => { throw new Error('not asked'); } }), { ok: true, via: 'tun' });
    assert.deepEqual(await checkVpnDevice({ tunUsable: async () => false, kernelWireguard: async () => true }), { ok: true, via: 'kernel' });
    assert.deepEqual(await checkVpnDevice({ tunUsable: async () => false, kernelWireguard: async () => false }), { ok: false, via: null });
  });

  it('/dev/net/tun: usable when it opens; a missing device or module is reported, nothing is created', async () => {
    const ok = { openSync: () => 3, closeSync: () => {} };
    assert.equal(await tunUsable({ fsImpl: ok }), true);
    const calls = [];
    const failing = (code) => ({
      openSync: () => { throw Object.assign(new Error('x'), { code }); }, closeSync: () => {},
      mkdirSync: () => calls.push('mkdir'), chmodSync: () => calls.push('chmod'), writeFileSync: () => calls.push('write'),
    });
    // Gerät nicht in den Container eingebunden / Modul nicht geladen
    assert.equal(await tunUsable({ fsImpl: failing('ENOENT') }), false);
    assert.equal(await tunUsable({ fsImpl: failing('ENODEV') }), false);
    assert.deepEqual(calls, [], 'the gateway never creates the device node itself');
    assert.doesNotMatch(require('node:fs').readFileSync(require.resolve('../src/setup/checks'), 'utf8'), /mknod/);
  });

  it('config folder: real write probe, nothing left behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-setup-'));
    assert.equal(checkConfigWritable(dir), true);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(checkConfigWritable(path.join(dir, 'missing')), false);
    const ro = { writeFileSync: () => { throw Object.assign(new Error('ro'), { code: 'EROFS' }); }, unlinkSync: () => {} };
    assert.equal(checkConfigWritable(dir, { fsImpl: ro }), false);
    fs.rmSync(dir, { recursive: true });
  });

  it('caches between two polls of the page (10 s), "check again" at most every 2 s', async () => {
    let t = 0;
    let runs = 0;
    const deps = {
      internetAndClock: async () => { runs += 1; return { internet: true, clock: true }; },
      vpnDevice: async () => ({ ok: true }),
      configWritable: () => true,
    };
    const checks = createChecks({ configDir: '/x', deps, now: () => t });
    assert.deepEqual(await checks.get(), { internet: true, clock: true, tun: true, config: true });
    t = 7_000; await checks.get();
    assert.equal(runs, 1);
    t = 10_000; await checks.get();
    assert.equal(runs, 2, 'the next poll of the page (10 s later) is fresh');
    t = 11_000; await checks.get({ force: true });
    assert.equal(runs, 2);
    t = 13_000; await checks.get({ force: true });
    assert.equal(runs, 3);
    // gleichzeitige Abfragen teilen sich einen Lauf
    t = 60_000; await Promise.all([checks.get(), checks.get(), checks.get()]);
    assert.equal(runs, 4);
  });

  it('ready: everything there; an unknown clock does not block', () => {
    assert.equal(ready({ internet: true, clock: true, tun: true, config: true }), true);
    assert.equal(ready({ internet: true, clock: null, tun: true, config: true }), true);
    assert.equal(ready({ internet: true, clock: false, tun: true, config: true }), false);
    assert.equal(ready({ internet: false, clock: true, tun: true, config: true }), false);
    assert.equal(ready({ internet: true, clock: true, tun: false, config: true }), false);
    assert.equal(ready({ internet: true, clock: true, tun: true, config: false }), false);
    assert.equal(ready(null), false);
  });
});
