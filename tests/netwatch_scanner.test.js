'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const w = require('../src/netwatch/dnsWire');
const { createScanner, parseIpNeighJson, cleanHostname } = require('../src/netwatch/scanner');

function ptrReply(query, target) {
  // Antwort = Anfrage mit QR-Bit + eine PTR-Antwort auf den Fragenamen (Zeiger 0xc00c)
  const out = Buffer.from(query);
  out.writeUInt16BE(0x8400, 2);
  out.writeUInt16BE(1, 6);
  const tgt = w.encodeName(target);
  return Buffer.concat([out, Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 10, 0, tgt.length]), tgt]);
}

/** Gefälschter UDP-Socket: antwortet je nach `responder(ip, port, msg)`. */
function fakeSocketFactory(responder, log = []) {
  return () => {
    const s = new EventEmitter();
    s.bind = (_p, _a, cb) => setImmediate(cb);
    s.send = (msg, port, ip) => {
      log.push({ ip, port });
      const reply = responder(ip, port, msg);
      if (reply) process.nextTick(() => s.emit('message', reply, { address: ip, port }));
    };
    s.close = () => {};
    return s;
  };
}

const neighJson = (entries) => JSON.stringify(entries.map(([dst, lladdr, state]) => ({ dst, dev: 'eth0', ...(lladdr ? { lladdr } : {}), state: [state] })));

describe('parseIpNeighJson / cleanHostname', () => {
  it('parses ip -j neigh output', () => {
    const r = parseIpNeighJson(neighJson([['192.168.1.1', 'AA:BB:CC:00:00:01', 'REACHABLE'], ['192.168.1.9', null, 'FAILED']]));
    assert.deepEqual(r, [
      { ip: '192.168.1.1', mac: 'aa:bb:cc:00:00:01', state: 'REACHABLE', dev: 'eth0' },
      { ip: '192.168.1.9', mac: null, state: 'FAILED', dev: 'eth0' },
    ]);
    assert.equal(parseIpNeighJson('not json'), null);
    assert.deepEqual(parseIpNeighJson('\n'), []);
    assert.deepEqual(parseIpNeighJson('[{"dst":"fe80::1"}]'), []);
  });

  it('cleans host names', () => {
    assert.equal(cleanHostname('Marcs-iPhone.local.'), 'Marcs-iPhone');
    assert.equal(cleanHostname('android-1234.fritz.box'), 'android-1234');
    assert.equal(cleanHostname('192.168.1.5'), null);
    assert.equal(cleanHostname('<script>x'), 'scriptx');
    assert.equal(cleanHostname(''), null);
    assert.equal(cleanHostname(null), null);
    assert.equal(cleanHostname('a'.repeat(100)).length, 63);
  });
});

describe('scanner', () => {
  it('probe: REACHABLE after the poke = online, mDNS reply gives the name', async () => {
    const log = [];
    const sc = createScanner({
      exec: async () => neighJson([
        ['192.168.1.10', '00:11:32:aa:bb:01', 'REACHABLE'],
        ['192.168.1.11', '24:0a:c4:9f:12:aa', 'STALE'],
        ['192.168.1.12', '02:00:00:00:00:12', 'PROBE'],
        ['192.168.1.99', 'aa:aa:aa:aa:aa:aa', 'REACHABLE'], // nicht angefragt
      ]),
      createSocket: fakeSocketFactory((ip, port, msg) => (ip === '192.168.1.11' && port === 5353 ? ptrReply(msg, 'esp32-9f12aa.local') : null), log),
      sleep: () => new Promise((r) => setImmediate(r)),
    });
    const r = await sc.probe(['192.168.1.10', '192.168.1.11', '192.168.1.12']);
    assert.deepEqual([...r.online.entries()].sort(), [['192.168.1.10', '00:11:32:aa:bb:01'], ['192.168.1.11', '24:0a:c4:9f:12:aa']]);
    assert.equal(r.names.get('192.168.1.11'), 'esp32-9f12aa');
    assert.deepEqual(log.map((x) => x.port), [5353, 5353, 5353]);
    assert.equal(sc.mode(), 'ip');
  });

  it('ignores replies from addresses that were not asked or wrong ports', async () => {
    const sc = createScanner({
      exec: async () => neighJson([]),
      createSocket: () => {
        const s = new EventEmitter();
        s.bind = (_p, _a, cb) => setImmediate(cb);
        s.send = () => { process.nextTick(() => s.emit('message', Buffer.alloc(20), { address: '192.168.1.200', port: 5353 })); };
        s.close = () => {};
        return s;
      },
      sleep: () => new Promise((r) => setImmediate(r)),
    });
    const r = await sc.probe(['192.168.1.10']);
    assert.equal(r.responders.size, 0);
  });

  it('sweep in chunks, falls back to /proc/net/arp without ip', async () => {
    const sent = [];
    const sc = createScanner({
      exec: async () => { throw Object.assign(new Error('spawn ip ENOENT'), { code: 'ENOENT' }); },
      readArpFile: () => 'IP address HW type Flags HW address Mask Device\n'
        + '192.168.1.2 0x1 0x2 aa:bb:cc:dd:ee:02 * eth0\n192.168.1.3 0x1 0x0 00:00:00:00:00:00 * eth0\n',
      createSocket: fakeSocketFactory(() => null, sent),
      sleep: () => Promise.resolve(),
      chunk: 2,
    });
    const r = await sc.sweep(['192.168.1.2', '192.168.1.3', '192.168.1.4']);
    assert.deepEqual([...r.online.entries()], [['192.168.1.2', 'aa:bb:cc:dd:ee:02']]);
    assert.equal(sent.length, 3);
    assert.equal(sc.mode(), 'proc');
  });

  it('netbiosNames maps NBSTAT replies', async () => {
    const reply = (q) => {
      const head = Buffer.from(q.subarray(0, 12));
      head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(0, 4); head.writeUInt16BE(1, 6);
      const e = Buffer.alloc(18, 0x20); e.write('DRUCKER', 0, 'latin1'); e[15] = 0; e.writeUInt16BE(0x0400, 16);
      const table = Buffer.concat([Buffer.from([1]), e]);
      return Buffer.concat([head, q.subarray(12, 46), Buffer.from([0, 0x21, 0, 1, 0, 0, 0, 0, 0, table.length]), table]);
    };
    const sc = createScanner({
      createSocket: fakeSocketFactory((ip, port, msg) => (port === 137 && ip === '192.168.1.40' ? reply(msg) : null)),
      sleep: () => new Promise((r) => setImmediate(r)),
    });
    const m = await sc.netbiosNames(['192.168.1.40', '192.168.1.41']);
    assert.deepEqual([...m.entries()], [['192.168.1.40', 'DRUCKER']]);
  });

  it('serialises concurrent operations', async () => {
    let active = 0;
    let maxActive = 0;
    const sc = createScanner({
      exec: async () => '[]',
      createSocket: fakeSocketFactory(() => null),
      sleep: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); active--; },
    });
    await Promise.all([sc.probe(['10.0.0.1']), sc.sweep(['10.0.0.2']), sc.probe(['10.0.0.3'])]);
    assert.equal(maxActive, 1);
  });
});
