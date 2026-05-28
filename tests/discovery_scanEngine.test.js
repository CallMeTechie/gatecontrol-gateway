'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScan, localIpForSubnet } = require('../src/discovery/scanEngine');

test('localIpForSubnet picks the local IPv4 inside the subnet (multicast binds to LAN, not wg0)', () => {
  const ifaces = {
    eth0: [{ address: '192.168.1.7', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    wg0:  [{ address: '10.8.0.2',    netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  assert.equal(localIpForSubnet('192.168.1.0/24', ifaces), '192.168.1.7');
  assert.equal(localIpForSubnet('172.16.0.0/24', ifaces), null);
});

function fakeSources({ mdns = [], ssdp = [], sweep = [] }) {
  return {
    discoverMdns: async () => mdns,
    discoverSsdp: async () => ssdp,
    sweep: async () => sweep,
  };
}

test('merges sources by IP, tags ports with source, dedupes, includes uncategorised passive', async () => {
  const batches = [];
  const sources = fakeSources({
    mdns: [{ ip: '192.168.1.20', host: 'nas.local', port: 5000, mdnsType: '_http._tcp' }],
    ssdp: [{ host: '192.168.1.20', port: 8200, st: 'MediaServer', server: 'MiniDLNA' }],
    sweep: [{ ip: '192.168.1.20', port: 80 }, { ip: '192.168.1.30', port: 22 }],
  });
  const devices = await runScan({
    subnets: ['192.168.1.0/24'], activeScan: true, categoryMode: 'include',
    categories: ['web', 'media', 'remote_access'], config: { discoveryConcurrency: 8, discoveryTimeoutMs: 1000 },
    sources, arpReader: () => new Map([['192.168.1.20', 'aa:bb:cc:dd:ee:ff']]),
    onBatch: (devs, done) => batches.push({ n: devs.length, done }),
  });
  const nas = devices.find(d => d.ip === '192.168.1.20');
  assert.equal(nas.hostname, 'nas.local');
  assert.equal(nas.mac, 'aa:bb:cc:dd:ee:ff');
  assert.deepEqual(nas.ports.map(p => p.port).sort((a, b) => a - b), [80, 5000, 8200]);
  assert.ok(devices.find(d => d.ip === '192.168.1.30')); // sweep-only host
  assert.ok(batches.some(b => b.done === true));         // a terminal batch was emitted
});

test('active_scan=false skips the sweep source', async () => {
  let swept = false;
  const sources = { discoverMdns: async () => [], discoverSsdp: async () => [], sweep: async () => { swept = true; return []; } };
  await runScan({ subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'include', categories: ['web'],
    config: { discoveryConcurrency: 8, discoveryTimeoutMs: 1000 }, sources, arpReader: () => new Map(), onBatch: () => {} });
  assert.equal(swept, false);
});

test('excluded-category passive hit is filtered out', async () => {
  const sources = fakeSources({ ssdp: [{ host: '192.168.1.40', port: 49153, st: 'x', server: 'WeMo/1' }] });
  const devices = await runScan({ subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'exclude',
    categories: ['iot'], config: { discoveryConcurrency: 8, discoveryTimeoutMs: 1000 }, sources, arpReader: () => new Map(), onBatch: () => {} });
  assert.equal(devices.find(d => d.ip === '192.168.1.40'), undefined); // WeMo→iot excluded
});
