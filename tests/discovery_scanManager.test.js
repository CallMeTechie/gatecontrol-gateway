'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ScanManager } = require('../src/discovery/scanManager');

const cfg = { discoveryMaxPrefix: 22, discoveryTimeoutMs: 1000, discoveryConcurrency: 8 };
// gateway "owns" 192.168.1.0/24 only
const lanSubnetsFn = () => [{ iface: 'eth0', cidr: '192.168.1.0/24', primary: true }];

test('validateSubnets keeps only the gateway-owned subnets, drops foreign', () => {
  const m = new ScanManager({ config: cfg, lanSubnetsFn, runScan: async () => [], discoveryClient: { sendBatch: async () => {} } });
  assert.deepEqual(m.validateSubnets(['192.168.1.0/24', '10.0.0.0/24'], '192.168.1.1'), ['192.168.1.0/24']);
  assert.deepEqual(m.validateSubnets(['10.0.0.0/24'], '192.168.1.1'), []);
});

test('validateSubnets rejects subnets larger than the configured cap', () => {
  const m = new ScanManager({ config: { ...cfg, discoveryMaxPrefix: 24 },
    lanSubnetsFn: () => [{ iface: 'eth0', cidr: '192.168.0.0/16', primary: true }],
    runScan: async () => [], discoveryClient: { sendBatch: async () => {} } });
  assert.deepEqual(m.validateSubnets(['192.168.0.0/16'], '192.168.1.1'), []); // /16 < /24 cap → rejected
});

test('canStart is false while a scan is in flight, true after it finishes', async () => {
  let release;
  const runScan = async ({ onBatch }) => { await new Promise(r => (release = r)); onBatch([], true); return []; };
  const m = new ScanManager({ config: cfg, lanSubnetsFn, runScan, discoveryClient: { sendBatch: async () => {} } });
  assert.equal(m.canStart(), true);
  const p = m.start({ requestId: 'r1', subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'include', categories: ['web'] });
  assert.equal(m.canStart(), false);
  release(); await p;
  assert.equal(m.canStart(), true);
});

test('start streams batches to the client and always sends a terminal done', async () => {
  const sent = [];
  const runScan = async ({ onBatch }) => { onBatch([{ ip: '192.168.1.5', ports: [] }], false); onBatch([{ ip: '192.168.1.5', ports: [] }], true); return []; };
  const m = new ScanManager({ config: cfg, lanSubnetsFn, runScan, discoveryClient: { sendBatch: async (b) => sent.push(b) } });
  await m.start({ requestId: 'r9', subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'include', categories: ['web'] });
  assert.ok(sent.some(b => b.done === true && b.requestId === 'r9'));
  assert.equal(m.canStart(), true);
});

test('start resets active and sends terminal done when runScan throws', async () => {
  const sent = [];
  const runScan = async () => { throw new Error('network_error'); };
  const m = new ScanManager({ config: cfg, lanSubnetsFn, runScan,
    discoveryClient: { sendBatch: async (b) => sent.push(b) } });
  await m.start({ requestId: 'r2', subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'include', categories: ['web'] });
  assert.ok(sent.some(b => b.done === true && b.requestId === 'r2'), 'terminal done sent after error');
  assert.equal(m.canStart(), true, 'active reset after error');
});

test('ignores late batches from an orphaned scan after it is no longer active', async () => {
  const sent = [];
  let captured;
  // runScan emits one terminal batch during the scan, but also stashes onBatch so
  // the test can simulate the orphan firing AGAIN after start() has reset active.
  const runScan = async ({ onBatch }) => { captured = onBatch; onBatch([{ ip: '192.168.1.5', ports: [] }], true); };
  const m = new ScanManager({ config: cfg, lanSubnetsFn, runScan,
    discoveryClient: { sendBatch: async (b) => sent.push(b) } });
  await m.start({ requestId: 'r1', subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'include', categories: ['web'] });
  const countDuringScan = sent.length;            // batches sent while the scan was active
  assert.ok(sent.some(b => b.done === true), 'terminal done was sent during the scan');
  await captured([{ ip: '192.168.1.9', ports: [] }], true); // orphan fires AFTER start() reset active
  assert.equal(sent.length, countDuringScan, 'a late batch after the scan ended must be ignored');
});
