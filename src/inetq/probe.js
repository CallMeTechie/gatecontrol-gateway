'use strict';

// Messungen der Internetqualität: ICMP-Ping über das `ping`-Programm des
// Images (iputils; der Container hat NET_RAW), Rückfall auf TCP-Connect,
// wenn `ping` fehlt oder nicht darf. Eine TCP-Ablehnung (RST) zählt als
// erreichbar – das Gegenüber hat geantwortet.

const net = require('node:net');
const { execFile } = require('node:child_process');

/** Ausgabe von iputils- oder busybox-ping → { sent, received, rttMs } oder null. */
function parsePingOutput(text) {
  const s = String(text || '');
  const m = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(s);
  if (!m) return null;
  const r = /(?:rtt|round-trip) min\/avg\/max(?:\/(?:mdev|stddev))? = ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(s);
  return { sent: Number(m[1]), received: Number(m[2]), rttMs: r ? Number(r[2]) : null };
}

function execPing(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Eine TCP-Verbindung → RTT in ms oder null. */
function tcpRtt(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.once('connect', () => finish(ms()));
    sock.once('error', (err) => finish(err && err.code === 'ECONNREFUSED' ? ms() : null));
    sock.once('timeout', () => finish(null));
  });
}

const mean = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);

/**
 * Pinger mit festem Modus: 'icmp' bis `ping` einmal nicht nutzbar war,
 * danach 'tcp'. `exec`/`tcp` sind für Tests austauschbar.
 */
function createPinger({ exec = execPing, tcp = tcpRtt, tcpPorts = [53, 443, 80] } = {}) {
  let mode = 'icmp';

  async function viaTcp(host, count) {
    let received = 0;
    const rtts = [];
    for (let i = 0; i < count; i++) {
      let rtt = null;
      for (const p of tcpPorts) { rtt = await tcp(host, p, 1500); if (rtt !== null) break; }
      if (rtt !== null) { received++; rtts.push(rtt); }
    }
    return { sent: count, received, rttMs: mean(rtts) };
  }

  /** → { sent, received, rttMs } */
  async function ping(host, count = 3) {
    if (!net.isIPv4(host)) return { sent: count, received: 0, rttMs: null };
    if (mode === 'icmp') {
      const deadline = Math.ceil(count * 0.2) + 2;
      const r = await exec(['-n', '-q', '-c', String(count), '-i', '0.2', '-W', '1', '-w', String(deadline), host], (deadline + 2) * 1000);
      const parsed = parsePingOutput(r.stdout);
      if (parsed) return parsed;
      // kein Programm / keine Berechtigung → dauerhaft TCP
      if (r.code === 'ENOENT' || /not permitted|permission|socket/i.test(r.stderr)) mode = 'tcp';
      else return { sent: count, received: 0, rttMs: null };
    }
    return viaTcp(host, count);
  }

  return { ping, mode: () => mode };
}

/**
 * Eine Messung: Router, öffentliche Ziele, Server (TCP-Connect).
 * → { at, routerOk, rttRouterMs, inetOk, rttInetMs, sent, received, rttServerMs }
 */
async function measure({ pinger, routerIp, targets, server, tcp = tcpRtt, now = Date.now }) {
  const at = now();
  const [router, srv, ...pubs] = await Promise.all([
    routerIp ? pinger.ping(routerIp, 3) : Promise.resolve(null),
    server && server.host ? tcp(server.host, server.port, 3000) : Promise.resolve(null),
    ...targets.map((t) => pinger.ping(t, 5)),
  ]);
  const sent = pubs.reduce((a, p) => a + p.sent, 0);
  const received = pubs.reduce((a, p) => a + p.received, 0);
  return {
    at,
    routerOk: router ? router.received > 0 : null,
    rttRouterMs: router && router.received > 0 ? router.rttMs : null,
    inetOk: received > 0,
    rttInetMs: mean(pubs.filter((p) => p.received > 0 && p.rttMs !== null).map((p) => p.rttMs)),
    sent,
    received,
    rttServerMs: srv,
  };
}

module.exports = { parsePingOutput, tcpRtt, createPinger, measure, mean };
