'use strict';

// Edge-Host als eigener Prozess für tests/edge_isolated_sockets.test.js:
// zuerst Haken auf alle Netzfunktionen (TCP/TLS über net.Socket#connect,
// UDP über dgram, Lauschen über net.Server#listen) – jeder Versuch mit einer
// IP-Adresse statt eines Unix-Socket-Pfads wird notiert. Danach der echte
// Edge-Host mit dem Gateway-Socket aus GC_TEST_RUN_DIR. Der Elternprozess
// fragt per IPC nach den notierten Versuchen.

const net = require('node:net');
const dgram = require('node:dgram');

const attempts = [];

function describe(arg) {
  let o = Array.isArray(arg) ? arg[0] : arg;
  if (o && typeof o === 'object') return typeof o.path === 'string' && o.path ? null : { host: o.host || null, port: o.port || null };
  if (typeof o === 'string' && !/^\d+$/.test(o)) return null; // Pfad
  return { port: o };
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const d = describe(args[0]);
  if (d) attempts.push({ kind: 'tcp', ...d });
  return origConnect.apply(this, args);
};
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function listen(...args) {
  const d = describe(args[0]);
  if (d) attempts.push({ kind: 'listen', ...d });
  return origListen.apply(this, args);
};
for (const m of ['bind', 'send', 'connect']) {
  const orig = dgram.Socket.prototype[m];
  dgram.Socket.prototype[m] = function hooked(...args) {
    attempts.push({ kind: `udp.${m}` });
    return orig.apply(this, args);
  };
}

const path = require('node:path');
const { EdgeHost } = require('../../src/edge/host');

const runDir = process.env.GC_TEST_RUN_DIR;
const base = process.env.GC_TEST_STATE_DIR;

const host = new EdgeHost({
  paths: { runDir, statusDir: path.join(base, 'status'), stateDir: base, packagesDir: path.join(base, 'packages'), dataDir: path.join(base, 'data') },
  keys: [process.env.GC_TEST_KEY],
  // Unit-Test: die Testumgebung hat Netz – die Prüfung selbst testet edge_fence_check.test.js;
  // Live-Test (tests/live/edge-isolated-live.js, eigener Netz-Namespace): die echte Prüfung
  ...(process.env.GC_TEST_REAL_BOUNDARY === '1' ? {} : { fenceCheck: async () => ({ mode: 'isolated', active: true, backend: 'isolated', reason: null }) }),
  hardware: () => null,
  backoff: [100, 200],
  timing: { statusDebounceMs: 20, statusEveryMs: 60000, fenceCheckMs: 60000 },
  rpcTiming: { rpcReconnectMinMs: 50, rpcReconnectMaxMs: 200 },
  channelTiming: { reconnectMinMs: 50, reconnectMaxMs: 300 },
});

process.on('message', async (m) => {
  if (m === 'attempts') { process.send({ attempts }); return; }
  if (m === 'selftest') {
    // die Haken greifen: ein TCP- und ein UDP-Versuch müssen notiert werden
    const before = attempts.length;
    const c = net.connect({ host: '127.0.0.1', port: 9 });
    c.on('error', () => {});
    c.destroy();
    const u = dgram.createSocket('udp4');
    u.on('error', () => {});
    u.send(Buffer.from('x'), 9, '127.0.0.1', () => u.close());
    process.send({ selftest: attempts.slice(before) });
    return;
  }
  if (m && m.direct) {
    // Gegenprobe im Live-Test: direkt zum Server – ohne Netz muss das scheitern
    const c = net.connect({ host: m.direct.host, port: m.direct.port });
    const t = setTimeout(() => { c.destroy(); process.send({ direct: 'PENDING' }); }, 2000);
    c.on('connect', () => { clearTimeout(t); c.destroy(); process.send({ direct: 'CONNECTED' }); });
    c.on('error', (e) => { clearTimeout(t); process.send({ direct: e.code || 'ERROR' }); });
    return;
  }
  if (m === 'mode') { process.send({ mode: { mode: host.mode, fence: host.fence } }); return; }
  if (m === 'stop') { await host.stop(); process.exit(0); }
});

host.start().then(() => process.send({ started: true }), (e) => { process.send({ error: e.message }); process.exit(1); });
