'use strict';

// docker-compose.tun-loader.yml („VPN-Gerät automatisch bereitstellen“, wählbar):
// der Einmal-Dienst tun-loader lädt auf der Synology das Kernel-Modul tun, wenn
// /dev/net/tun fehlt. Geprüft wird das Skript, wie es in der Datei steht (`$$` →
// `$`), mit Attrappen für insmod/modprobe – und deploy/update.sh, das ein nach
// einem Neustart liegen gebliebenes Gateway wieder startet. `docker` ist ein
// Skript, das seine Aufrufe mitschreibt.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ADDON = fs.readFileSync(path.join(ROOT, 'docker-compose.tun-loader.yml'), 'utf8');
const EXAMPLE = fs.readFileSync(path.join(ROOT, 'docker-compose.example.yml'), 'utf8');
const UPDATE_SH = path.join(ROOT, 'deploy', 'update.sh');

// der Dienst tun-loader als Text (bis zum nächsten Dienst) und sein Skript
const SERVICE = ADDON.slice(ADDON.indexOf('  tun-loader:\n'), ADDON.indexOf('\n  gateway:\n'));
function script() {
  const ls = SERVICE.split('\n');
  const start = ls.findIndex((l) => l.trim() === '- |');
  assert.ok(start > 0, 'Skriptblock gefunden');
  const out = [];
  for (let i = start + 1; i < ls.length && (/^ {8}/.test(ls[i]) || ls[i].trim() === ''); i++) out.push(ls[i].slice(8));
  assert.ok(out.length > 5 && /exit 1/.test(out[out.length - 1]), 'das ganze Skript');
  return out.join('\n').replace(/\$\$/g, '$') + '\n';
}

// Attrappe: schreibt den Aufruf mit; „lädt“ das Modul, indem sie das Gerät in die
// Liste der misc-Geräte einträgt (/proc/misc: „200 tun“, sobald tun geladen ist)
const FAKE_TOOL = `#!/bin/sh
echo "$(basename "$0") $*" >>"$FAKE/calls"
mode="$(cat "$FAKE/mode")"
case "$mode" in
  ok) echo "200 tun" >>"$GC_TUN_MISC" ;;
  loaded) echo "insmod: can't insert '$1': File exists" >&2; exit 17 ;;
  fail) echo "insmod: can't insert '$1': Operation not permitted" >&2; exit 1 ;;
esac
`;

function run({ device = false, ko = true, mode = 'ok' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tun-'));
  const bin = path.join(dir, 'bin');
  const fake = path.join(dir, 'fake');
  fs.mkdirSync(bin); fs.mkdirSync(fake);
  for (const t of ['insmod', 'modprobe']) fs.writeFileSync(path.join(bin, t), FAKE_TOOL, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'mode'), mode);
  fs.writeFileSync(path.join(fake, 'calls'), '');
  // wie /proc/misc: andere Geräte stehen immer drin, auch eines mit ähnlichem Namen
  const misc = path.join(dir, 'misc');
  fs.writeFileSync(misc, ' 59 memory_bandwidth\n229 fuse\n 58 tunnel6\n' + (device ? '200 tun\n' : ''));
  const koPath = path.join(dir, 'tun.ko');
  if (ko) fs.writeFileSync(koPath, '');
  const r = spawnSync('/bin/sh', ['-c', script()], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE: fake, GC_TUN_MISC: misc, GC_TUN_KO: koPath, GC_TUN_WAIT: '1' },
  });
  const calls = fs.readFileSync(path.join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr, calls, koPath };
}

describe('tun-loader: das Skript des Dienstes', () => {
  it('Gerät ist da → sofort Erfolg, nichts wird geladen', () => {
    const r = run({ device: true });
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls, []);
    assert.match(r.out, /ist da, nichts zu laden \/ is present, nothing to load/);
  });
  it('Gerät fehlt, tun.ko liegt da (Synology) → insmod <Pfad>, Erfolg', () => {
    const r = run();
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls, [`insmod ${r.koPath}`]);
    assert.match(r.out, /ist bereit \/ is ready/);
  });
  it('kein tun.ko (keine Synology) → modprobe tun; das Gateway darf in jedem Fall starten', () => {
    for (const mode of ['ok', 'fail']) {
      const r = run({ ko: false, mode });
      assert.equal(r.status, 0, mode);
      assert.deepEqual(r.calls, ['modprobe tun']);
      assert.match(r.out, /keine Synology.*not a Synology/);
      assert.doesNotMatch(r.out, /FEHLER|ERROR/);
    }
  });
  it('Laden scheitert → Meldung DE/EN mit dem bisherigen Weg, Exit ≠ 0', () => {
    const r = run({ mode: 'fail' });
    assert.equal(r.status, 1);
    assert.match(r.out, /insmod: .*Operation not permitted/);
    assert.match(r.out, /FEHLER: .*Aufgabenplaner.*insmod \/lib\/modules\/tun\.ko/);
    assert.match(r.out, /ERROR: .*Task Scheduler.*insmod \/lib\/modules\/tun\.ko/);
  });
  it('Modul schon geladen, Gerät fehlt trotzdem → kein Erfolg ohne Gerät', () => {
    const r = run({ mode: 'loaded' });
    assert.equal(r.status, 1);
    assert.match(r.out, /File exists/);
    assert.match(r.out, /FEHLER: /);
  });
  it('ohne Befehl insmod (anderes Image) → Meldung, Exit ≠ 0', () => {
    const r = run({ mode: 'none' });   // die Attrappe legt kein Gerät an
    assert.equal(r.status, 1);
    assert.match(r.out, /FEHLER: /);
  });
  it('shellcheck (falls vorhanden): das Skript ist sauberes POSIX-sh', (t) => {
    if (spawnSync('shellcheck', ['--version']).status !== 0) return t.skip('shellcheck fehlt');
    const r = spawnSync('shellcheck', ['-s', 'sh', '-S', 'warning', '-'], { input: script(), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('tun-loader: der Dienst in docker-compose.tun-loader.yml', () => {
  const has = (re) => assert.match(SERVICE, re);
  it('so wenig Rechte wie möglich: nur SYS_MODULE, kein Netz, nur lesbar, kein privileged, kein Neustart', () => {
    has(/\n {4}cap_drop:\n {6}- ALL\n {4}cap_add:\n {6}- SYS_MODULE[^\n]*\n {4}security_opt:/);
    has(/\n {4}network_mode: none/);
    has(/\n {4}read_only: true\n/);
    has(/\n {4}restart: "no"\n/);
    has(/\n {6}- no-new-privileges:true\n/);
    assert.doesNotMatch(SERVICE, /privileged|MKNOD|SYS_ADMIN|docker\.sock/);
    const mounts = SERVICE.split('\n').filter((l) => /^ {6}- \//.test(l) && !/\/bin\/sh/.test(l)).map((l) => l.trim().split(/\s+/)[1]);
    assert.deepEqual(mounts, ['/lib/modules:/lib/modules:ro']);
  });
  it('dasselbe Image wie das Gateway (kein fremdes Image)', () => {
    has(/\n {4}image: ghcr\.io\/callmetechie\/gatecontrol-gateway:latest\n/);
  });
  it('das Gateway wartet auf den Dienst – und bekommt sonst nichts dazu', () => {
    const gw = ADDON.slice(ADDON.indexOf('\n  gateway:\n') + 1).replace(/\s+$/, '');
    assert.equal(gw, ['  gateway:', '    depends_on:', '      tun-loader:', '        condition: service_completed_successfully'].join('\n'));
  });
  it('docker-compose.example.yml bleibt ohne den Dienst (wählbar), /dev/net/tun wie bisher', () => {
    assert.doesNotMatch(EXAMPLE, /^\s+tun-loader:/m);
    assert.doesNotMatch(EXAMPLE.slice(0, EXAMPLE.indexOf('\n  edge:\n')), /depends_on:|SYS_MODULE|device_cgroup_rules:/);
    assert.match(EXAMPLE, /\n {4}devices:\n {6}- \/dev\/net\/tun:\/dev\/net\/tun\n/);
  });
});

// ── deploy/update.sh: Gateway nach einem Neustart ohne /dev/net/tun wieder starten ──
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE/calls"
case "$*" in
  *"ps -a -q gateway"*) cat "$FAKE/cid" 2>/dev/null || true ;;
  "inspect --format {{.State.Running}} gwcid") cat "$FAKE/running" ;;
  "inspect --format {{.State.Error}} gwcid") cat "$FAKE/error" ;;
  *"up -d --no-recreate gateway"*) [ -f "$FAKE/up_fails" ] && exit 1 ;;
esac
exit 0
`;
const TUN_ERROR = 'error gathering device information while adding custom device "/dev/net/tun": no such file or directory';

function update({ loader = true, cid = true, running = 'false', error = TUN_ERROR, upFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tunheal-'));
  const [fake, bin, compose, state] = ['fake', 'bin', 'compose', 'state'].map((d) => path.join(dir, d));
  for (const d of [fake, bin, compose, state]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(compose, 'docker-compose.yml'), loader ? 'services:\n  gateway:\n    image: x\n  tun-loader:\n    image: x\n' : 'services:\n  gateway:\n    image: x\n');
  if (cid) fs.writeFileSync(path.join(fake, 'cid'), 'gwcid\n');
  fs.writeFileSync(path.join(fake, 'running'), running + '\n');
  fs.writeFileSync(path.join(fake, 'error'), error + '\n');
  fs.writeFileSync(path.join(fake, 'calls'), '');
  if (upFails) fs.writeFileSync(path.join(fake, 'up_fails'), '');
  const run = () => spawnSync('bash', [UPDATE_SH], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE: fake, GC_GW_COMPOSE_DIR: compose, GATEWAY_STATE_DIR: state },
  });
  const calls = () => fs.readFileSync(path.join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);
  const ups = () => calls().filter((c) => / up /.test(c));
  const log = () => { try { return fs.readFileSync(path.join(state, 'update.log'), 'utf8'); } catch { return ''; } };
  return { run, calls, ups, log, state, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('deploy/update.sh: Gateway ohne /dev/net/tun wieder starten (nur mit tun-loader)', () => {
  it('Startfehler nennt /dev/net/tun → Projekt starten (tun-loader zuerst), ohne Container neu anzulegen', () => {
    const u = update();
    assert.equal(u.run().status, 0);
    assert.equal(u.ups().length, 1);
    assert.match(u.ups()[0], /docker-compose\.yml up -d --no-recreate gateway$/);
    assert.match(u.log(), /tun: gateway started/);
    // kein Update: ohne Flag wird nichts geladen und kein last-pull geschrieben
    assert.ok(!u.calls().some((c) => / pull /.test(c)));
    assert.ok(!fs.existsSync(path.join(u.state, 'last-pull')));
    u.cleanup();
  });
  it('höchstens alle 10 Minuten ein Versuch', () => {
    const u = update({ upFails: true });
    u.run(); u.run();
    assert.equal(u.ups().length, 1);
    assert.match(u.log(), /tun: start failed/);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(path.join(u.state, 'tun-heal'), old, old);
    u.run();
    assert.equal(u.ups().length, 2);
    u.cleanup();
  });
  it('ohne den Dienst tun-loader bleibt alles wie bisher (kein docker-Aufruf ohne Flag)', () => {
    const u = update({ loader: false });
    assert.equal(u.run().status, 0);
    assert.deepEqual(u.calls(), []);
    u.cleanup();
  });
  it('von Hand gestoppt (kein Startfehler), anderer Fehler, läuft, nie angelegt → nichts', () => {
    for (const o of [{ error: '' }, { error: 'driver failed programming external connectivity' }, { running: 'true' }, { cid: false }]) {
      const u = update(o);
      assert.equal(u.run().status, 0);
      assert.deepEqual(u.ups(), [], JSON.stringify(o));
      u.cleanup();
    }
  });
});
