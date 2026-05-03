'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sendHeartbeat, _collectHealth } = require('../src/heartbeat');

describe('heartbeat', () => {
  it('sends POST /api/v1/gateway/heartbeat with Bearer + JSON payload', async () => {
    let received = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        received = { path: req.url, auth: req.headers.authorization, body };
        res.writeHead(200); res.end('{}');
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    await sendHeartbeat({
      serverUrl: `http://127.0.0.1:${port}`,
      apiToken: 'gc_gw_' + 'a'.repeat(64),
      health: { http_proxy_healthy: true, tcp_listeners: [], wg_handshake_age_s: 30, uptime_s: 100 },
    });

    assert.equal(received.path, '/api/v1/gateway/heartbeat');
    assert.match(received.auth, /^Bearer gc_gw_/);
    const body = JSON.parse(received.body);
    assert.equal(body.http_proxy_healthy, true);
    server.close();
  });

  it('_collectHealth returns full result when getHealth resolves in time', async () => {
    const result = await _collectHealth(async () => ({ overall_healthy: true, foo: 1 }), 1000);
    assert.equal(result.overall_healthy, true);
    assert.equal(result.foo, 1);
  });

  it('_collectHealth returns timeout payload when getHealth hangs past cap', async () => {
    const slow = () => new Promise(() => { /* never resolves */ });
    const start = Date.now();
    const result = await _collectHealth(slow, 100);
    const elapsed = Date.now() - start;
    assert.equal(result.overall_healthy, false);
    assert.equal(result.reason, 'health_collection_timeout');
    assert.ok(elapsed < 500, `should return promptly, took ${elapsed}ms`);
  });

  it('_collectHealth returns error payload when getHealth throws', async () => {
    const result = await _collectHealth(async () => { throw new Error('boom'); }, 1000);
    assert.equal(result.overall_healthy, false);
    assert.equal(result.reason, 'health_collection_error');
    assert.equal(result.error, 'boom');
  });
});
