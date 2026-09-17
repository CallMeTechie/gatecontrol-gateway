'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { Router } = require('../src/proxy/router');
const { createHttpProxy } = require('../src/proxy/http');
const { normalizeFingerprint, getPinnedAgent, _resetPinnedAgents } = require('../src/proxy/tlsPin');

// ---------------------------------------------------------------------------
// Self-signed certificate fixture, generated at test time.
//
// Built with node:crypto only — no openssl binary, no checked-in key material
// (a committed private key would trip the gitleaks job in CI, and a committed
// certificate would eventually expire). The DER bytes are assembled by hand
// because Node has no certificate-issuing API: crypto can make the key pair
// and the signature, the X.509 wrapper around them is plain DER.
// ---------------------------------------------------------------------------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const derSet = (...items) => tlv(0x31, Buffer.concat(items));
const derInt = (buf) => tlv(0x02, buf);
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const octetString = (buf) => tlv(0x04, buf);
const printable = (s) => tlv(0x13, Buffer.from(s, 'ascii'));
const utcTime = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(
    `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'));
};
const DER_NULL = Buffer.from([0x05, 0x00]);

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [];
    for (let v = part; ; v = Math.floor(v / 128)) {
      stack.unshift(v % 128);
      if (v < 128) break;
    }
    // every byte but the last carries the "more follows" bit
    out.push(...stack.map((b, i) => (i === stack.length - 1 ? b : b | 0x80)));
  }
  return tlv(0x06, Buffer.from(out));
}

const SHA256_WITH_RSA = seq(oid('1.2.840.113549.1.1.11'), DER_NULL);

function makeSelfSignedCert(commonName) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const name = seq(derSet(seq(oid('2.5.4.3'), printable(commonName))));
  const notBefore = new Date(Date.now() - 86_400_000);
  const notAfter = new Date(Date.now() + 3650 * 86_400_000);

  // subjectAltName = IP:127.0.0.1 — every backend in these tests is loopback.
  const san = seq(oid('2.5.29.17'), octetString(seq(tlv(0x87, Buffer.from([127, 0, 0, 1])))));
  const basicConstraints = seq(oid('2.5.29.19'), octetString(seq()));

  const tbs = seq(
    tlv(0xa0, derInt(Buffer.from([0x02]))),            // version v3
    // serial: positive INTEGER (leading bit cleared so DER reads it unsigned)
    derInt(Buffer.concat([Buffer.from([crypto.randomBytes(1)[0] & 0x7f]), crypto.randomBytes(7)])),
    SHA256_WITH_RSA,
    name,                                              // issuer == subject
    seq(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    tlv(0xa3, seq(basicConstraints, san))              // extensions
  );

  const der = seq(tbs, SHA256_WITH_RSA, bitString(crypto.sign('sha256', tbs, privateKey)));
  const pem = '-----BEGIN CERTIFICATE-----\n' +
    (der.toString('base64').match(/.{1,64}/g) || []).join('\n') +
    '\n-----END CERTIFICATE-----\n';

  return {
    cert: pem,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    // Exactly what the server stores and ships as backend_tls_fingerprint:
    // SHA-256 over the leaf certificate's DER bytes, bare lowercase hex.
    fingerprint: crypto.createHash('sha256').update(der).digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function request(port, domain, path = '/', { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: { host: domain, 'X-Gateway-Target-Domain': domain },
    }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const get = (port, domain, path) => request(port, domain, path);

// Raw WebSocket handshake against the gateway. Resolves with the response head
// once it arrives; rejects when the gateway drops the socket instead.
function wsHandshake(port, domain) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const c = net.connect(port, '127.0.0.1', () => {
      c.write(
        'GET /stream HTTP/1.1\r\n' +
        `Host: ${domain}\r\nX-Gateway-Target-Domain: ${domain}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
      );
    });
    let buf = '';
    const timer = setTimeout(() => { c.destroy(); reject(new Error('handshake timeout')); }, 5000);
    c.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) {
        clearTimeout(timer);
        c.destroy();
        resolve({ firstLine: buf.split('\r\n')[0] });
      }
    });
    c.on('close', () => { clearTimeout(timer); reject(new Error('closed without response')); });
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));

// ---------------------------------------------------------------------------

describe('normalizeFingerprint', () => {
  const hex = 'a'.repeat(64);

  it('accepts the canonical bare-lowercase-hex form', () => {
    assert.equal(normalizeFingerprint(hex), hex);
  });

  it('accepts the colon-separated uppercase form Node and OpenSSL print', () => {
    const colons = ('AB'.repeat(32).match(/.{2}/g) || []).join(':');
    assert.equal(normalizeFingerprint(colons), 'ab'.repeat(32));
  });

  it('accepts a "sha256:" prefix', () => {
    assert.equal(normalizeFingerprint(`sha256:${hex}`), hex);
  });

  it('rejects wrong length, non-hex and non-string input', () => {
    assert.equal(normalizeFingerprint('a'.repeat(63)), null);
    assert.equal(normalizeFingerprint('a'.repeat(65)), null);
    assert.equal(normalizeFingerprint('z'.repeat(64)), null);
    assert.equal(normalizeFingerprint(''), null);
    assert.equal(normalizeFingerprint(null), null);
    assert.equal(normalizeFingerprint(undefined), null);
    assert.equal(normalizeFingerprint(12345), null);
  });
});

describe('pinned agent cache', () => {
  const fpA = 'a'.repeat(64);
  const fpB = 'b'.repeat(64);

  before(() => _resetPinnedAgents());
  after(() => _resetPinnedAgents());

  it('reuses one agent per (host, port, fingerprint)', () => {
    const a1 = getPinnedAgent({ host: '10.0.0.1', port: 443, fingerprint: fpA });
    const a2 = getPinnedAgent({ host: '10.0.0.1', port: 443, fingerprint: fpA });
    assert.equal(a1, a2);
  });

  it('never serves a rotated fingerprint from the cache', () => {
    const a1 = getPinnedAgent({ host: '10.0.0.1', port: 443, fingerprint: fpA });
    const a2 = getPinnedAgent({ host: '10.0.0.1', port: 443, fingerprint: fpB });
    assert.notEqual(a1, a2);
    assert.equal(a2.pinFingerprint, fpB);
  });

  it('separates host and port', () => {
    const a1 = getPinnedAgent({ host: '10.0.0.1', port: 443, fingerprint: fpA });
    assert.notEqual(a1, getPinnedAgent({ host: '10.0.0.2', port: 443, fingerprint: fpA }));
    assert.notEqual(a1, getPinnedAgent({ host: '10.0.0.1', port: 8443, fingerprint: fpA }));
  });

  it('runs without keep-alive so a rejected peer can never be pooled', () => {
    assert.equal(getPinnedAgent({ host: '10.0.0.1', port: 443, fingerprint: fpA }).keepAlive, false);
  });
});

describe('HTTPS backend certificate pinning', () => {
  const fixture = makeSelfSignedCert('gatecontrol-lan-backend');
  const otherFixture = makeSelfSignedCert('gatecontrol-lan-backend');
  let backend, requestsSeen, proxy, lastGatewayHeader;

  const routeFor = (fingerprint) => ({
    id: 42,
    domain: 'nas.example',
    target_lan_host: '127.0.0.1',
    target_lan_port: backend.address().port,
    backend_https: true,
    ...(fingerprint === undefined ? {} : { backend_tls_fingerprint: fingerprint }),
  });

  const proxyWith = async (route) => {
    const router = new Router();
    router.setRoutes([route]);
    const p = createHttpProxy({ router });
    await listen(p);
    return p;
  };

  before(async () => {
    requestsSeen = 0;
    backend = https.createServer({ key: fixture.key, cert: fixture.cert }, (req, res) => {
      requestsSeen++;
      lastGatewayHeader = req.headers['x-gateway-target-domain'] || null;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`backend:${req.url}`);
    });
    backend.on('upgrade', (req, socket) => {
      requestsSeen++;
      const accept = crypto.createHash('sha1')
        .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
    });
    await listen(backend);
  });

  after(() => { backend?.close(); proxy?.close(); _resetPinnedAgents(); });

  it('proxies when the backend certificate matches the pin', async () => {
    proxy = await proxyWith(routeFor(fixture.fingerprint));
    const res = await get(proxy.address().port, 'nas.example', '/ok');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'backend:/ok');
    proxy.close(); proxy = null;
  });

  // Regression guard: on a pinned route the outgoing header block is already
  // rendered when http-proxy fires 'proxyReq' (the socket only exists after
  // the TLS handshake), so the strip must not depend on that hook.
  it('still strips X-Gateway-* headers on a pinned route', async () => {
    lastGatewayHeader = 'unset';
    proxy = await proxyWith(routeFor(fixture.fingerprint));
    const res = await get(proxy.address().port, 'nas.example', '/hdr');
    assert.equal(res.status, 200);
    assert.equal(lastGatewayHeader, null);
    proxy.close(); proxy = null;
  });

  it('accepts the colon-separated spelling of the same fingerprint', async () => {
    const colons = ((fixture.fingerprint.toUpperCase().match(/.{2}/g)) || []).join(':');
    proxy = await proxyWith(routeFor(colons));
    const res = await get(proxy.address().port, 'nas.example', '/ok');
    assert.equal(res.status, 200);
    proxy.close(); proxy = null;
  });

  it('refuses with 502 ERR_TLS_PIN_MISMATCH when the certificate differs', async () => {
    proxy = await proxyWith(routeFor(otherFixture.fingerprint));
    const before = requestsSeen;
    const res = await get(proxy.address().port, 'nas.example', '/secret');
    assert.equal(res.status, 502);
    assert.match(res.body, /ERR_TLS_PIN_MISMATCH/);
    // Fail closed: the request never reached the backend.
    assert.equal(requestsSeen, before, 'backend must not have seen the request');
    proxy.close(); proxy = null;
  });

  it('does not leak a request body to a backend that fails the pin', async () => {
    proxy = await proxyWith(routeFor(otherFixture.fingerprint));
    const before = requestsSeen;
    const res = await request(proxy.address().port, 'nas.example', '/upload',
      { method: 'POST', body: 'secret-payload' });
    assert.equal(res.status, 502);
    assert.match(res.body, /ERR_TLS_PIN_MISMATCH/);
    assert.equal(requestsSeen, before);
    proxy.close(); proxy = null;
  });

  it('refuses every retry — a mismatching socket is never reused', async () => {
    proxy = await proxyWith(routeFor(otherFixture.fingerprint));
    const before = requestsSeen;
    for (let i = 0; i < 3; i++) {
      const res = await get(proxy.address().port, 'nas.example', `/retry${i}`);
      assert.equal(res.status, 502);
      assert.match(res.body, /ERR_TLS_PIN_MISMATCH/);
    }
    assert.equal(requestsSeen, before);
    proxy.close(); proxy = null;
  });

  it('behaves exactly as before when the route carries no fingerprint', async () => {
    proxy = await proxyWith(routeFor(undefined));
    const res = await get(proxy.address().port, 'nas.example', '/unpinned');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'backend:/unpinned');
    proxy.close(); proxy = null;
  });

  it('treats an explicit null fingerprint as "no pin"', async () => {
    proxy = await proxyWith(routeFor(null));
    const res = await get(proxy.address().port, 'nas.example', '/nullpin');
    assert.equal(res.status, 200);
    proxy.close(); proxy = null;
  });

  it('refuses with 502 ERR_TLS_PIN_CONFIG when the configured fingerprint is unusable', async () => {
    proxy = await proxyWith(routeFor('not-a-fingerprint'));
    const before = requestsSeen;
    const res = await get(proxy.address().port, 'nas.example', '/broken');
    assert.equal(res.status, 502);
    assert.match(res.body, /ERR_TLS_PIN_CONFIG/);
    assert.equal(requestsSeen, before);
    proxy.close(); proxy = null;
  });

  it('forwards a WebSocket upgrade when the pin matches', async () => {
    proxy = await proxyWith(routeFor(fixture.fingerprint));
    const { firstLine } = await wsHandshake(proxy.address().port, 'nas.example');
    assert.match(firstLine, /101 Switching Protocols/);
    proxy.close(); proxy = null;
  });

  it('drops a WebSocket upgrade when the pin does not match', async () => {
    proxy = await proxyWith(routeFor(otherFixture.fingerprint));
    const before = requestsSeen;
    await assert.rejects(() => wsHandshake(proxy.address().port, 'nas.example'));
    assert.equal(requestsSeen, before, 'backend must not have seen the upgrade');
    proxy.close(); proxy = null;
  });

  it('drops a WebSocket upgrade when the configured fingerprint is unusable', async () => {
    proxy = await proxyWith(routeFor('sha256:zzzz'));
    const before = requestsSeen;
    await assert.rejects(() => wsHandshake(proxy.address().port, 'nas.example'));
    assert.equal(requestsSeen, before);
    proxy.close(); proxy = null;
  });
});
