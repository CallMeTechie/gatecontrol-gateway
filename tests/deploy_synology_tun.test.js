'use strict';

// deploy/synology-tun.sh: die Aufgabe für den DSM-Aufgabenplaner (Benutzer
// root, Ereignis „Hochfahren“) – Modul tun laden, /dev/net/tun anlegen, danach
// die Gateway-Container starten, die nicht laufen. `docker`, `modprobe`,
// `insmod`, `mknod` … sind hier Skripte, die ihre Aufrufe mitschreiben.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'synology-tun.sh');
const TEXT = fs.readFileSync(SCRIPT, 'utf8');

// Jeder Befehl schreibt "<name> <argumente>" nach $FAKE/calls. docker antwortet
// aus $FAKE: info schlägt fehl, solange info_fails eine Zahl > 0 enthält.
const FAKE = `#!/bin/sh
me="\${0##*/}"
echo "$me $*" >>"$FAKE/calls"
case "$me" in
  modprobe) [ -f "$FAKE/modprobe_fails" ] && exit 1 ;;
  find) cat "$FAKE/find" 2>/dev/null ;;
  docker)
    case "$*" in
      info)
        n="$(cat "$FAKE/info_fails" 2>/dev/null || echo 0)"
        if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$FAKE/info_fails"; exit 1; fi ;;
      "ps -aq --filter status=exited --filter status=created") cat "$FAKE/stopped" 2>/dev/null ;;
      "inspect -f "*) eval "id=\\\${$#}"; cat "$FAKE/inspect_$id" ;;
    esac ;;
esac
exit 0
`;

function setup({ stopped = {}, infoFails = 0, modprobeFails = false, ko = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tun-'));
  const fake = path.join(dir, 'fake');
  const bin = path.join(dir, 'bin');
  for (const d of [fake, bin]) fs.mkdirSync(d);
  for (const c of ['docker', 'modprobe', 'insmod', 'find', 'mkdir', 'mknod', 'chmod', 'sleep']) {
    fs.writeFileSync(path.join(bin, c), FAKE, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(fake, 'calls'), '');
  fs.writeFileSync(path.join(fake, 'find'), ko);
  fs.writeFileSync(path.join(fake, 'info_fails'), String(infoFails));
  if (modprobeFails) fs.writeFileSync(path.join(fake, 'modprobe_fails'), '');
  fs.writeFileSync(path.join(fake, 'stopped'), Object.keys(stopped).map((id) => id + '\n').join(''));
  for (const [id, what] of Object.entries(stopped)) fs.writeFileSync(path.join(fake, 'inspect_' + id), what + '\n');
  const run = (shell = 'sh') => spawnSync(shell, [SCRIPT], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, FAKE: fake } });
  const calls = () => fs.readFileSync(path.join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);
  return { run, calls };
}
const started = (calls) => calls.filter((c) => c.startsWith('docker start ')).map((c) => c.slice(13));
const GW = 'gateway ghcr.io/callmetechie/gatecontrol-gateway:latest';

describe('deploy/synology-tun.sh: task for the DSM Task Scheduler', () => {
  it('loads the module, creates the device and starts the stopped gateway container', () => {
    const t = setup({ stopped: { aaa: GW } });
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    const calls = t.calls();
    assert.equal(calls[0], 'modprobe tun');
    assert.ok(!calls.some((c) => c.startsWith('insmod')), 'modprobe worked: no insmod');
    assert.ok(calls.includes('mkdir -p /dev/net'));
    // der Knoten wird nur angelegt, wenn er fehlt (hängt vom Rechner ab, auf dem der Test läuft)
    let isChar = false;
    try { isChar = fs.statSync('/dev/net/tun').isCharacterDevice(); } catch { /* fehlt */ }
    assert.equal(calls.includes('mknod /dev/net/tun c 10 200'), !isChar);
    assert.ok(calls.includes('chmod 0666 /dev/net/tun'));
    assert.deepEqual(started(calls), ['aaa']);
    assert.ok(calls.indexOf('chmod 0666 /dev/net/tun') < calls.indexOf('docker start aaa'), 'device first, then the container');
    assert.ok(!calls.some((c) => c.startsWith('sleep')), 'docker answers at once: no waiting');
  });

  it('modprobe fails: insmod with the tun.ko of the NAS', () => {
    const t = setup({ modprobeFails: true, ko: '/lib/modules/tun.ko\n/lib/modules/backup/tun.ko.xz\n' });
    assert.equal(t.run().status, 0);
    assert.ok(t.calls().includes('insmod /lib/modules/tun.ko'));
  });

  it('no module file at all (tun built into the kernel): goes on without an error', () => {
    const t = setup({ modprobeFails: true, stopped: { aaa: GW } });
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(started(t.calls()), ['aaa']);
  });

  it('only the gateway containers that need the device: by compose service and image, whatever the project is called', () => {
    const t = setup({ stopped: {
      aaa: GW,
      bbb: 'otbr openthread/otbr:latest@sha256:329299a9',
      ccc: 'edge ghcr.io/callmetechie/gatecontrol-gateway:latest', // braucht kein tun
      ddd: 'gateway registry.example/api-gateway:1', // fremdes Projekt mit einem Dienst „gateway“
      eee: ' nginx:latest', // kein Compose-Container
      fff: 'office ghcr.io/callmetechie/gatecontrol-gateway:office',
    } });
    assert.equal(t.run().status, 0);
    assert.deepEqual(started(t.calls()), ['aaa', 'bbb']);
  });

  it('nothing stopped (everything runs, or tun was there anyway): starts nothing, creates nothing', () => {
    const t = setup();
    assert.equal(t.run().status, 0);
    assert.ok(!t.calls().some((c) => /^docker (start|run|create|compose|rm)/.test(c)), t.calls().join('\n'));
  });

  it('docker not up yet: waits in steps of 5 s, then starts', () => {
    const t = setup({ infoFails: 3, stopped: { aaa: GW } });
    assert.equal(t.run().status, 0);
    const calls = t.calls();
    assert.deepEqual(calls.filter((c) => c.startsWith('sleep')), ['sleep 5', 'sleep 5', 'sleep 5']);
    assert.deepEqual(started(calls), ['aaa']);
  });

  it('docker never answers: gives up after two minutes (24 tries), device prepared all the same', () => {
    const t = setup({ infoFails: 1000, stopped: { aaa: GW } });
    const r = t.run();
    assert.equal(r.status, 1);
    const calls = t.calls();
    assert.equal(calls.filter((c) => c === 'docker info').length, 24);
    assert.equal(calls.filter((c) => c === 'sleep 5').length, 23);
    assert.ok(calls.includes('chmod 0666 /dev/net/tun'));
    assert.deepEqual(started(calls), []);
  });

  it('runs the same under bash and dash', { skip: spawnSync('dash', ['-c', ':']).status !== 0 }, () => {
    for (const shell of ['bash', 'dash']) {
      const t = setup({ infoFails: 1, stopped: { aaa: GW } });
      const r = t.run(shell);
      assert.equal(r.status, 0, shell + ': ' + r.stderr);
      assert.deepEqual(started(t.calls()), ['aaa'], shell);
    }
  });

  it('stays small enough for the DSM text field and never creates or removes anything in docker', () => {
    assert.ok(TEXT.split('\n').length <= 20 && TEXT.length < 1000, 'short');
    assert.doesNotMatch(TEXT, /docker (run|create|rm|compose|pull)|up -d/);
    assert.doesNotMatch(TEXT, /\r|\t/);
  });

  it('the setup page (src/setup/ui/setup.js) shows exactly this script', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'setup', 'ui', 'setup.js'), 'utf8');
    const m = /var DSM_TUN_TASK = (\[[\s\S]*?\]\.join\('\\n'\));/.exec(js);
    assert.ok(m, 'DSM_TUN_TASK in setup.js');
    assert.equal(vm.runInNewContext(m[1]) + '\n', TEXT);
    assert.doesNotMatch(js, /insmod \/lib\/modules\/tun\.ko/);
  });

  it('docs/deployment/synology.md prints exactly this script', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'deployment', 'synology.md'), 'utf8');
    assert.ok(md.includes('```sh\n' + TEXT + '```'), 'script in synology.md');
    assert.doesNotMatch(md, /insmod \/lib\/modules\/tun\.ko/);
  });
});
