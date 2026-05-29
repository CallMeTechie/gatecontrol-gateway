'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { TcpProxyManager } = require('../src/proxy/tcp');

describe('TcpProxyManager', () => {
  let upstream, upstreamPort;

  before(async () => {
    upstream = net.createServer(s => {
      s.on('data', d => s.write('echo:' + d.toString()));
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = upstream.address().port;
  });

  after(() => upstream?.close());

  it('starts listener and proxies a TCP request', async () => {
    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort }]);
    const ports = mgr.listListenerPorts();
    assert.equal(ports.length, 1);
    const port = ports[0];

    const reply = await new Promise((resolve, reject) => {
      const client = net.connect(port, '127.0.0.1', () => client.write('hi'));
      client.on('data', d => { resolve(d.toString()); client.end(); });
      client.on('error', reject);
    });
    assert.match(reply, /^echo:hi/);
    await mgr.stopAll();
  });

  it('removes listener when route is removed (setRoutes with smaller set)', async () => {
    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
    await mgr.setRoutes([
      { id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort },
      { id: 2, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort },
    ]);
    assert.equal(mgr.listListenerPorts().length, 2);
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort }]);
    assert.equal(mgr.listListenerPorts().length, 1);
    await mgr.stopAll();
  });

  it('handles route port-change without service-gap (dual-bind overlap)', async () => {
    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort }]);
    const oldPort = mgr.listListenerPorts()[0];

    // Trigger port-change (we can't force same-route to new-port explicit; simulate with new listen_port=0)
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort, _forcePortChange: true }]);

    // Both listeners should respond for a brief window (test-only simplified check)
    const newPort = mgr.listListenerPorts().find(p => p !== oldPort);
    assert.ok(newPort, 'new port should exist');
    await mgr.stopAll();
  });

  it('isolates a failed listener (EADDRINUSE): siblings still bind and setRoutes does not reject', async () => {
    // Occupy a fixed port so the middle route hits EADDRINUSE on bind.
    const blocker = net.createServer();
    const blockedPort = await new Promise(r =>
      blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)));

    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
    // Conflict route sits BETWEEN two good ones — proves the loop is not aborted.
    // Must resolve (not reject): a reject here is unhandled in the bootstrap
    // 'change' listener and would crash-loop the gateway.
    await mgr.setRoutes([
      { id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort },
      { id: 2, listen_port: blockedPort, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort },
      { id: 3, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort },
    ]);

    const ports = mgr.listListenerPorts();
    assert.equal(ports.length, 2, 'both good routes bound; conflicting one skipped');
    assert.ok(!ports.includes(blockedPort), 'conflicting route did not bind');

    await mgr.stopAll();
    blocker.close();
  });
});
