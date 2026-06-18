'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EgressProxyManager } = require('../src/proxy/egress');

describe('EgressProxyManager observability', () => {
  const route = (over = {}) => ({
    id: 1, lan_bind_ip: '127.0.0.1', lan_listen_port: 0,
    tunnel_target_host: '127.0.0.1', tunnel_target_port: 9, // discard — never actually contacted in these tests
    allowed_source_ips: ['127.0.0.1/32'], ...over,
  });

  it('reports a bound listener', async () => {
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([route()]);
    const st = mgr.getStatus();
    assert.equal(st.length, 1);
    assert.equal(st[0].bound, true);
    assert.equal(st[0].bind_error, null);
    assert.equal(st[0].source_drops, 0);
    await mgr.stopAll();
  });

  it('reports a failed bind with bind_error (not just a log)', async () => {
    const blocker = net.createServer();
    const blockedPort = await new Promise(r => blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)));
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([route({ lan_listen_port: blockedPort })]);
    const st = mgr.getStatus();
    assert.equal(st[0].bound, false);
    assert.ok(st[0].bind_error, 'bind_error code present (e.g. EADDRINUSE)');
    await mgr.stopAll();
    blocker.close();
  });

  it('self-heals: re-applying the same routes retries a previously-failed bind', async () => {
    const blocker = net.createServer();
    const blockedPort = await new Promise(r => blocker.listen(0, '127.0.0.1', () => r(blocker.address().port)));
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([route({ id: 1, lan_listen_port: blockedPort })]);
    assert.equal(mgr.getStatus()[0].bound, false);
    await new Promise(r => blocker.close(r)); // port frees
    await mgr.setRoutes([route({ id: 1, lan_listen_port: blockedPort })]); // reconcile tick re-applies
    assert.equal(mgr.getStatus()[0].bound, true, 'failed bind retried and succeeded on re-apply');
    await mgr.stopAll();
  });

  it('increments the source-lock drop counter for a denied source', async () => {
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([route({ allowed_source_ips: ['10.0.0.1/32'] })]); // loopback excluded
    const port = mgr.getStatus()[0].lan_listen_port === 0 ? mgr.listListenerPorts()[0] : mgr.listListenerPorts()[0];
    await new Promise((resolve) => {
      const client = net.connect(port, '127.0.0.1', () => client.write('hi'));
      client.on('close', resolve);
      client.on('error', resolve);
    });
    // drop is recorded on the rejected connection
    assert.ok(mgr.getStatus()[0].source_drops >= 1, 'denied connection counted');
    await mgr.stopAll();
  });

  it('drops removed routes from status', async () => {
    const mgr = new EgressProxyManager();
    await mgr.setRoutes([route({ id: 1 }), route({ id: 2 })]);
    assert.equal(mgr.getStatus().length, 2);
    await mgr.setRoutes([route({ id: 1 })]);
    const ids = mgr.getStatus().map(s => s.id);
    assert.deepEqual(ids, [1]);
    await mgr.stopAll();
  });
});
