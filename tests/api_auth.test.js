'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAuthMiddleware } = require('../src/api/middleware/auth');

describe('api/auth', () => {
  const token = 'a'.repeat(64);
  const mw = createAuthMiddleware({ expectedToken: token });

  function mockCall(header) {
    const req = { headers: { 'x-gateway-token': header }, ip: '127.0.0.1' };
    let statusCode = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json() { return this; },
    };
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    return { statusCode, nextCalled };
  }

  it('accepts valid token', () => {
    const r = mockCall(token);
    assert.equal(r.nextCalled, true);
    assert.equal(r.statusCode, null);
  });

  it('rejects missing token with 401', () => {
    const r = mockCall(undefined);
    assert.equal(r.statusCode, 401);
    assert.equal(r.nextCalled, false);
  });

  it('rejects wrong token with 403', () => {
    const r = mockCall('b'.repeat(64));
    assert.equal(r.statusCode, 403);
  });

  it('uses timing-safe comparison (length-mismatch → 403)', () => {
    const r = mockCall('short');
    assert.equal(r.statusCode, 403);
  });
});
