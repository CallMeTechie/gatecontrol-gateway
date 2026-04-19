'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchConfig, checkHash } = require('../src/sync/syncClient');

describe('syncClient', () => {
  it('fetches config from /api/v1/gateway/config with Bearer', async () => {
    let req;
    const server = http.createServer((r, res) => {
      req = r;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config_hash_version: 1, peer_id: 3, routes: [], l4_routes: [], config_hash: 'sha256:xyz' }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    const cfg = await fetchConfig({ serverUrl: `http://127.0.0.1:${server.address().port}`, apiToken: 'gc_gw_x' });
    assert.equal(cfg.peer_id, 3);
    assert.equal(cfg.config_hash, 'sha256:xyz');
    assert.match(req.headers.authorization, /Bearer gc_gw_x/);
    server.close();
  });

  it('checkHash returns 304 as { changed: false }', async () => {
    const server = http.createServer((r, res) => { res.writeHead(304); res.end(); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const result = await checkHash({ serverUrl: `http://127.0.0.1:${server.address().port}`, apiToken: 'x', hash: 'sha256:a' });
    assert.equal(result.changed, false);
    server.close();
  });
});
