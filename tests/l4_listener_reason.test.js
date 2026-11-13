'use strict';

// Fehlende L4-Listener: Grund im Heartbeat, und kein falscher Alarm, wenn der
// Zieldienst dieses Hosts den Listen-Port selbst hält. Echte Sockets: der
// "Zieldienst" ist ein TCP-Server an 127.0.0.1, der TcpProxyManager bindet an
// dieselbe Adresse (im Betrieb: die Tunnel-IP im Host-Netz).

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const dgram = require('node:dgram');
const { TcpProxyManager, isSelfTarget, bindReason } = require('../src/proxy/tcp');
const { createSelfCheckRunner } = require('../src/health/selfCheckRunner');

const open = [];
function listen(handler) {
  return new Promise((resolve) => {
    // Proben brechen die Verbindung sofort wieder ab – das ist kein Fehler des Tests
    const s = net.createServer(sock => { sock.on('error', () => {}); (handler || (x => x.end()))(sock); });
    s.listen(0, '127.0.0.1', () => { open.push(s); resolve(s); });
  });
}
const close = (s) => new Promise(r => s.close(r));
// ein Port, an dem gerade nichts lauscht
async function freePort() { const s = await listen(); const p = s.address().port; open.splice(open.indexOf(s), 1); await close(s); return p; }

async function setup(l4Routes) {
  const proxy = await listen();
  const api = await listen();
  const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
  const store = { httpRoutes: [], l4Routes };
  const run = createSelfCheckRunner({
    config: { proxyPort: proxy.address().port, apiPort: api.address().port, tunnelIp: '127.0.0.1', serverUrl: 'https://127.0.0.1' },
    store, tcpMgr: mgr, wireguard: { getStatus: async () => ({ peers: [] }) },
  });
  open.push({ close: (cb) => mgr.stopAll().then(cb) });
  return { mgr, run, store };
}

describe('L4-Listener: Grund und Selbstziel', () => {
  afterEach(async () => { while (open.length) await close(open.pop()); });

  it('Port belegt + Ziel ist dieser Host auf demselben Port: nicht fehlend, nicht degradiert, kein Reapply', async () => {
    const service = await listen(sock => sock.end('dienst'));
    const port = service.address().port;
    const { mgr, run, store } = await setup([{ id: 5, listen_port: port, target_lan_host: '127.0.0.1', target_lan_port: port }]);
    await mgr.setRoutes(store.l4Routes);

    assert.deepEqual(mgr.listListenerPorts(), []);
    assert.deepEqual(mgr.listDirectRoutes(), [{ route_id: 5, listen_port: port }]);
    assert.deepEqual(mgr.listListenerIssues(), []);

    let applies = 0;
    const orig = mgr.setRoutes.bind(mgr);
    mgr.setRoutes = async (r) => { applies++; return orig(r); };
    for (let i = 0; i < 3; i++) {
      const h = await run({ reconcile: true });
      assert.equal(h.l4_routes_configured, 1);
      assert.equal(h.l4_listeners_missing, 0);
      assert.deepEqual(h.l4_listener_issues, []);
      assert.deepEqual(h.l4_listeners_direct, [{ route_id: 5, listen_port: port, reachable: true }]);
      assert.equal(h.overall_healthy, true);
      assert.equal(h.listener_reapply_triggered, undefined);
    }
    assert.equal(applies, 0, 'kein Reapply bei jedem Heartbeat');

    // der Dienst antwortet an der Adresse, die der Server anwählt, wirklich selbst
    const reply = await new Promise((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1'); let buf = '';
      c.on('data', d => { buf += d; }); c.on('end', () => resolve(buf)); c.on('error', reject);
    });
    assert.equal(reply, 'dienst');
  });

  it('eigene LAN-Adresse des Hosts als Ziel zählt wie Loopback', async () => {
    const service = await listen();
    const port = service.address().port;
    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1', localAddrs: () => ['192.168.2.151'] });
    await mgr.setRoutes([{ id: 6, listen_port: port, target_lan_host: '192.168.2.151', target_lan_port: port }]);
    assert.deepEqual(mgr.listDirectRoutes(), [{ route_id: 6, listen_port: port }]);
    assert.deepEqual(mgr.listListenerIssues(), []);
  });

  it('Port belegt + fremdes Ziel: fehlend mit Grund port_in_use, degradiert, Reapply bleibt', async () => {
    const occupied = await listen();
    const port = occupied.address().port;
    const { mgr, run, store } = await setup([{ id: 7, listen_port: port, target_lan_host: '192.0.2.10', target_lan_port: port }]);
    await mgr.setRoutes(store.l4Routes);

    const h = await run({ reconcile: true });
    assert.equal(h.l4_listeners_missing, 1);
    assert.deepEqual(h.l4_listener_issues, [{ route_id: 7, listen_port: port, reason: 'port_in_use', code: 'EADDRINUSE' }]);
    assert.deepEqual(h.l4_listeners_direct, []);
    assert.equal(h.overall_healthy, false);
    assert.equal(h.listener_reapply_triggered, true);
  });

  it('Port belegt + dieser Host, aber anderer Zielport: fehlend mit Grund', async () => {
    const occupied = await listen();
    const port = occupied.address().port;
    const other = await listen();
    const { mgr, run, store } = await setup([{ id: 8, listen_port: port, target_lan_host: '127.0.0.1', target_lan_port: other.address().port }]);
    await mgr.setRoutes(store.l4Routes);
    const h = await run();
    assert.equal(h.l4_listeners_missing, 1);
    assert.equal(h.l4_listener_issues[0].reason, 'port_in_use');
    assert.equal(h.overall_healthy, false);
  });

  it('Port wird frei: der nächste Heartbeat bindet nach, der Grund verschwindet', async () => {
    const occupied = await listen();
    const port = occupied.address().port;
    const { mgr, run, store } = await setup([{ id: 9, listen_port: port, target_lan_host: '192.0.2.10', target_lan_port: 80 }]);
    await mgr.setRoutes(store.l4Routes);
    assert.equal(mgr.listListenerIssues().length, 1);
    open.splice(open.indexOf(occupied), 1); await close(occupied);

    const h = await run({ reconcile: true });
    assert.equal(h.listener_reapply_triggered, true);
    assert.equal(h.l4_listeners_missing, 0);
    assert.deepEqual(h.l4_listener_issues, []);
    assert.equal(h.overall_healthy, true);
    assert.deepEqual(mgr.listListenerPorts(), [port]);
  });

  it('normaler Fall: Listener offen, nichts fehlt, leere Listen', async () => {
    const target = await listen();
    const port = await freePort();
    const { mgr, run, store } = await setup([{ id: 10, listen_port: port, target_lan_host: '127.0.0.1', target_lan_port: target.address().port }]);
    await mgr.setRoutes(store.l4Routes);
    const h = await run({ reconcile: true });
    assert.equal(h.l4_listeners_missing, 0);
    assert.deepEqual(h.l4_listener_issues, []);
    assert.deepEqual(h.l4_listeners_direct, []);
    assert.equal(h.overall_healthy, true);
  });

  it('Direkt bediente Route: Dienst weg → kein Nachbinden (Port bleibt dem Dienst), erreichbar=false, nicht degradiert', async () => {
    const service = await listen();
    const port = service.address().port;
    const { mgr, run, store } = await setup([{ id: 11, listen_port: port, target_lan_host: '127.0.0.1', target_lan_port: port }]);
    await mgr.setRoutes(store.l4Routes);
    open.splice(open.indexOf(service), 1); await close(service);

    const h = await run({ reconcile: true });
    assert.deepEqual(h.l4_listeners_direct, [{ route_id: 11, listen_port: port, reachable: false }]);
    assert.equal(h.l4_listeners_missing, 0);
    assert.equal(h.overall_healthy, true);
    await mgr.setRoutes(store.l4Routes);
    assert.deepEqual(mgr.listListenerPorts(), [], 'der Port wird dem Dienst nicht weggenommen');

    // geänderte Route (anderes Ziel): wird wieder normal gebunden
    store.l4Routes = [{ id: 11, listen_port: port, target_lan_host: '192.0.2.10', target_lan_port: port }];
    await mgr.setRoutes(store.l4Routes);
    assert.deepEqual(mgr.listListenerPorts(), [port]);
    assert.deepEqual(mgr.listDirectRoutes(), []);
  });

  it('UDP: ein reiner UDP-Dienst am Port stört den (TCP-)Listener nicht – die Route zählt als vorhanden', async () => {
    const port = await freePort();
    const udp = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(port, '127.0.0.1', resolve); });
    open.push(udp);
    const { mgr, run, store } = await setup([{ id: 12, listen_port: port, target_lan_host: '127.0.0.1', target_lan_port: port }]);
    await mgr.setRoutes(store.l4Routes);
    const h = await run();
    assert.deepEqual(mgr.listListenerPorts(), [port]);
    assert.equal(h.l4_listeners_missing, 0);
    assert.deepEqual(h.l4_listeners_direct, []);
  });

  it('Adresse nicht vorhanden: Grund address_unavailable', async () => {
    const mgr = new TcpProxyManager({ bindIp: '192.0.2.1' });
    await mgr.setRoutes([{ id: 13, listen_port: 45000, target_lan_host: '192.0.2.10', target_lan_port: 80 }]);
    assert.deepEqual(mgr.listListenerIssues(), [{ route_id: 13, listen_port: 45000, reason: 'address_unavailable', code: 'EADDRNOTAVAIL' }]);
  });

  it('entfernte Route: Grund und Direkt-Eintrag verschwinden', async () => {
    const occupied = await listen();
    const port = occupied.address().port;
    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
    await mgr.setRoutes([
      { id: 14, listen_port: port, target_lan_host: '192.0.2.10', target_lan_port: 80 },
      { id: 15, listen_port: port, target_lan_host: '127.0.0.1', target_lan_port: port },
    ]);
    assert.equal(mgr.listListenerIssues().length, 1);
    assert.equal(mgr.listDirectRoutes().length, 1);
    await mgr.setRoutes([]);
    assert.deepEqual(mgr.listListenerIssues(), []);
    assert.deepEqual(mgr.listDirectRoutes(), []);
  });

  it('bindReason / isSelfTarget', () => {
    assert.equal(bindReason('EADDRINUSE'), 'port_in_use');
    assert.equal(bindReason('EACCES'), 'permission_denied');
    assert.equal(bindReason('EPERM'), 'permission_denied');
    assert.equal(bindReason('EADDRNOTAVAIL'), 'address_unavailable');
    assert.equal(bindReason('EMFILE'), 'error');
    assert.equal(bindReason('constructor'), 'error');
    assert.equal(bindReason(null), 'error');

    const addrs = ['192.168.2.151', 'fe80::1'];
    const r = (host, lp, tp) => ({ listen_port: lp, target_lan_host: host, target_lan_port: tp });
    assert.equal(isSelfTarget(r('192.168.2.151', 5335, 5335), '10.8.0.5', addrs), true);
    assert.equal(isSelfTarget(r('10.8.0.5', 5335, 5335), '10.8.0.5', addrs), true);
    assert.equal(isSelfTarget(r('localhost', 5335, 5335), '10.8.0.5', addrs), true);
    assert.equal(isSelfTarget(r('127.0.0.1', 5335, 5335), '10.8.0.5', addrs), true);
    assert.equal(isSelfTarget(r('192.168.2.151', 5335, 53), '10.8.0.5', addrs), false, 'anderer Zielport');
    assert.equal(isSelfTarget(r('192.168.2.150', 5335, 5335), '10.8.0.5', addrs), false, 'fremder Host');
    assert.equal(isSelfTarget(r('', 5335, 5335), '10.8.0.5', addrs), false);
    assert.equal(isSelfTarget(r('127.0.0.1', 0, 0), '10.8.0.5', addrs), false, 'Port 0 ist kein fester Port');
  });
});
