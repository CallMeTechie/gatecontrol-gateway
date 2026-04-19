'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Router } = require('../src/proxy/router');
const { createHttpProxy } = require('../src/proxy/http');

describe('HTTP proxy', () => {
  let upstream, proxy;

  before(async () => {
    upstream = http.createServer((req, res) => {
      // echo received headers for verification
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host, path: req.url, receivedGatewayHeader: req.headers['x-gateway-target'] || null }));
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));

    const router = new Router();
    router.setRoutes([{
      id: 1,
      domain: 'test.example',
      target_lan_host: '127.0.0.1',
      target_lan_port: upstream.address().port,
    }]);

    proxy = createHttpProxy({ router });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  });

  after(() => { upstream?.close(); proxy?.close(); });

  it('proxies request based on X-Gateway-Target-Domain', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.address().port, path: '/foo',
        headers: {
          host: 'test.example',
          'X-Gateway-Target-Domain': 'test.example',
          'X-Gateway-Target': `127.0.0.1:${upstream.address().port}`,
        },
      }, (r) => {
        let b = ''; r.on('data', c => b += c);
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(b) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.path, '/foo');
    // X-Gateway-Target header MUST be stripped before forwarding to upstream
    assert.equal(res.body.receivedGatewayHeader, null);
  });

  it('returns 502 for unknown domain', async () => {
    const status = await new Promise(resolve => {
      http.request({
        host: '127.0.0.1', port: proxy.address().port, path: '/',
        headers: { host: 'unknown.example', 'X-Gateway-Target-Domain': 'unknown.example' },
      }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).end();
    });
    assert.equal(status, 502);
  });
});
