'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { Router } = require('../src/proxy/router');
const { createHttpProxy } = require('../src/proxy/http');

// Raw WebSocket handshake against `port` for `domain`. Resolves with the
// status/header block once the response head arrives; rejects if the socket
// closes without a response (the gateway drops/destroys unsupported upgrades).
function wsHandshake(port, domain) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const c = net.connect(port, '127.0.0.1', () => {
      c.write(
        'GET /vncwebsocket HTTP/1.1\r\n' +
        `Host: ${domain}\r\n` +
        `X-Gateway-Target-Domain: ${domain}\r\n` +
        'X-Gateway-Target: 127.0.0.1:1\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
      );
    });
    let buf = '';
    const timer = setTimeout(() => { c.destroy(); reject(new Error('handshake timeout')); }, 2000);
    c.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) {
        clearTimeout(timer);
        c.destroy();
        const [firstLine, ...rest] = buf.split('\r\n');
        resolve({ firstLine, headerBlock: rest.join('\r\n') });
      }
    });
    c.on('close', () => { clearTimeout(timer); reject(new Error('closed without response')); });
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

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

describe('HTTP proxy — WebSocket upgrades', () => {
  let wsUpstream, proxy;
  let gatewayHeaderSeenOnWs = 'unset';

  before(async () => {
    // WebSocket-capable upstream: completes a minimal RFC6455 handshake.
    wsUpstream = http.createServer((req, res) => { res.writeHead(200); res.end('http'); });
    wsUpstream.on('upgrade', (req, socket) => {
      gatewayHeaderSeenOnWs = req.headers['x-gateway-target'] || null;
      const accept = crypto.createHash('sha1')
        .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
    });
    await new Promise(r => wsUpstream.listen(0, '127.0.0.1', r));

    const router = new Router();
    router.setRoutes([{
      id: 1, domain: 'ws.example',
      target_lan_host: '127.0.0.1', target_lan_port: wsUpstream.address().port,
    }]);
    proxy = createHttpProxy({ router });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  });

  after(() => { wsUpstream?.close(); proxy?.close(); });

  it('forwards a WebSocket upgrade to the matched backend', async () => {
    const { firstLine, headerBlock } = await wsHandshake(proxy.address().port, 'ws.example');
    assert.match(firstLine, /101 Switching Protocols/);
    assert.match(headerBlock.toLowerCase(), /sec-websocket-accept:/);
  });

  it('strips X-Gateway-* headers on the WebSocket path', () => {
    assert.equal(gatewayHeaderSeenOnWs, null);
  });

  it('destroys the socket for an unknown domain on upgrade', async () => {
    await assert.rejects(() => wsHandshake(proxy.address().port, 'nope.example'));
  });

  it('destroys the socket when the WS backend is unreachable', async () => {
    const router = new Router();
    router.setRoutes([{
      id: 9, domain: 'dead.example',
      target_lan_host: '127.0.0.1', target_lan_port: 1, // port 1 → ECONNREFUSED
    }]);
    const p2 = createHttpProxy({ router });
    await new Promise(r => p2.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(() => wsHandshake(p2.address().port, 'dead.example'));
    } finally {
      p2.close();
    }
  });
});
