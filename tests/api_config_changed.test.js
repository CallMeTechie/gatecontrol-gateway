'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAuthMiddleware } = require('../src/api/middleware/auth');
const { createConfigChangedRouter } = require('../src/api/routes/configChanged');

describe('POST /api/config-changed', () => {
  async function startServer(poller) {
    const app = express();
    app.use(express.json());
    const auth = createAuthMiddleware({ expectedToken: 't'.repeat(64) });
    app.use('/api', auth, createConfigChangedRouter({ poller }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.on('listening', r));
    return { server, port: server.address().port };
  }

  it('triggers poller on valid token', async () => {
    let triggered = 0;
    const poller = { triggerImmediate: () => triggered++ };
    const { server, port } = await startServer(poller);
    const res = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config-changed', method: 'POST', headers: { 'X-Gateway-Token': 't'.repeat(64) } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.end();
    });
    assert.equal(res, 200);
    assert.equal(triggered, 1);
    server.close();
  });

  it('rejects without token', async () => {
    const poller = { triggerImmediate: () => {} };
    const { server, port } = await startServer(poller);
    const res = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config-changed', method: 'POST' }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.end();
    });
    assert.equal(res, 401);
    server.close();
  });
});
