'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAuthMiddleware } = require('../src/api/middleware/auth');
const { createWolRouter } = require('../src/api/routes/wol');

describe('POST /api/wol', () => {
  async function serverWith(configStore, { sendMagicPacket, waitForReachable } = {}) {
    const app = express();
    app.use(express.json());
    const auth = createAuthMiddleware({ expectedToken: 't'.repeat(64) });
    app.use('/api', auth, createWolRouter({
      configStore,
      sendMagicPacket: sendMagicPacket || (async () => [{ sent: true }]),
      waitForReachable: waitForReachable || (async () => 5000),
    }));
    const s = app.listen(0, '127.0.0.1');
    await new Promise(r => s.on('listening', r));
    return s;
  }

  async function postJson(port, path, body) {
    return new Promise(resolve => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Gateway-Token': 't'.repeat(64) },
      }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
      req.end(payload);
    });
  }

  it('accepts whitelisted MAC + sends packet + polls reachability', async () => {
    const store = { isMacInWolWhitelist: (m) => m === 'AA:BB:CC:DD:EE:FF' };
    let sent = 0, polled = 0;
    const s = await serverWith(store, { sendMagicPacket: async () => { sent++; return [{ sent: true }]; }, waitForReachable: async () => { polled++; return 3000; } });
    const r = await postJson(s.address().port, '/api/wol', { mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 10000 });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.success, true);
    assert.equal(body.elapsed_ms, 3000);
    assert.equal(sent, 1);
    assert.equal(polled, 1);
    s.close();
  });

  it('rejects MAC not in whitelist with 403', async () => {
    const store = { isMacInWolWhitelist: () => false };
    const s = await serverWith(store);
    const r = await postJson(s.address().port, '/api/wol', { mac: '11:22:33:44:55:66', lan_host: '192.168.1.10', timeout_ms: 5000 });
    assert.equal(r.status, 403);
    s.close();
  });

  it('rejects invalid MAC format with 400', async () => {
    const store = { isMacInWolWhitelist: () => true };
    const s = await serverWith(store);
    const r = await postJson(s.address().port, '/api/wol', { mac: 'not-a-mac', lan_host: '192.168.1.10', timeout_ms: 5000 });
    assert.equal(r.status, 400);
    s.close();
  });

  it('rejects non-RFC1918 lan_host with 400', async () => {
    const store = { isMacInWolWhitelist: () => true };
    const s = await serverWith(store);
    const r = await postJson(s.address().port, '/api/wol', { mac: 'AA:BB:CC:DD:EE:FF', lan_host: '8.8.8.8', timeout_ms: 5000 });
    assert.equal(r.status, 400);
    assert.match(r.body, /rfc1918/i);
    s.close();
  });

  it('respects explicit lan_host_port in reachability poll', async () => {
    const store = { isMacInWolWhitelist: () => true };
    let capturedPort = null;
    const s = await serverWith(store, {
      waitForReachable: async (host, port) => { capturedPort = port; return 100; },
    });
    const r = await postJson(s.address().port, '/api/wol',
      { mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', lan_host_port: 3389, timeout_ms: 5000 });
    assert.equal(r.status, 200);
    assert.equal(capturedPort, 3389);
    s.close();
  });
});
