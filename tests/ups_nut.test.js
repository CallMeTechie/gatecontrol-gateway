'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { queryUps, UpsMonitor, splitNutLine, parseList } = require('../src/ups/nut');

/** Gefälschter NUT-Server (upsd-Protokoll, nur LIST UPS / LIST VAR / LOGOUT). */
function fakeNut({ ups = { apc: { desc: 'Back-UPS 700', vars: {} } }, onCommand } = {}) {
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        seen.push(line);
        if (onCommand && onCommand(line, sock)) continue;
        if (line === 'LIST UPS') {
          sock.write('BEGIN LIST UPS\n');
          for (const [n, u] of Object.entries(ups)) sock.write(`UPS ${n} "${u.desc}"\n`);
          sock.write('END LIST UPS\n');
        } else if (line.startsWith('LIST VAR ')) {
          const n = line.slice(9);
          if (!ups[n]) { sock.write('ERR UNKNOWN-UPS\n'); continue; }
          sock.write(`BEGIN LIST VAR ${n}\n`);
          for (const [k, v] of Object.entries(ups[n].vars)) sock.write(`VAR ${n} ${k} "${v}"\n`);
          sock.write(`END LIST VAR ${n}\n`);
        } else if (line === 'LOGOUT') {
          sock.end('OK Goodbye\n');
        } else {
          sock.write('ERR UNKNOWN-COMMAND\n');
        }
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, seen, close: () => server.close() })));
}

// Der Fake lauscht auf 127.0.0.1; das Ziel muss privat (RFC 1918) sein → Verbindung umbiegen.
const via = (port) => ({ host, port: _p }) => { assert.equal(host, '192.168.1.10'); return net.createConnection({ host: '127.0.0.1', port }); };

describe('NUT protocol helpers', () => {
  it('splits quoted words with escapes', () => {
    assert.deepEqual(splitNutLine('VAR apc ups.status "OL CHRG"'), ['VAR', 'apc', 'ups.status', 'OL CHRG']);
    assert.deepEqual(splitNutLine('VAR apc device.model "Back \\"UPS\\" 700\\\\"'), ['VAR', 'apc', 'device.model', 'Back "UPS" 700\\']);
  });

  it('parseList: ERR and missing END', () => {
    assert.throws(() => parseList(['ERR ACCESS-DENIED'], 'UPS'), /nut_error:ACCESS-DENIED/);
    assert.throws(() => parseList(['BEGIN LIST UPS', 'UPS a "b"'], 'UPS'), /protocol/);
    assert.deepEqual(parseList(['BEGIN LIST UPS', 'UPS a "b"', 'END LIST UPS'], 'UPS'), [['UPS', 'a', 'b']]);
  });
});

describe('queryUps against a fake NUT server', () => {
  let nut;
  before(async () => {
    nut = await fakeNut({
      ups: {
        apc: { desc: 'APC', vars: { 'ups.status': 'OB LB', 'battery.charge': '35', 'battery.runtime': '420', 'device.model': 'Back-UPS 700', 'device.mfr': 'APC' } },
        eaton: { desc: 'Eaton', vars: { 'ups.status': 'OL', 'battery.charge': '100', 'ups.model': '5E', 'ups.mfr': 'EATON' } },
      },
    });
  });
  after(() => nut.close());

  it('without a name: first UPS from LIST UPS', async () => {
    const r = await queryUps({ host: '192.168.1.10', port: 3493, connect: via(nut.port) });
    assert.deepEqual(r, { name: 'apc', status: 'OB LB', charge: 35, runtimeSec: 420, model: 'Back-UPS 700', mfr: 'APC' });
    assert.deepEqual(nut.seen.slice(0, 2), ['LIST UPS', 'LIST VAR apc']);
  });

  it('with a name; ups.* fallbacks; missing runtime → null', async () => {
    const r = await queryUps({ host: '192.168.1.10', name: 'eaton', connect: via(nut.port) });
    assert.deepEqual(r, { name: 'eaton', status: 'OL', charge: 100, runtimeSec: null, model: '5E', mfr: 'EATON' });
  });

  it('unknown UPS → nut_error', async () => {
    await assert.rejects(queryUps({ host: '192.168.1.10', name: 'nope', connect: via(nut.port) }), { code: 'nut_error:UNKNOWN-UPS' });
  });

  it('only RFC 1918 targets (literal and resolved names)', async () => {
    await assert.rejects(queryUps({ host: '8.8.8.8' }), { code: 'not_private' });
    await assert.rejects(queryUps({ host: '127.0.0.1' }), { code: 'not_private' });
    await assert.rejects(queryUps({ host: 'nas.example', lookup: async () => ({ address: '1.2.3.4' }) }), { code: 'not_private' });
    const r = await queryUps({ host: 'nas.fritz.box', lookup: async () => ({ address: '192.168.1.10' }), connect: via(nut.port) });
    assert.equal(r.name, 'apc');
  });

  it('a home network without IPv4: a unique local IPv6 address (fc00::/7), literal or resolved', async () => {
    const seen = [];
    const v6 = (o) => { seen.push(o.host); return net.createConnection({ host: '127.0.0.1', port: nut.port }); };
    assert.equal((await queryUps({ host: 'fd12:3456:789a:1::10', connect: v6 })).name, 'apc');
    // der Name hat keinen A-Eintrag → der AAAA-Eintrag zählt
    const lookup = async (h, o) => { if (o.family === 4) throw new Error('ENOTFOUND'); return { address: 'fd00::10' }; };
    assert.equal((await queryUps({ host: 'nas.fritz.box', lookup, connect: v6 })).name, 'apc');
    assert.deepEqual(seen, ['fd12:3456:789a:1::10', 'fd00::10']);
    for (const host of ['fe80::1', '2a02:8070::5', '::1', '::ffff:192.168.1.10']) await assert.rejects(queryUps({ host }), { code: 'not_private' }, host);
    await assert.rejects(queryUps({ host: 'nas.example', lookup: async (h, o) => { if (o.family === 4) throw new Error('x'); return { address: '2a02::1' }; } }), { code: 'not_private' });
    await assert.rejects(queryUps({ host: 'nas.example', lookup: async () => { throw new Error('ENOTFOUND'); } }), { code: 'connect' });
  });
});

describe('queryUps error paths', () => {
  it('no UPS on the server', async () => {
    const nut = await fakeNut({ ups: {} });
    try {
      await assert.rejects(queryUps({ host: '192.168.1.10', connect: via(nut.port) }), { code: 'no_ups' });
    } finally { nut.close(); }
  });

  it('server silent → timeout; closed port → connect', async () => {
    const nut = await fakeNut({ onCommand: () => true });
    try {
      await assert.rejects(queryUps({ host: '192.168.1.10', timeoutMs: 200, connect: via(nut.port) }), { code: 'timeout' });
    } finally { nut.close(); }
    await assert.rejects(queryUps({ host: '192.168.1.10', connect: () => net.createConnection({ host: '127.0.0.1', port: 1 }) }), { code: 'connect' });
  });

  it('endless garbage is cut off', async () => {
    const nut = await fakeNut({ onCommand: (_l, sock) => { sock.write('x'.repeat(70 * 1024)); return true; } });
    try {
      await assert.rejects(queryUps({ host: '192.168.1.10', connect: via(nut.port) }), { code: 'protocol' });
    } finally { nut.close(); }
  });
});

describe('UpsMonitor', () => {
  it('telemetry null when off, values or error when on', async () => {
    let fail = false;
    const m = new UpsMonitor({
      query: async () => { if (fail) { const e = new (require('../src/ups/nut').NutError)('timeout'); throw e; } return { name: 'apc', status: 'OL', charge: 100, runtimeSec: 2520, model: 'Back-UPS 700', mfr: 'APC' }; },
      now: () => 7,
    });
    assert.equal(m.telemetry(), null);
    m.apply({ enabled: true, host: '192.168.1.10', port: 3493, name: null });
    m.loop.stop();
    await m.tick();
    assert.deepEqual(m.telemetry(), { name: 'apc', status: 'OL', charge: 100, runtimeSec: 2520, model: 'Back-UPS 700', mfr: 'APC', at: 7 });
    fail = true;
    await m.tick();
    assert.deepEqual(m.telemetry(), { error: 'timeout', at: 7 });
    assert.equal(m.featureTelemetry().lastError.message, 'timeout');
    m.apply({ enabled: false, host: '', port: 3493, name: null });
    assert.equal(m.telemetry(), null);
  });
});
