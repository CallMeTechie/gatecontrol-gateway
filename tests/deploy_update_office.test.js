'use strict';

// deploy/update.sh: nach einem gelungenen Gateway-Update wird das Office-Image
// (Dienst office, docs/print.md) mit erneuert – wenn der Dienst in der
// Compose-Datei steht und sein Container auf dem Host angelegt ist. `docker`
// ist hier ein Skript, das seine Aufrufe mitschreibt.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'update.sh');

const FAKE_DOCKER = `#!/usr/bin/env bash
# Ersatz für docker: schreibt jeden Aufruf mit und antwortet aus Dateien in $FAKE.
echo "$*" >>"$FAKE/calls"
a="$*"
case "$a" in
  *"config --services"*) cat "$FAKE/services" ;;
  *"ps -a -q office"*) cat "$FAKE/office_cid" 2>/dev/null || true ;;
  *"ps -q gateway"*) echo gwcid ;;
  *"pull office"*) [ -f "$FAKE/office_pull_fails" ] && exit 1; echo sha256:newoffice >"$FAKE/office_image" ;;
  *"up -d --no-deps office"*) cp "$FAKE/office_image" "$FAKE/office_running_image" ;;
  "inspect --format {{.Image}} offcid") cat "$FAKE/office_running_image" ;;
  "inspect --format {{.State.Running}} offcid") cat "$FAKE/office_state" ;;
  "inspect --format {{.Image}} gwcid") echo sha256:gwimage ;;
  "inspect --format {{if .RepoDigests}}"*) echo ghcr.io/callmetechie/gatecontrol-gateway@sha256:abc ;;
  "inspect --format {{if .State.Health}}"*) cat "$FAKE/health" ;;
esac
exit 0
`;

function setup({ services = 'gateway\nedge\nmqtt\noffice\n', office = 'running', health = 'healthy', flag = true, pullFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-update-'));
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
  if (office !== 'none') {
    fs.writeFileSync(path.join(fake, 'office_cid'), 'offcid\n');
    fs.writeFileSync(path.join(fake, 'office_running_image'), 'sha256:oldoffice\n');
    fs.writeFileSync(path.join(fake, 'office_state'), office === 'running' ? 'true\n' : 'false\n');
  }
  if (pullFails) fs.writeFileSync(path.join(fake, 'office_pull_fails'), '');
  if (flag) fs.writeFileSync(path.join(state, 'pending-update'), '{"request_id":"req-1"}');
  const run = () => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE: fake, GC_GW_COMPOSE_DIR: compose, GATEWAY_STATE_DIR: state, GC_GW_HEALTH_CEILING: '2' },
  });
  const calls = () => fs.readFileSync(path.join(fake, 'calls'), 'utf8').split('\n').filter(Boolean);
  const lastPull = () => JSON.parse(fs.readFileSync(path.join(state, 'last-pull'), 'utf8'));
  const log = () => fs.readFileSync(path.join(state, 'update.log'), 'utf8');
  return { run, calls, lastPull, log, state };
}

const officeCalls = (calls) => calls.filter((c) => /\boffice\b|image rm/.test(c) && !/config --services/.test(c));

describe('deploy/update.sh: the office image is renewed with the gateway', () => {
  it('office in the compose file and running: pulled, recreated, the old image freed — after last-pull', () => {
    const t = setup();
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    const calls = t.calls();
    assert.deepEqual(t.lastPull().ok, true);
    assert.equal(t.lastPull().request_id, 'req-1');
    const pull = calls.findIndex((c) => /--profile office .* pull office$/.test(c));
    const up = calls.findIndex((c) => /--profile office .* up -d --no-deps office$/.test(c));
    const rm = calls.indexOf('image rm sha256:oldoffice');
    const gw = calls.findIndex((c) => /up -d --force-recreate gateway$/.test(c));
    const edge = calls.findIndex((c) => /up -d --no-deps edge$/.test(c));
    assert.ok(gw >= 0 && edge > gw, 'gateway, then edge');
    assert.ok(pull > edge && up > pull && rm > up, calls.join('\n'));
    assert.match(t.log(), /wrote last-pull ok=true[\s\S]*office: renewing image[\s\S]*office: done/);
  });

  it('office only in the compose file, never started on this host: the image is left alone', () => {
    const t = setup({ office: 'none' });
    assert.equal(t.run().status, 0);
    assert.deepEqual(officeCalls(t.calls()), ['compose --profile office -f ' + path.join(path.dirname(t.state), 'compose', 'docker-compose.yml') + ' ps -a -q office']);
    assert.equal(t.lastPull().ok, true);
    assert.match(t.log(), /office: in compose, no container on this host/);
  });

  it('no office service in the compose file (older file): nothing about office at all', () => {
    const t = setup({ services: 'gateway\nedge\nmqtt\n' });
    assert.equal(t.run().status, 0);
    assert.deepEqual(officeCalls(t.calls()), []);
    assert.doesNotMatch(t.log(), /office/);
  });

  it('a stopped office container gets the new image, but is not started', () => {
    const t = setup({ office: 'stopped' });
    assert.equal(t.run().status, 0);
    const c = officeCalls(t.calls());
    assert.ok(c.some((x) => / pull office$/.test(x)));
    assert.ok(!c.some((x) => / up -d /.test(x) || /^image rm/.test(x)), c.join('\n'));
  });

  it('a failing office download does not turn a good gateway update into a failed one', () => {
    const t = setup({ pullFails: true });
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.lastPull().ok, true);
    assert.ok(!t.calls().some((x) => / up -d --no-deps office$/.test(x) || /^image rm/.test(x)));
    assert.match(t.log(), /office: pull failed/);
  });

  it('after a rollback the office image is not touched', () => {
    const t = setup({ health: 'unhealthy' });
    assert.equal(t.run().status, 0);
    assert.equal(t.lastPull().ok, false);
    assert.deepEqual(officeCalls(t.calls()), []);
  });

  it('without the pending-update flag nothing runs', () => {
    const t = setup({ flag: false });
    assert.equal(t.run().status, 0);
    assert.deepEqual(t.calls(), []);
  });
});
