'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { collectTelemetry } = require('../src/health/telemetry');

describe('telemetry scan_egress capability', () => {
  it('advertises scan_egress: true', () => {
    const t = collectTelemetry();
    assert.equal(t.scan_egress, true);
  });
});
