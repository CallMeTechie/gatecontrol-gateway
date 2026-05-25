'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createAuthMiddleware } = require('../src/api/middleware/auth');
const { createSelfUpdateRouter } = require('../src/api/routes/selfUpdate');

const TOKEN = 'a'.repeat(64);
async function serve(stateDir) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthMiddleware({ expectedToken: TOKEN }), createSelfUpdateRouter({ stateDir }));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  return srv;
}
function post(srv, body, token = TOKEN) {
  const data = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/api/self-update', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { 'X-Gateway-Token': token } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : {} })); });
    req.end(data);
  });
}

test('writes pending-update flag and returns queued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')); const srv = await serve(dir);
  const res = await post(srv, { request_id: 'rid-1', target_version: '1.9.4' }); srv.close();
  assert.equal(res.status, 200); assert.equal(res.body.queued, true);
  const flag = JSON.parse(fs.readFileSync(path.join(dir, 'pending-update'), 'utf8'));
  assert.equal(flag.request_id, 'rid-1'); assert.equal(flag.target_version, '1.9.4'); assert.equal(flag.triggered_via, 'server-push');
});
test('requires request_id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')); const srv = await serve(dir);
  const res = await post(srv, {}); srv.close(); assert.equal(res.status, 400);
});
test('401 without token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')); const srv = await serve(dir);
  const res = await post(srv, { request_id: 'x' }, null); srv.close(); assert.equal(res.status, 401);
});
test('cooldown: same request_id already in last-pull is skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.writeFileSync(path.join(dir, 'last-pull'), JSON.stringify({ request_id: 'rid-1', ok: true, pulled_at: Date.now() }));
  const srv = await serve(dir); const res = await post(srv, { request_id: 'rid-1' }); srv.close();
  assert.equal(res.status, 200); assert.equal(res.body.skipped, 'cooldown');
  assert.equal(fs.existsSync(path.join(dir, 'pending-update')), false);
});
test('new request_id after a failed pull is NOT cooled down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.writeFileSync(path.join(dir, 'last-pull'), JSON.stringify({ request_id: 'old', ok: false, pulled_at: Date.now() }));
  const srv = await serve(dir); const res = await post(srv, { request_id: 'new' }); srv.close();
  assert.equal(res.status, 200); assert.equal(res.body.queued, true);
});

test('post-success loop: a different request_id within 60s of a good pull is cooled down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.writeFileSync(path.join(dir, 'last-pull'), JSON.stringify({ request_id: 'old', ok: true, pulled_at: Date.now() }));
  const srv = await serve(dir); const res = await post(srv, { request_id: 'new' }); srv.close();
  assert.equal(res.status, 200); assert.equal(res.body.skipped, 'cooldown');
  assert.equal(fs.existsSync(path.join(dir, 'pending-update')), false);
});
