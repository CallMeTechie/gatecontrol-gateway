#!/usr/bin/env node
'use strict';

// Live-Test der Edge-Netzgrenze gegen den echten Kernel – NUR in einem
// eigenen Netz-Namespace als root ausführen (setzt Regeln und Schnittstellen):
//
//   sudo unshare -n env GC_FENCE_BACKEND=nft node tests/live/edge-fence-live.js
//   sudo unshare -n env GC_FENCE_BACKEND=iptables GC_FENCE_IPTABLES=iptables-legacy \
//     GC_FENCE_IPTABLES_RESTORE=iptables-legacy-restore GC_FENCE_IP6TABLES=ip6tables-legacy \
//     GC_FENCE_IP6TABLES_RESTORE=ip6tables-legacy-restore node tests/live/edge-fence-live.js
//   docker run --rm --network none --cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID \
//     -v "$PWD:/w:ro" <gateway-image> node /w/tests/live/edge-fence-live.js   (Image-Binaries)
//
// Prüft als UID 61001 (Kindprozess), was die Regeln erlauben bzw. mit EPERM
// abweisen, und dass andere UIDs unberührt bleiben.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { FenceManager } = require('../../src/edge/fenceRules');

const UID = 61001;
const SERVER = '198.51.100.10';

function sh(cmd, args, ignore = false) {
  try { execFileSync(cmd, args, { stdio: ignore ? 'ignore' : 'inherit' }); return true; } catch (e) { if (!ignore) throw e; return false; }
}

// Probe-Code für den Kindprozess (ohne Repo-Dateien, läuft als UID 61001)
const PROBE = `
const dgram = require('node:dgram'); const net = require('node:net');
const udp = (type, host, port) => new Promise((r) => { let done = false; const fin = (v) => { if (!done) { done = true; try { s.close(); } catch {} r(v); } };
  const s = dgram.createSocket(type); s.on('error', (e) => fin(e.code || 'ERROR'));
  try { s.send(Buffer.from('x'), port, host, (e) => fin(e ? e.code : 'SENT')); } catch (e) { fin(e.code || 'ERROR'); } });
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); r('PENDING'); }, 400);
  s.on('connect', () => { clearTimeout(t); s.destroy(); r('CONNECTED'); }); s.on('error', (e) => { clearTimeout(t); r(e.code); }); });
(async () => {
  const out = {
    uid: process.getuid(),
    testNet: await udp('udp4', '192.0.2.1', 9),
    lanUdp: await udp('udp4', '192.168.77.50', 9),
    mdns: await udp('udp4', '224.0.0.251', 5353),
    serverUdp: await udp('udp4', '${SERVER}', 53),
    serverTcp443: await tcp('${SERVER}', 443),
    serverTcp80: await tcp('${SERVER}', 80),
    tunnel: await udp('udp4', '10.8.0.1', 9),
    broker: await tcp('127.0.0.1', 1883),
    loopOther: await tcp('127.0.0.1', 22),
    v6: await udp('udp6', '2001:db8::1', 9),
  };
  process.stdout.write(JSON.stringify(out));
})();`;

function probeAs(uid) {
  const r = spawnSync(process.execPath, ['-e', PROBE], { uid, gid: uid, encoding: 'utf8', cwd: '/', env: {} });
  if (r.status !== 0) throw new Error(`probe failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function main() {
  if (process.getuid() !== 0) { console.error('needs root in its own network namespace'); process.exit(2); }
  // Netz aufbauen: lo, Dummy-LAN 192.168.77.0/24 mit Standardroute, "Tunnel"-Route
  sh('ip', ['link', 'set', 'lo', 'up']);
  // Dummy-Schnittstelle, sonst ein veth-Paar (nicht jeder Kernel hat das dummy-Modul)
  if (!sh('ip', ['link', 'add', 'gcdummy', 'type', 'dummy'], true)) {
    sh('ip', ['link', 'add', 'gcdummy', 'type', 'veth', 'peer', 'name', 'gcpeer']);
    sh('ip', ['link', 'set', 'gcpeer', 'up']);
  }
  sh('ip', ['addr', 'add', '192.168.77.1/24', 'dev', 'gcdummy'], true);
  sh('ip', ['link', 'set', 'gcdummy', 'up']);
  sh('ip', ['route', 'add', 'default', 'via', '192.168.77.254'], true);
  // "Server" als lokale Adresse: erlaubte TCP-Verbindungen enden mit ECONNREFUSED,
  // verworfene SYNs bleiben hängen (TCP meldet DROP nicht sofort, UDP schon mit EPERM)
  sh('ip', ['addr', 'add', `${SERVER}/32`, 'dev', 'lo']);
  sh('ip', ['-6', 'addr', 'add', 'fd00:77::1/64', 'dev', 'gcdummy'], true);
  sh('ip', ['-6', 'route', 'add', 'default', 'via', 'fd00:77::fe'], true);

  const before = probeAs(UID);
  if (before.testNet !== 'SENT') throw new Error(`namespace not usable before rules: ${JSON.stringify(before)}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-fence-live-'));
  const fm = new FenceManager({ runDir: dir, logger: console });
  const st = await fm.apply({ lanCidrs: ['192.168.77.0/24'], serverAddrs: [SERVER], serverPort: 443, tunnelIp: '10.8.0.5' });
  console.log('fence', JSON.stringify(st));
  if (!st.active) throw new Error('fence not active');
  // zweites apply: idempotent, keine doppelten Sprungregeln
  await fm.apply({ lanCidrs: ['192.168.77.0/24'], serverAddrs: [SERVER], serverPort: 443, tunnelIp: '10.8.0.5' });

  const edge = probeAs(UID);
  const other = probeAs(1000);
  console.log('edge  ', JSON.stringify(edge));
  console.log('other ', JSON.stringify(other));
  // UDP: DROP → sofort EPERM; TCP: DROP → SYN geht nie raus (PENDING), erlaubt → ECONNREFUSED
  const want = {
    testNet: 'EPERM', lanUdp: 'SENT', mdns: 'SENT', serverUdp: 'EPERM', tunnel: 'EPERM',
    serverTcp443: 'ECONNREFUSED', serverTcp80: 'PENDING', broker: 'ECONNREFUSED', loopOther: 'PENDING',
  };
  const fails = [];
  for (const [k, v] of Object.entries(want)) if (edge[k] !== v) fails.push(`${k}: ${edge[k]} (erwartet ${v})`);
  if (!['EPERM', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(edge.v6)) fails.push(`v6: ${edge.v6}`);
  const free = { testNet: 'SENT', serverUdp: 'SENT', tunnel: 'SENT', serverTcp80: 'ECONNREFUSED', loopOther: 'ECONNREFUSED' };
  for (const [k, v] of Object.entries(free)) if (other[k] !== v) fails.push(`andere UID betroffen – ${k}: ${other[k]}`);
  // Edge-seitige Probe (src/edge/fence.js) muss "blocked" melden
  const fenceSrc = path.join(__dirname, '../../src/edge/fence.js');
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(fenceSrc)}).probe().then((p) => process.stdout.write(JSON.stringify(p)))`],
    { uid: UID, gid: UID, encoding: 'utf8', env: {} });
  const p = r.status === 0 ? JSON.parse(r.stdout) : null;
  if (p) console.log('probe ', JSON.stringify(p));
  else console.log('probe  (repo für UID 61001 nicht lesbar – übersprungen)');
  if (p && !p.blocked) fails.push(`fence.probe(): ${JSON.stringify(p)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (fails.length) { console.error('FEHLER:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log(`ok: Netzgrenze (${st.backend}) wirkt nur auf UID ${UID}`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
