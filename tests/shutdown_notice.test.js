'use strict';

// The "going down" notice of a graceful shutdown (src/shutdownNotice.js,
// heartbeat.sendGoingDown): the reason (update vs. restart), the request to
// the server, and that a missing / old / slow server never blocks the shutdown.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { shutdownReason, notifyGoingDown, UPDATE_WINDOW_MS } = require('../src/shutdownNotice');
const { sendGoingDown } = require('../src/heartbeat');

const TOKEN = 'gc_gw_' + 'a'.repeat(64);

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

describe('shutdown notice', () => {
  it('reason: update while the flag is there or shortly after the server asked; else restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-shut-'));
    try {
      const now = 10_000_000;
      assert.equal(shutdownReason({ stateDir: dir, now, requestedAt: 0 }), 'restart');
      assert.equal(shutdownReason({ stateDir: dir, now, requestedAt: now - 5 * 60_000 }), 'update');
      assert.equal(shutdownReason({ stateDir: dir, now, requestedAt: now - UPDATE_WINDOW_MS - 1 }), 'restart');
      fs.writeFileSync(path.join(dir, 'pending-update'), '{}');
      assert.equal(shutdownReason({ stateDir: dir, now, requestedAt: 0 }), 'update');
      assert.equal(shutdownReason({ now, requestedAt: 0 }), 'restart', 'no state dir: restart');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends POST /api/v1/gateway/going-down with the Bearer token and the reason', async () => {
    let got = null;
    const { s, url } = await server((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => { got = { path: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(b) }; res.writeHead(200); res.end('{"ok":true}'); });
    });
    try {
      assert.equal(await sendGoingDown({ serverUrl: url, apiToken: TOKEN, reason: 'update' }), true);
      assert.deepEqual(got, { path: '/api/v1/gateway/going-down', method: 'POST', auth: 'Bearer ' + TOKEN, body: { reason: 'update' } });
      await sendGoingDown({ serverUrl: url, apiToken: TOKEN, reason: 'anything' });
      assert.deepEqual(got.body, { reason: 'restart' }, 'only update / restart');
    } finally { s.close(); }
  });

  it('an older server (404) or a slow one never blocks or throws', async () => {
    const old = await server((req, res) => { res.writeHead(404); res.end('{"error":"not_found"}'); });
    const slow = await server(() => { /* never answers */ });
    try {
      assert.equal(await sendGoingDown({ serverUrl: old.url, apiToken: TOKEN, reason: 'restart' }), false);
      const t0 = Date.now();
      assert.equal(await sendGoingDown({ serverUrl: slow.url, apiToken: TOKEN, reason: 'restart', timeoutMs: 200 }), false);
      assert.ok(Date.now() - t0 < 1500, 'bounded by the timeout');
      assert.equal(await sendGoingDown({ serverUrl: 'http://127.0.0.1:1', apiToken: TOKEN, reason: 'restart' }), false);
    } finally { old.s.close(); slow.s.closeAllConnections && slow.s.closeAllConnections(); slow.s.close(); }
  });

  it('notifyGoingDown: from the gateway config; without one nothing is sent', async () => {
    assert.equal(await notifyGoingDown(undefined), false);
    assert.equal(await notifyGoingDown({ serverUrl: '', apiToken: TOKEN }), false);
    let body = null;
    const { s, url } = await server((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => { body = JSON.parse(b); res.writeHead(200); res.end('{}'); });
    });
    try {
      assert.equal(await notifyGoingDown({ serverUrl: url, apiToken: TOKEN, stateDir: null }, { requestedAt: Date.now() }), true);
      assert.deepEqual(body, { reason: 'update' });
    } finally { s.close(); }
  });
});
