'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApiServer } = require('../src/api/server');

describe('api/server', () => {
  it('refuses to bind on 0.0.0.0', () => {
    assert.throws(() => createApiServer({
      bindIp: '0.0.0.0',
      port: 9876,
      expectedToken: 'a'.repeat(64),
    }), /0\.0\.0\.0|tunnel-ip/i);
  });

  it('creates app with listen method', () => {
    const srv = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: 'a'.repeat(64) });
    assert.ok(typeof srv.listen === 'function');
  });

  it('listen binds only to given bindIp', async () => {
    const srv = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: 'a'.repeat(64) });
    const server = await new Promise((resolve) => {
      const s = srv.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    assert.equal(addr.address, '127.0.0.1');
    server.close();
  });
});
