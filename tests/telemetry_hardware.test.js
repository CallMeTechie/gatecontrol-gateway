'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function freshTelemetry(dir) {
  process.env.GATEWAY_STATE_DIR = dir;
  delete require.cache[require.resolve('../src/health/telemetry')];
  return require('../src/health/telemetry');
}

test('hardware profile without host file: container view only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
  const { collectTelemetry } = freshTelemetry(dir);
  const hw = collectTelemetry().hardware;
  assert.equal(hw.arch, process.arch);
  assert.equal(hw.cpu_cores, os.cpus().length);
  assert.equal(hw.mem_total, os.totalmem());
  assert.deepEqual(hw.radios, []);
  assert.equal(hw.platform, null);
  assert.equal(hw.image_version, null);
  assert.ok(hw.storage === null || (hw.storage.total > 0 && hw.storage.free >= 0));
  delete process.env.GATEWAY_STATE_DIR;
});

test('hardware profile merges the Pi host file (model, radios, image version)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
  fs.writeFileSync(path.join(dir, 'hardware.json'), JSON.stringify({
    schema: 1,
    source: 'rpi-image',
    image_version: '1.17.0',
    model: 'Raspberry Pi 3 Model B Plus Rev 1.3',
    os: 'Debian GNU/Linux 13 (trixie)',
    radios: [{ kind: 'zigbee', type: 'raspbee2-conbee2', device: '/dev/ttyAMA0', firmware: '0x26780700', detected: true, enabled: true, mode: 'auto' }],
  }));
  const { hardwareProfile } = freshTelemetry(dir);
  const hw = hardwareProfile();
  assert.equal(hw.model, 'Raspberry Pi 3 Model B Plus Rev 1.3');
  assert.equal(hw.platform, 'rpi-image');
  assert.equal(hw.image_version, '1.17.0');
  assert.equal(hw.host_os, 'Debian GNU/Linux 13 (trixie)');
  assert.deepEqual(hw.radios, [{ kind: 'zigbee', type: 'raspbee2-conbee2', device: '/dev/ttyAMA0', firmware: '0x26780700', detected: true, enabled: true }]);
  delete process.env.GATEWAY_STATE_DIR;
});

test('hardware profile treats the host file as untrusted (clamped, bad input ignored)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-'));
  const file = path.join(dir, 'hardware.json');
  const { hardwareProfile } = freshTelemetry(dir);

  fs.writeFileSync(file, JSON.stringify({
    model: 'x'.repeat(500),
    radios: [...Array(20)].map(() => ({ kind: 'zigbee', type: 7, device: { evil: true } })).concat([null]),
  }));
  let hw = hardwareProfile();
  assert.equal(hw.model.length, 120);
  assert.equal(hw.radios.length, 8);
  assert.equal(hw.radios[0].type, null);
  assert.equal(hw.radios[0].device, null);
  assert.equal(hw.radios[0].enabled, false);

  fs.writeFileSync(file, '{not json');
  hw = hardwareProfile();
  assert.deepEqual(hw.radios, []);

  fs.writeFileSync(file, JSON.stringify({ model: 'big', pad: 'y'.repeat(9000) }));
  hw = hardwareProfile();
  assert.notEqual(hw.model, 'big'); // oversized file is ignored as a whole
  delete process.env.GATEWAY_STATE_DIR;
});
