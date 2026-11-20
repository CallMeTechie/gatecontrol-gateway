'use strict';

// UDP-Weiterleitung (src/proxy/udp.js, docs/udp.md). Echte Sockets an
// 127.0.0.1: das "Ziel im Heimnetz" ist ein UDP-Dienst am Loopback, der
// UdpProxyManager bindet an dieselbe Adresse (im Betrieb: die Tunnel-IP).

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { Resolver } = require('node:dns').promises;
const {
  UdpProxyManager, udpOptionsFromEnv, normalizeUdpRoutes, isUnsupportedTarget,
  DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_SESSIONS,
} = require('../src/proxy/udp');

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

function udpServer(onMessage) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (msg, rinfo) => onMessage(s, msg, rinfo));
    s.bind(0, '127.0.0.1', () => {
      cleanup.push(() => new Promise(r => { try { s.close(r); } catch { r(); } }));
      resolve(s);
    });
  });
}
const echoServer = () => udpServer((s, msg, rinfo) => s.send(Buffer.concat([Buffer.from('echo:'), msg]), rinfo.port, rinfo.address));

function client() {
  return new Promise((resolve) => {
    const c = dgram.createSocket('udp4');
    c.bind(0, '127.0.0.1', () => {
      cleanup.push(() => new Promise(r => { try { c.close(r); } catch { r(); } }));
      resolve(c);
    });
  });
}

function request(c, port, payload, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { c.off('message', on); reject(new Error('no reply')); }, timeoutMs);
    const on = (msg) => { clearTimeout(t); c.off('message', on); resolve(msg); };
    c.on('message', on);
    c.send(payload, port, '127.0.0.1');
  });
}

async function freeUdpPort() {
  const s = dgram.createSocket('udp4');
  await new Promise(r => s.bind(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise(r => setTimeout(r, 10));
  }
};

function manager(opts = {}) {
  const mgr = new UdpProxyManager({ bindIp: '127.0.0.1', ...opts });
  cleanup.push(() => mgr.stopAll());
  return mgr;
}

describe('UDP: Eingaben', () => {
  it('normalizeUdpRoutes: nur gültige Einträge, ohne Dubletten', () => {
    assert.deepEqual(normalizeUdpRoutes(undefined), []);
    assert.deepEqual(normalizeUdpRoutes({}), []);
    const out = normalizeUdpRoutes([
      { id: 1, listen_port: 5353, target_lan_host: ' 192.168.1.20 ', target_lan_port: 53, extra: 'x' },
      { id: 1, listen_port: 5354, target_lan_host: '192.168.1.21', target_lan_port: 53 },
      { id: 2, listen_port: 0, target_lan_host: '192.168.1.20', target_lan_port: 53 },
      { id: 3, listen_port: 70000, target_lan_host: '192.168.1.20', target_lan_port: 53 },
      { id: 4, listen_port: 5000, target_lan_host: '', target_lan_port: 53 },
      { id: -1, listen_port: 5000, target_lan_host: 'nas.lan', target_lan_port: 53 },
      { id: 5, listen_port: '5000', target_lan_host: 'nas.lan', target_lan_port: 53 },
      { id: 6, listen_port: 27015, target_lan_host: '[fd00::20]', target_lan_port: 27015 },
      null,
    ]);
    assert.deepEqual(out, [
      { id: 1, listen_port: 5353, target_lan_host: '192.168.1.20', target_lan_port: 53 },
      { id: 6, listen_port: 27015, target_lan_host: 'fd00::20', target_lan_port: 27015 },
    ]);
  });

  it('udpOptionsFromEnv: Standard 60 s / 1024, Grenzen geprüft', () => {
    assert.deepEqual(udpOptionsFromEnv({}), { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS, maxSessions: DEFAULT_MAX_SESSIONS });
    assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 60_000);
    assert.deepEqual(udpOptionsFromEnv({ GC_UDP_IDLE_TIMEOUT_S: '15', GC_UDP_MAX_SESSIONS: '200' }), { idleTimeoutMs: 15_000, maxSessions: 200 });
    assert.deepEqual(udpOptionsFromEnv({ GC_UDP_IDLE_TIMEOUT_S: '1', GC_UDP_MAX_SESSIONS: 'viele' }), { idleTimeoutMs: 60_000, maxSessions: 1024 });
    assert.deepEqual(udpOptionsFromEnv({ GC_UDP_IDLE_TIMEOUT_S: '2.5', GC_UDP_MAX_SESSIONS: '99999' }), { idleTimeoutMs: 60_000, maxSessions: 1024 });
  });

  it('isUnsupportedTarget: Broadcast und Multicast', () => {
    for (const h of ['255.255.255.255', '224.0.0.251', '239.255.255.250', '0.0.0.0', 'ff02::fb', '[ff02::1]', '::']) assert.equal(isUnsupportedTarget(h), true, h);
    for (const h of ['192.168.1.20', '10.0.0.255', 'nas.lan', 'fd00::20', '127.0.0.1']) assert.equal(isUnsupportedTarget(h), false, h);
  });
});

describe('UDP: Weiterleitung mit echten Sockets', () => {
  it('Echo: Datagramm hin und Antwort zurück, Zähler stimmen', async () => {
    const echo = await echoServer();
    const mgr = manager();
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: echo.address().port }]);
    const [port] = mgr.listListenerPorts();
    assert.ok(port > 0);

    const c = await client();
    assert.equal((await request(c, port, 'hallo')).toString(), 'echo:hallo');
    assert.equal((await request(c, port, 'noch mal')).toString(), 'echo:noch mal');

    const [st] = mgr.getStatus();
    assert.equal(st.route_id, 1);
    assert.equal(st.sessions, 1, 'derselbe Absender – eine Zuordnung');
    assert.equal(st.sessions_total, 1);
    assert.equal(st.datagrams_in, 2);
    assert.equal(st.datagrams_out, 2);
    assert.equal(st.bytes_in, 'hallo'.length + 'noch mal'.length);
    assert.equal(st.bytes_out, 'echo:hallo'.length + 'echo:noch mal'.length);
    assert.deepEqual(mgr.listListenerIssues(), []);
  });

  it('jeder Absender bekommt seine eigene Antwort (Zuordnung je Quell-IP:Port)', async () => {
    // Das Ziel antwortet mit dem Quellport, den es sieht – je Absender ein anderer Upstream-Socket
    const target = await udpServer((s, msg, rinfo) => s.send(`${msg}@${rinfo.port}`, rinfo.port, rinfo.address));
    const mgr = manager();
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: target.address().port }]);
    const [port] = mgr.listListenerPorts();
    const a = await client();
    const b = await client();
    const [ra, rb] = await Promise.all([request(a, port, 'a'), request(b, port, 'b')]);
    const [pa, pb] = [ra.toString().split('@'), rb.toString().split('@')];
    assert.equal(pa[0], 'a');
    assert.equal(pb[0], 'b');
    assert.notEqual(pa[1], pb[1], 'zwei Absender – zwei Upstream-Sockets');
    assert.equal(mgr.getStatus()[0].sessions, 2);
  });

  it('DNS-artig: der Resolver von Node fragt über das Gateway, Antwort mit passender ID', async () => {
    // Winziger DNS-Server: beantwortet jede A-Frage mit 192.0.2.10
    const dnsServer = await udpServer((s, q, rinfo) => {
      let off = 12;
      while (q[off] !== 0) off += q[off] + 1;
      const question = q.subarray(12, off + 5);
      const header = Buffer.from([q[0], q[1], 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
      const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 10]);
      s.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
    });
    const mgr = manager();
    await mgr.setRoutes([{ id: 9, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: dnsServer.address().port }]);
    const [port] = mgr.listListenerPorts();
    const resolver = new Resolver({ timeout: 1500, tries: 1 });
    resolver.setServers([`127.0.0.1:${port}`]);
    assert.deepEqual(await resolver.resolve4('drucker.heimnetz.example'), ['192.0.2.10']);
    assert.deepEqual(await resolver.resolve4('nas.heimnetz.example'), ['192.0.2.10']);
    const [st] = mgr.getStatus();
    assert.ok(st.datagrams_in >= 2 && st.datagrams_out >= 2);
  });

  it('Ziel antwortet mit ICMP „port unreachable“: gezählt, Zuordnung geschlossen, nächste Anfrage öffnet eine neue', async () => {
    const closedPort = await freeUdpPort();
    const mgr = manager();
    await mgr.setRoutes([{ id: 2, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: closedPort }]);
    const [port] = mgr.listListenerPorts();
    const c = await client();
    c.send('x', port, '127.0.0.1');
    await until(() => mgr.getStatus()[0].icmp_unreachable >= 1);
    // die Antwort von ICMP kommt beim nächsten Empfang – die Zuordnung ist dann weg
    await until(() => mgr.getStatus()[0].sessions === 0);
    c.send('y', port, '127.0.0.1');
    await until(() => mgr.getStatus()[0].sessions_total === 2);
  });

  it('Ziel-Name, der sich nicht auflösen lässt: Fehler gezählt, kein Absturz', async () => {
    const mgr = manager();
    await mgr.setRoutes([{ id: 3, listen_port: 0, target_lan_host: 'gibt-es-nicht.invalid', target_lan_port: 53 }]);
    const [port] = mgr.listListenerPorts();
    const c = await client();
    c.send('x', port, '127.0.0.1');
    await until(() => mgr.getStatus()[0].upstream_errors >= 1, 5000);
    assert.equal(mgr.getStatus()[0].sessions, 0);
  });

  it('Leerlauf: ruhende Zuordnungen werden geschlossen', async () => {
    let now = 1_000_000;
    const echo = await echoServer();
    const mgr = manager({ idleTimeoutMs: 10_000, now: () => now });
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: echo.address().port }]);
    const [port] = mgr.listListenerPorts();
    const c = await client();
    await request(c, port, 'a');
    now += 9_000;
    assert.equal(mgr.sweepIdle(), 0);
    now += 2_000;
    assert.equal(mgr.sweepIdle(), 1);
    const st = mgr.getStatus()[0];
    assert.equal(st.sessions, 0);
    assert.equal(st.idle_closed, 1);
    // danach geht es mit einer neuen Zuordnung weiter
    assert.equal((await request(c, port, 'b')).toString(), 'echo:b');
  });

  it('Obergrenze: neue Absender werden verworfen, solange keine Zuordnung lange genug ruht', async () => {
    let now = 5_000_000;
    const echo = await echoServer();
    const mgr = manager({ maxSessions: 2, now: () => now });
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: echo.address().port }]);
    const [port] = mgr.listListenerPorts();
    const [a, b, c] = [await client(), await client(), await client()];
    await request(a, port, 'a');
    await request(b, port, 'b');
    await assert.rejects(request(c, port, 'c', 300), /no reply/);
    assert.equal(mgr.getStatus()[0].dropped_limit, 1);
    assert.equal(mgr.getStatus()[0].sessions, 2);
    // die älteste ruht jetzt lange genug → wird für den neuen Absender freigegeben
    now += 3_000;
    assert.equal((await request(c, port, 'c')).toString(), 'echo:c');
    const st = mgr.getStatus()[0];
    assert.equal(st.evicted, 1);
    assert.equal(st.sessions, 2);
  });

  it('neues Ziel: Socket bleibt, Zuordnungen beginnen neu; Route weg → Listener zu', async () => {
    const one = await udpServer((s, m, r) => s.send('eins', r.port, r.address));
    const two = await udpServer((s, m, r) => s.send('zwei', r.port, r.address));
    const mgr = manager();
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: one.address().port }]);
    const [port] = mgr.listListenerPorts();
    const c = await client();
    assert.equal((await request(c, port, 'x')).toString(), 'eins');
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: two.address().port }]);
    assert.deepEqual(mgr.listListenerPorts(), [port]);
    assert.equal(mgr.getStatus()[0].sessions, 0);
    assert.equal((await request(c, port, 'x')).toString(), 'zwei');
    await mgr.setRoutes([]);
    assert.deepEqual(mgr.listListenerPorts(), []);
    assert.deepEqual(mgr.getStatus(), []);
  });

  it('neuer Listen-Port: neuer Socket, alter geschlossen', async () => {
    const echo = await echoServer();
    const mgr = manager();
    const p1 = await freeUdpPort();
    const route = { id: 1, listen_port: p1, target_lan_host: '127.0.0.1', target_lan_port: echo.address().port };
    await mgr.setRoutes([route]);
    assert.deepEqual(mgr.listListenerPorts(), [p1]);
    const p2 = await freeUdpPort();
    await mgr.setRoutes([{ ...route, listen_port: p2 }]);
    assert.deepEqual(mgr.listListenerPorts(), [p2]);
    const c = await client();
    assert.equal((await request(c, p2, 'q')).toString(), 'echo:q');
  });

  it('Port belegt: Grund im Bericht, andere Routen laufen; Multicast-Ziel abgelehnt', async () => {
    const echo = await echoServer();
    const busy = await udpServer(() => {});
    const busyPort = busy.address().port;
    const mgr = manager();
    await mgr.setRoutes([
      { id: 1, listen_port: busyPort, target_lan_host: '192.168.1.20', target_lan_port: 53 },
      { id: 2, listen_port: 0, target_lan_host: '239.255.255.250', target_lan_port: 1900 },
      { id: 3, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: echo.address().port },
    ]);
    assert.equal(mgr.listListenerPorts().length, 1);
    const issues = mgr.listListenerIssues();
    assert.deepEqual(issues.find(i => i.route_id === 1), { route_id: 1, listen_port: busyPort, reason: 'port_in_use', code: 'EADDRINUSE', protocol: 'udp' });
    assert.deepEqual(issues.find(i => i.route_id === 2), { route_id: 2, listen_port: 0, reason: 'error', code: 'UNSUPPORTED_TARGET', protocol: 'udp' });
    // Port wieder frei → der nächste Abgleich bindet ihn
    await new Promise(r => busy.close(r));
    await mgr.setRoutes([
      { id: 1, listen_port: busyPort, target_lan_host: '127.0.0.1', target_lan_port: echo.address().port },
      { id: 3, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: echo.address().port },
    ]);
    assert.equal(mgr.listListenerPorts().length, 2);
    assert.deepEqual(mgr.listListenerIssues(), []);
  });

  it('Ziel ist dieser Host auf demselben Port und der Dienst hält ihn: direkt bedient, kein Fehler', async () => {
    const service = await udpServer(() => {});
    const port = service.address().port;
    const mgr = manager();
    await mgr.setRoutes([{ id: 4, listen_port: port, target_lan_host: '127.0.0.1', target_lan_port: port }]);
    assert.deepEqual(mgr.listListenerPorts(), []);
    assert.deepEqual(mgr.listListenerIssues(), []);
    assert.deepEqual(mgr.listDirectRoutes(), [{ route_id: 4, listen_port: port, protocol: 'udp' }]);
  });
});
