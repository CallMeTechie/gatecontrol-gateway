'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

test('collectTelemetry relays last-pull + state flags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  process.env.GATEWAY_STATE_DIR = dir;
  delete require.cache[require.resolve('../src/health/telemetry')];
  const { collectTelemetry } = require('../src/health/telemetry');

  let t = collectTelemetry();
  assert.equal(t.state_dir_writable, true);
  assert.equal(t.pending_update, false);
  assert.equal(t.last_pull_at, null);
  assert.equal(t.last_pull_request_id, null);

  fs.writeFileSync(path.join(dir, 'last-pull'), JSON.stringify({ request_id: 'r1', pulled_at: 1700000000000, image_digest: 'repo@sha256:abc', ok: true }));
  fs.writeFileSync(path.join(dir, 'pending-update'), '{}');
  delete require.cache[require.resolve('../src/health/telemetry')];
  t = require('../src/health/telemetry').collectTelemetry();
  assert.equal(t.last_pull_request_id, 'r1');
  assert.equal(t.last_pull_ok, true);
  assert.equal(t.last_pull_at, 1700000000000);
  assert.equal(t.image_digest, 'repo@sha256:abc');
  assert.equal(t.pending_update, true);

  delete process.env.GATEWAY_STATE_DIR;
});
