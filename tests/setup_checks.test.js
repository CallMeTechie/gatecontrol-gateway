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

  it('creates the missing device node (compose with device_cgroup_rules) and reports a missing module', async () => {
    const calls = [];
    let exists = false;
    const fsImpl = {
      openSync: () => { if (!exists) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return 3; },
      closeSync: () => {}, mkdirSync: () => {}, chmodSync: () => {},
    };
    const exec = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); exists = true; return true; };
    assert.equal(await tunUsable({ dev: '/dev/net/tun', exec, fsImpl }), true);
    assert.deepEqual(calls, ['mknod /dev/net/tun c 10 200']);

    // Knoten da, Modul nicht geladen (Synology vor insmod): ENODEV
    const noModule = { openSync: () => { throw Object.assign(new Error('x'), { code: 'ENODEV' }); }, closeSync: () => {} };
    assert.equal(await tunUsable({ exec: async () => { throw new Error('no mknod'); }, fsImpl: noModule }), false);
    // mknod nicht erlaubt
    const missing = { openSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, closeSync: () => {}, mkdirSync: () => {} };
    assert.equal(await tunUsable({ exec: async () => false, fsImpl: missing }), false);
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

  it('caches for 10 s, "check again" at most every 2 s', async () => {
    let t = 0;
    let runs = 0;
    const deps = {
      internetAndClock: async () => { runs += 1; return { internet: true, clock: true }; },
      vpnDevice: async () => ({ ok: true }),
      configWritable: () => true,
    };
    const checks = createChecks({ configDir: '/x', deps, now: () => t });
    assert.deepEqual(await checks.get(), { internet: true, clock: true, tun: true, config: true });
    t = 9_000; await checks.get();
    assert.equal(runs, 1);
    t = 10_500; await checks.get();
    assert.equal(runs, 2);
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
