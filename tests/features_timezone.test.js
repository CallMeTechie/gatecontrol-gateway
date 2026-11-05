'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyTimezone, validTimezone, timezoneTelemetry, ORIGINAL_TZ } = require('../src/features/timezone');
const { normalizeFeatures } = require('../src/features/config');
const { FeatureManager } = require('../src/features/manager');
const { nextNightly, nextSpeedtest } = require('../src/features/schedule');

const restore = () => applyTimezone(null);

describe('features.timezone', () => {
  afterEach(restore);

  it('validates IANA names', () => {
    assert.equal(validTimezone('Europe/Berlin'), 'Europe/Berlin');
    assert.equal(validTimezone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
    assert.equal(validTimezone('UTC'), 'UTC');
    for (const bad of ['Mars/Olympus', '../etc', 'Europe/Berlin; rm', '', 7, null, 'x'.repeat(80)]) assert.equal(validTimezone(bad), null, String(bad));
    assert.equal(normalizeFeatures({ timezone: 'Europe/Berlin' }).timezone, 'Europe/Berlin');
    assert.equal(normalizeFeatures({ timezone: 'nope' }).timezone, null);
    assert.equal(normalizeFeatures(undefined).timezone, null);
  });

  it('overrides TZ for all schedules and restores the original', () => {
    const t = Date.UTC(2026, 0, 15, 12, 0); // 12:00 UTC
    assert.equal(applyTimezone('Europe/Berlin'), process.env.TZ !== 'Europe/Berlin' || true);
    assert.equal(new Date(t).getHours(), 13);
    assert.equal(timezoneTelemetry().effective, 'Europe/Berlin');
    assert.equal(timezoneTelemetry().source, 'server');
    assert.equal(timezoneTelemetry().offsetMin, 60);
    // Portscan-Fenster und Speedtest-Plan rechnen in dieser Ortszeit
    const n = new Date(nextNightly(t, () => 0));
    assert.deepEqual([n.getHours(), n.getMinutes()], [2, 0]);
    assert.equal(n.getTime(), Date.UTC(2026, 0, 16, 1, 0));
    assert.equal(nextSpeedtest('4x', t, () => 0), Date.UTC(2026, 0, 15, 17, 0)); // 18:00 Berlin
    assert.equal(applyTimezone('Europe/Berlin'), false, 'unchanged');
    assert.equal(applyTimezone('America/New_York'), true);
    assert.equal(new Date(t).getHours(), 7);
    applyTimezone(null);
    assert.equal(process.env.TZ, ORIGINAL_TZ);
    assert.notEqual(timezoneTelemetry().source, 'server');
  });

  it('FeatureManager applies the timezone first and replans netwatch/inetq', async () => {
    const calls = [];
    const part = (name) => ({ apply: () => calls.push(`${name}.apply`), replan: () => calls.push(`${name}.replan`), stop() {}, telemetry: () => ({}), featureTelemetry: () => ({}) });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-'));
    const dnsApplied = [];
    const mgr = new FeatureManager({
      netwatch: part('netwatch'), inetq: part('inetq'), presence: part('presence'), ups: { ...part('ups'), telemetry: () => null },
      dns: { apply: async (c) => dnsApplied.push(c), stop() {}, telemetry: () => null, featureTelemetry: () => ({ enabled: false }) },
      stateDir,
    });
    await mgr.apply({ timezone: 'Asia/Tokyo', dns: { enabled: true, profiles: [{ id: 'a' }] } });
    assert.deepEqual(calls.slice(0, 2), ['netwatch.replan', 'inetq.replan']);
    assert.equal(process.env.TZ, 'Asia/Tokyo');
    assert.equal(mgr.telemetry().timezone.effective, 'Asia/Tokyo');
    assert.equal(dnsApplied.at(-1).enabled, true);
    // Neustart: DNS-Einstellung und Zeitzone vor dem ersten Config-Pull
    applyTimezone(null);
    const mgr2 = new FeatureManager({ ...mgr, dns: { apply: async (c) => dnsApplied.push({ boot: true, ...c }), stop() {} }, stateDir });
    await mgr2.restoreBoot();
    assert.equal(process.env.TZ, 'Asia/Tokyo');
    assert.equal(dnsApplied.at(-1).boot, true);
    assert.deepEqual(dnsApplied.at(-1).profiles.map((p) => p.id), ['a']);
    // DNS aus → beim nächsten Start nichts wiederherstellen
    await mgr.apply({ dns: { enabled: false } });
    const n = dnsApplied.length;
    await mgr2.restoreBoot();
    assert.equal(dnsApplied.length, n);
  });
});
