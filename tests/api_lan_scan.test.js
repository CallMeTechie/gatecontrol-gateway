'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAuthMiddleware } = require('../src/api/middleware/auth');
const { createLanScanRouter } = require('../src/api/routes/lanScan');

const TOK = 't'.repeat(64);
async function serverWith(scanMgr) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthMiddleware({ expectedToken: TOK }),
    createLanScanRouter({ scanMgr, defaultGatewayIp: () => '192.168.1.1' }));
  const s = app.listen(0, '127.0.0.1');
  await new Promise(r => s.on('listening', r));
  return s;
}
function post(port, body) {
  return new Promise(resolve => {
    const p = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/lan-scan', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p), 'X-Gateway-Token': TOK } },
      r => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.end(p);
  });
}

describe('POST /api/lan-scan', () => {
  const okMgr = (over = {}) => ({ canStart: () => true, validateSubnets: () => ['192.168.1.0/24'], start: async () => {}, ...over });

  it('202 with subnets_scanned on a valid request', async () => {
    let started = null;
    const s = await serverWith(okMgr({ start: async (p) => { started = p; } }));
    const r = await post(s.address().port, { request_id: 'r1', subnets: ['192.168.1.0/24'], category_mode: 'include', categories: ['web'], active_scan: true });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { accepted: true, request_id: 'r1', subnets_scanned: ['192.168.1.0/24'] });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(started.requestId, 'r1'); assert.equal(started.activeScan, true);
    s.close();
  });

  it('409 when a scan is already in flight', async () => {
    const s = await serverWith(okMgr({ canStart: () => false }));
    const r = await post(s.address().port, { request_id: 'r1', subnets: ['192.168.1.0/24'] });
    assert.equal(r.status, 409); s.close();
  });

  it('400 on missing request_id / subnets', async () => {
    const s = await serverWith(okMgr());
    assert.equal((await post(s.address().port, { subnets: ['192.168.1.0/24'] })).status, 400);
    assert.equal((await post(s.address().port, { request_id: 'r1' })).status, 400);
    s.close();
  });

  it('403 when no requested subnet is gateway-owned', async () => {
    const s = await serverWith(okMgr({ validateSubnets: () => [] }));
    const r = await post(s.address().port, { request_id: 'r1', subnets: ['10.0.0.0/24'] });
    assert.equal(r.status, 403); s.close();
  });
});
