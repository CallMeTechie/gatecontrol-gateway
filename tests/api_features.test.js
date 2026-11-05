'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApiServer } = require('../src/api/server');
const { createFeaturesRouter } = require('../src/api/routes/features');

const TOK = 'f'.repeat(64);

async function serverWith(featureMgr) {
  const app = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: TOK, routerFactories: { '/api': () => createFeaturesRouter({ featureMgr }) } });
  const s = app.listen(0, '127.0.0.1');
  await new Promise((r) => s.on('listening', r));
  return s;
}

function post(port, path, body, token = TOK) {
  return new Promise((resolve) => {
    const p = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) };
    if (token) headers['X-Gateway-Token'] = token;
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.end(p);
  });
}

describe('management API: /api/netwatch/scan, /api/inetq/speedtest', () => {
  it('202 accepted, 409 busy, 503 disabled; ports flag passed through', async () => {
    const calls = [];
    let nw = 'accepted';
    let iq = 'accepted';
    const s = await serverWith({
      netwatch: { requestScan: (o) => { calls.push(o); return nw; } },
      inetq: { requestSpeedtest: () => iq },
    });
    const port = s.address().port;
    assert.deepEqual(await post(port, '/api/netwatch/scan', {}), { status: 202, body: { accepted: true } });
    assert.deepEqual(await post(port, '/api/netwatch/scan', { ports: true }), { status: 202, body: { accepted: true } });
    assert.deepEqual(calls, [{ ports: false }, { ports: true }]);
    nw = 'busy';
    assert.deepEqual(await post(port, '/api/netwatch/scan', {}), { status: 409, body: { error: 'scan_in_progress' } });
    nw = 'disabled';
    assert.deepEqual(await post(port, '/api/netwatch/scan', {}), { status: 503, body: { error: 'feature_disabled' } });
    assert.deepEqual(await post(port, '/api/inetq/speedtest', {}), { status: 202, body: { accepted: true } });
    iq = 'busy';
    assert.deepEqual(await post(port, '/api/inetq/speedtest', {}), { status: 409, body: { error: 'speedtest_running' } });
    iq = 'disabled';
    assert.deepEqual(await post(port, '/api/inetq/speedtest', {}), { status: 503, body: { error: 'feature_disabled' } });
    s.close();
  });

  it('requires the gateway token', async () => {
    const s = await serverWith({ netwatch: { requestScan: () => 'accepted' }, inetq: { requestSpeedtest: () => 'accepted' } });
    const port = s.address().port;
    assert.equal((await post(port, '/api/netwatch/scan', {}, null)).status, 401);
    assert.equal((await post(port, '/api/inetq/speedtest', {}, 'x'.repeat(64))).status, 403);
    s.close();
  });
});
