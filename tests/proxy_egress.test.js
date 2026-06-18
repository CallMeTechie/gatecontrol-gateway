'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EgressProxyManager } = require('../src/proxy/egress');

describe('EgressProxyManager', () => {
  let upstream, upstreamPort;

  before(async () => {
    // Stand-in for the server-side tunnel endpoint: echoes back.
    upstream = net.createServer(s => {
      s.on('data', d => s.write('echo:' + d.toString()));
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = upstream.address().port;
  });

  after(() => upstream?.close());

  const route = (over = {}) => ({
    id: 1, lan_bind_ip: '127.0.0.1', lan_listen_port: 0,
    tunnel_target_host: '127.0.0.1', tunnel_target_port: upstreamPort,
    allowed_source_ips: ['127.0.0.1/32'], ...over,
  });

  it('forwards a connection from an allowed source into the tunnel target', async () => {
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([route()]);
    const port = mgr.listListenerPorts()[0];
    const reply = await new Promise((resolve, reject) => {
      const client = net.connect(port, '127.0.0.1', () => client.write('hi'));
      client.on('data', d => { resolve(d.toString()); client.end(); });
      client.on('error', reject);
    });
    assert.match(reply, /^echo:hi/);
    await mgr.stopAll();
  });

  it('drops a connection whose source is not in the allowlist', async () => {
    const mgr = new EgressProxyManager();
    // Loopback client is 127.0.0.1 — allowlist deliberately excludes it.
    await mgr.setRoutes([route({ allowed_source_ips: ['10.0.0.1/32'] })]);
    const port = mgr.listListenerPorts()[0];
    const gotData = await new Promise((resolve) => {
      let received = false;
      const client = net.connect(port, '127.0.0.1', () => client.write('hi'));
      client.on('data', () => { received = true; });
      client.on('close', () => resolve(received));
      client.on('error', () => resolve(received)); // RST/destroy is acceptable
    });
    assert.equal(gotData, false, 'denied source must receive no upstream data');
    await mgr.stopAll();
  });

  it('removes a listener when the route is dropped from the set', async () => {
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([route({ id: 1 }), route({ id: 2 })]);
    assert.equal(mgr.listListenerPorts().length, 2);
    await mgr.setRoutes([route({ id: 1 })]);
    assert.equal(mgr.listListenerPorts().length, 1);
    await mgr.stopAll();
  });

  it('isolates a failed bind (EADDRINUSE): siblings still bind and setRoutes does not reject', async () => {
    const blocker = net.createServer();
    const blockedPort = await new Promise(r =>
      blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)));
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([
      route({ id: 1, lan_listen_port: 0 }),
      route({ id: 2, lan_listen_port: blockedPort }),
      route({ id: 3, lan_listen_port: 0 }),
    ]);
    const ports = mgr.listListenerPorts();
    assert.equal(ports.length, 2, 'both ephemeral routes bound; conflicting one skipped');
    assert.ok(!ports.includes(blockedPort), 'conflicting route did not bind');
    await mgr.stopAll();
    blocker.close();
  });

  it('transitions on target change without rejecting (dual-bind overlap)', async () => {
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([route({ id: 1 })]);
    const oldPort = mgr.listListenerPorts()[0];
    // Change the tunnel target → triggers a dual-bind transition to a new listener.
    await mgr.setRoutes([route({ id: 1, tunnel_target_port: upstreamPort, lan_listen_port: 0, allowed_source_ips: ['127.0.0.1/32', '10.0.0.0/8'] })]);
    const newPort = mgr.listListenerPorts().find(p => p !== oldPort);
    assert.ok(newPort, 'new listener should exist after transition');
    await mgr.stopAll();
  });
});
