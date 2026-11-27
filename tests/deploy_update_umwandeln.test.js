'use strict';

// deploy/update.sh: nach einem gelungenen Gateway-Update wird auch das Image des
// Dienstes umwandeln (docs/transcode.md) erneuert – wie das Office-Image: nur wenn
// der Dienst in der Compose-Datei steht und sein Container auf dem Host angelegt
// ist. `docker` ist hier ein Skript, das seine Aufrufe mitschreibt.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'update.sh');

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >>"$FAKE/calls"
a="$*"
case "$a" in
  *"config --services"*) cat "$FAKE/services" ;;
  *"ps -a -q umwandeln"*) cat "$FAKE/umw_cid" 2>/dev/null || true ;;
  *"ps -a -q office"*) : ;;
  *"ps -q gateway"*) echo gwcid ;;
  *"pull umwandeln"*) [ -f "$FAKE/umw_pull_fails" ] && exit 1; echo sha256:newumw >"$FAKE/umw_image" ;;
  *"up -d --no-deps umwandeln"*) cp "$FAKE/umw_image" "$FAKE/umw_running_image" ;;
  "inspect --format {{.Image}} umwcid") cat "$FAKE/umw_running_image" ;;
  "inspect --format {{.State.Running}} umwcid") cat "$FAKE/umw_state" ;;
  "inspect --format {{.Image}} gwcid") echo sha256:gwimage ;;
  "inspect --format {{if .RepoDigests}}"*) echo ghcr.io/callmetechie/gatecontrol-gateway@sha256:abc ;;
  "inspect --format {{if .State.Health}}"*) cat "$FAKE/health" ;;
esac
exit 0
`;

function setup({ services = 'gateway\nedge\noffice\numwandeln\n', umw = 'running', health = 'healthy', pullFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-update-umw-'));
  const fake = path.join(dir, 'fake');
  const bin = path.join(dir, 'bin');
  const compose = path.join(dir, 'compose');
  const state = path.join(dir, 'state');
  for (const d of [fake, bin, compose, state]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(compose, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(fake, 'services'), services);
  fs.writeFileSync(path.join(fake, 'health'), health + '\n');
  fs.writeFileSync(path.join(fake, 'calls'), '');
  if (umw !== 'none') {
    fs.writeFileSync(path.join(fake, 'umw_cid'), 'umwcid\n');
    fs.writeFileSync(path.join(fake, 'umw_running_image'), 'sha256:oldumw\n');
    fs.writeFileSync(path.join(fake, 'umw_state'), umw === 'running' ? 'true\n' : 'false\n');
  }
  if (pullFails) fs.writeFileSync(path.join(fake, 'umw_pull_fails'), '');
  fs.writeFileSync(path.join(state, 'pending-update'), '{"request_id":"req-7"}');
  const run = () => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE: fake, GC_GW_COMPOSE_DIR: compose, GATEWAY_STATE_DIR: state, GC_GW_HEALTH_CEILING: '2' },
  });
  const calls = () => fs.readFileSync(path.join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);
  const lastPull = () => JSON.parse(fs.readFileSync(path.join(state, 'last-pull'), 'utf8'));
  const log = () => fs.readFileSync(path.join(state, 'update.log'), 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { run, calls, lastPull, log };
}
// Arbeitsordner aller Fälle, am Ende entfernt
const t = { fns: [], after(fn) { this.fns.push(fn); } };
after(() => { for (const fn of t.fns.splice(0)) fn(); });

const umwCalls = (calls) => calls.filter((c) => /\bumwandeln$|image rm/.test(c) && !/config --services/.test(c));

describe('deploy/update.sh: the umwandeln image is renewed with the gateway', () => {
  it('in the compose file and running: pulled with its profile, recreated, the old image freed — after last-pull and after office', () => {
    const x = setup();
    const r = x.run();
    assert.equal(r.status, 0, r.stderr);
    const calls = x.calls();
    assert.equal(x.lastPull().ok, true);
    assert.equal(x.lastPull().request_id, 'req-7');
    const gw = calls.findIndex((c) => /up -d --force-recreate gateway$/.test(c));
    const office = calls.findIndex((c) => /--profile office .* ps -a -q office$/.test(c));
    const pull = calls.findIndex((c) => /--profile umwandeln .* pull umwandeln$/.test(c));
    const up = calls.findIndex((c) => /--profile umwandeln .* up -d --no-deps umwandeln$/.test(c));
    const rm = calls.indexOf('image rm sha256:oldumw');
    assert.ok(gw >= 0 && office > gw && pull > office && up > pull && rm > up, calls.join('\n'));
    assert.match(x.log(), /wrote last-pull ok=true[\s\S]*umwandeln: renewing image[\s\S]*umwandeln: done/);
  });

  it('only in the compose file, never started on this host: the image is left alone', () => {
    const x = setup({ umw: 'none' });
    assert.equal(x.run().status, 0);
    assert.equal(umwCalls(x.calls()).length, 1);
    assert.match(umwCalls(x.calls())[0], /--profile umwandeln .* ps -a -q umwandeln$/);
    assert.match(x.log(), /umwandeln: in compose, no container on this host/);
  });

  it('no umwandeln service in the compose file (older file, Pi image): nothing about it at all', () => {
    const x = setup({ services: 'gateway\nedge\noffice\n' });
    assert.equal(x.run().status, 0);
    assert.deepEqual(umwCalls(x.calls()), []);
    assert.doesNotMatch(x.log(), /umwandeln/);
  });

  it('a stopped container gets the new image but is not started; a failing download changes nothing', () => {
    const x = setup({ umw: 'stopped' });
    assert.equal(x.run().status, 0);
    const c = umwCalls(x.calls());
    assert.ok(c.some((v) => / pull umwandeln$/.test(v)));
    assert.ok(!c.some((v) => / up -d /.test(v) || /^image rm/.test(v)), c.join('\n'));
    const y = setup({ pullFails: true });
    assert.equal(y.run().status, 0);
    assert.equal(y.lastPull().ok, true);
    assert.match(y.log(), /umwandeln: pull failed — keeping the current image/);
    assert.ok(!umwCalls(y.calls()).some((v) => / up -d /.test(v)));
  });

  it('after a rollback (unhealthy gateway) the image is not touched', () => {
    const x = setup({ health: 'unhealthy' });
    assert.equal(x.run().status, 0);
    assert.equal(x.lastPull().ok, false);
    assert.deepEqual(umwCalls(x.calls()), []);
  });
});
