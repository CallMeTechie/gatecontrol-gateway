'use strict';

const net = require('node:net');

function _ipToInt(ip) {
  return ip.split('.').reduce((a, o) => ((a << 8) + (Number(o) & 255)) >>> 0, 0);
}
function _intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// Usable host IPs in an IPv4 CIDR, excluding network and broadcast addresses.
function hostsInSubnet(cidr) {
  const [network, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const base = _ipToInt(network) >>> 0;
  const count = 2 ** (32 - prefix);
  const out = [];
  for (let i = 1; i < count - 1; i++) out.push(_intToIp((base + i) >>> 0));
  return out;
}

// Bounded TCP connect probe. Resolves true if the port accepts, false otherwise
// (closed/filtered/timeout). Never rejects. Mirrors src/health/selfCheck.js.
function probePort(host, port, timeoutMs = 400) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

// Bounded-concurrency map over (host × port). `probeFn` is injectable for tests.
async function sweep({ subnetCidr, ports, concurrency = 128, timeoutMs = 400, jitterMs = 5, probeFn = probePort }) {
  const hosts = hostsInSubnet(subnetCidr);
  const jobs = [];
  for (const ip of hosts) for (const port of ports) jobs.push({ ip, port });
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const { ip, port } = jobs[idx++];
      if (jitterMs) await new Promise(r => setTimeout(r, Math.random() * jitterMs));
      if (await probeFn(ip, port, timeoutMs)) results.push({ ip, port });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, worker));
  return results;
}

// Parse /proc/net/arp → Map(ip → mac). Only entries with the ATF_COM (0x2) flag
// set are complete/resolved; skip 0x0 (incomplete) and the header line.
function parseArp(content) {
  const map = new Map();
  for (const line of content.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [ip, , flags, mac] = cols;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    if ((parseInt(flags, 16) & 0x2) === 0) continue;
    if (mac === '00:00:00:00:00:00') continue;
    map.set(ip, mac.toLowerCase());
  }
  return map;
}

module.exports = { hostsInSubnet, probePort, sweep, parseArp };
