'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');
const { EdgeChannel, wsUrl, backoffDelay, pinnedLookup } = require('../src/edge/channel');

function fakeServer(onConn, { reject = null } = {}) {
  const server = http.createServer();
  const wss = new WebSocket.Server({ noServer: true, handleProtocols: (protocols) => (protocols.has('gc-edge.v1') ? 'gc-edge.v1' : false) });
  server.on('upgrade', (req, socket, head) => {
    if (reject) { socket.end(`HTTP/1.1 ${reject} X\r\nContent-Length: 0\r\n\r\n`); return; }
    if (req.url !== '/api/v1/gateway/edge/ws' || req.headers.authorization !== 'Bearer gc_gw_test') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConn(ws, req));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, wss, port: server.address().port })));
}

const waitFor = (emitter, ev) => new Promise((r) => emitter.once(ev, (...a) => r(a)));

test('wsUrl / backoff / pinnedLookup', () => {
  assert.strictEqual(wsUrl('https://gc.example.com'), 'wss://gc.example.com/api/v1/gateway/edge/ws');
  assert.strictEqual(wsUrl('http://gc.example.com:3000/base/'), 'ws://gc.example.com:3000/base/api/v1/gateway/edge/ws');
  assert.throws(() => wsUrl('ftp://x'));
  assert.strictEqual(backoffDelay(0, { random: () => 0.5 }), 1000);
  assert.strictEqual(backoffDelay(3, { random: () => 0.5 }), 8000);
  assert.strictEqual(backoffDelay(20, { random: () => 0.99 }), 60000);
  assert.ok(backoffDelay(20, { random: () => 0 }) >= 1000);
  const lk = pinnedLookup(() => ['192.0.2.7', '2001:db8::7']);
  lk('gc.example.com', { all: true }, (e, all) => assert.deepStrictEqual(all.map((a) => a.family), [4, 6]));
  lk('gc.example.com', {}, (e, addr, fam) => { assert.strictEqual(addr, '192.0.2.7'); assert.strictEqual(fam, 4); });
  pinnedLookup(() => [])('x', {}, (e) => assert.strictEqual(e.code, 'ENOTFOUND'));
});

test('verbindet mit Token + Subprotokoll über die gepinnte Adresse, Nachrichten in beide Richtungen', async () => {
  const got = [];
  const { server, port } = await fakeServer((ws) => {
    ws.on('message', (d) => { got.push(JSON.parse(d)); ws.send(JSON.stringify({ t: 'state', plugins: [] })); });
  });
  const ch = new EdgeChannel({ credentials: () => ({ serverUrl: `http://gc.invalid:${port}`, apiToken: 'gc_gw_test', serverAddrs: ['127.0.0.1'] }) });
  try {
    ch.start();
    await waitFor(ch, 'open');
    assert.ok(ch.send({ t: 'hello', v: 1 }));
    const [msg] = await waitFor(ch, 'message');
    assert.strictEqual(msg.t, 'state');
    assert.deepStrictEqual(got, [{ t: 'hello', v: 1 }]);
    assert.strictEqual(ch.send({ t: 'x', big: 'y'.repeat(70 * 1024) }), false, 'Frame > 64 KB wird nicht gesendet');
  } finally {
    ch.stop();
    server.close();
  }
});

test('Wiederverbindung mit Backoff nach Trennung', async () => {
  let n = 0;
  const { server, port } = await fakeServer((ws) => { n++; if (n === 1) setTimeout(() => ws.terminate(), 20); });
  const ch = new EdgeChannel({ credentials: () => ({ serverUrl: `http://127.0.0.1:${port}`, apiToken: 'gc_gw_test' }),
    timing: { reconnectMinMs: 30, reconnectMaxMs: 60 } });
  try {
    const retry = waitFor(ch, 'retry');
    ch.start();
    await waitFor(ch, 'open');
    const [delay] = await retry;
    assert.ok(delay >= 30 && delay <= 60, String(delay));
    await waitFor(ch, 'open');
    assert.strictEqual(n, 2);
  } finally {
    ch.stop();
    server.close();
  }
});

test('älterer Server (404) → selten nachfragen; falsches Token → 5-min-Pause', async () => {
  const { server, port } = await fakeServer(() => {}, { reject: 404 });
  const ch = new EdgeChannel({ credentials: () => ({ serverUrl: `http://127.0.0.1:${port}`, apiToken: 'gc_gw_test' }) });
  try {
    ch.start();
    const [delay] = await waitFor(ch, 'retry');
    assert.strictEqual(delay, 10 * 60 * 1000);
    assert.strictEqual(ch.unsupported, true);
  } finally { ch.stop(); server.close(); }
  const s2 = await fakeServer(() => {});
  const ch2 = new EdgeChannel({ credentials: () => ({ serverUrl: `http://127.0.0.1:${s2.port}`, apiToken: 'gc_gw_wrong' }) });
  try {
    ch2.start();
    const [delay] = await waitFor(ch2, 'retry');
    assert.strictEqual(delay, 5 * 60 * 1000);
    assert.strictEqual(ch2.lastError, 'http_403');
  } finally { ch2.stop(); s2.server.close(); }
});

test('Ping: ohne Lebenszeichen nach pongTimeout wird neu verbunden', async () => {
  let conns = 0;
  const { server, port } = await fakeServer((ws) => { conns++; ws._socket.pause(); /* antwortet auf nichts */ });
  const ch = new EdgeChannel({ credentials: () => ({ serverUrl: `http://127.0.0.1:${port}`, apiToken: 'gc_gw_test' }),
    timing: { pingMs: 20, pongTimeoutMs: 60, reconnectMinMs: 10, reconnectMaxMs: 20 } });
  try {
    ch.start();
    await waitFor(ch, 'open');
    await waitFor(ch, 'close');
    await waitFor(ch, 'open');
    assert.ok(conns >= 2);
  } finally { ch.stop(); server.close(); }
});
