'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { ConfigStore } = require('../src/sync/configStore');
const { EgressProxyManager } = require('../src/proxy/egress');

describe('egress wiring: config change applies egress routes', () => {
  let upstream, upstreamPort;
  before(async () => {
    upstream = net.createServer(s => s.on('data', d => s.write('echo:' + d.toString())));
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = upstream.address().port;
  });
  after(() => upstream?.close());

  it('binds an egress listener when config arrives via ConfigStore change', async () => {
    const store = new ConfigStore();
    const egressMgr = new EgressProxyManager();
    // Mirror of bootstrap.js store.on('change') wiring:
    store.on('change', async ({ cfg }) => {
      await egressMgr.setRoutes(cfg.egress_routes || []);
    });

    store.replaceConfig({
      routes: [], l4_routes: [],
      egress_routes: [{
        id: 1, lan_bind_ip: '127.0.0.1', lan_listen_port: 0,
        tunnel_target_host: '127.0.0.1', tunnel_target_port: upstreamPort,
        allowed_source_ips: ['127.0.0.1/32'],
      }],
    }, 'h1');

    // change handler is async — let the microtask/IO settle.
    await new Promise(r => setTimeout(r, 50));
    const ports = egressMgr.listListenerPorts();
    assert.equal(ports.length, 1, 'one egress listener bound from config');

    const reply = await new Promise((resolve, reject) => {
      const client = net.connect(ports[0], '127.0.0.1', () => client.write('hi'));
      client.on('data', d => { resolve(d.toString()); client.end(); });
      client.on('error', reject);
    });
    assert.match(reply, /^echo:hi/);
    await egressMgr.stopAll();
  });
});
