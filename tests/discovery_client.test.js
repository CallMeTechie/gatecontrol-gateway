'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeDiscoveryClient } = require('../src/discovery/discoveryClient');

test('sendBatch POSTs to /api/v1/gateway/discovery with Bearer auth', async () => {
  let received = null;
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }; res.end('{}'); });
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;
  const client = makeDiscoveryClient({ serverUrl: `http://127.0.0.1:${port}`, apiToken: 'gc_gw_' + 'a'.repeat(64) });
  await client.sendBatch({ requestId: 'r1', devices: [{ ip: '192.168.1.5', ports: [] }], done: true });
  assert.equal(received.url, '/api/v1/gateway/discovery');
  assert.equal(received.auth, 'Bearer gc_gw_' + 'a'.repeat(64));
  assert.equal(received.body.request_id, 'r1');
  assert.equal(received.body.done, true);
  assert.equal(received.body.devices.length, 1);
  srv.close();
});

test('sendBatch swallows transport errors (never throws)', async () => {
  const client = makeDiscoveryClient({ serverUrl: 'http://127.0.0.1:1', apiToken: 'gc_gw_' + 'a'.repeat(64) });
  await client.sendBatch({ requestId: 'r2', devices: [], done: true }); // must resolve, not reject
});
