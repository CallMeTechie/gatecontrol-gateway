'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const { createProbeRouter } = require('../src/api/routes/probe');

function mount(router) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}
function post(port, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/probe', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve(JSON.parse(b))); });
    req.end(data);
  });
}
// LAN-Stub: nur 192.168.2.0/24 gilt als eigenes LAN
const isHostAllowed = (host) => /^192\.168\.2\./.test(host) || !/^\d+\.\d+\.\d+\.\d+$/.test(host);

test('targeted probe honors in-LAN {host,port} and echoes probed_target', async () => {
  const tcpProbe = async (host, port) => port === 3389; // erreichbar nur auf 3389
  const { srv, port } = await mount(createProbeRouter({ lanProbeFn: async () => true, tcpProbe, isHostAllowed }));
  const ok = await post(port, { host: '192.168.2.144', port: 3389 });
  assert.deepStrictEqual(ok.probed_target, { host: '192.168.2.144', port: 3389 });
  assert.strictEqual(ok.probe_result, true);
  const down = await post(port, { host: '192.168.2.144', port: 13389 });
  assert.strictEqual(down.probe_result, false);
  srv.close();
});

test('out-of-LAN IPv4 target is rejected as offline (probed_target set, not fallback)', async () => {
  let called = false;
  const tcpProbe = async () => { called = true; return true; };
  const { srv, port } = await mount(createProbeRouter({ lanProbeFn: async () => true, tcpProbe, isHostAllowed }));
  const res = await post(port, { host: '8.8.8.8', port: 53 });
  assert.strictEqual(called, false, 'no probe attempted for out-of-LAN target');
  assert.deepStrictEqual(res.probed_target, { host: '8.8.8.8', port: 53 }, 'target echoed so server trusts the verdict');
  assert.strictEqual(res.probe_result, false, 'reported offline, NOT fallback');
  assert.strictEqual(res.rejected, 'out_of_lan_scope');
  srv.close();
});

test('hostname (non-IP) target is allowed through', async () => {
  const tcpProbe = async () => true;
  const { srv, port } = await mount(createProbeRouter({ lanProbeFn: async () => false, tcpProbe, isHostAllowed }));
  const res = await post(port, { host: 'winbox.local', port: 3389 });
  assert.deepStrictEqual(res.probed_target, { host: 'winbox.local', port: 3389 });
  assert.strictEqual(res.probe_result, true);
  srv.close();
});

test('legacy call without target falls back to lanProbeFn and omits probed_target', async () => {
  const tcpProbe = async () => true;
  const { srv, port } = await mount(createProbeRouter({ lanProbeFn: async () => true, tcpProbe, isHostAllowed }));
  const res = await post(port, {});
  assert.strictEqual(res.probe_result, true);
  assert.strictEqual(res.probed_target, null);
  srv.close();
});

test('malformed target is ignored (no probe attempted)', async () => {
  let called = false;
  const tcpProbe = async () => { called = true; return true; };
  const { srv, port } = await mount(createProbeRouter({ lanProbeFn: async () => false, tcpProbe, isHostAllowed }));
  const res = await post(port, { host: 'not a host', port: 99999 });
  assert.strictEqual(res.probed_target, null, 'invalid target ignored');
  assert.strictEqual(called, false, 'tcpProbe not called for invalid target');
  srv.close();
});
