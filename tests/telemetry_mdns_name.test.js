'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { MdnsNameProbe, mdnsNameOf, ownLanAddresses } = require('../src/health/mdnsName');

/** multicast-dns-Ersatz: merkt Fragen, beantwortet sie mit `answer(question)`. */
function fakeMdns(answer) {
  const made = [];
  const factory = (opts) => {
    const m = new EventEmitter();
    m.opts = opts;
    m.destroyed = false;
    m.destroy = () => { m.destroyed = true; };
    m.query = (q) => {
      m.asked = q.questions;
      const packet = answer ? answer(q.questions) : null;
      if (packet) process.nextTick(() => { if (!m.destroyed) m.emit('response', packet); });
    };
    made.push(m);
    return m;
  };
  return { factory, made };
}

function setup({ hostname = 'Pi-Keller', answer, iface = '192.168.1.5', own = ['192.168.1.5', 'fd00::5'] } = {}) {
  let t = 1_000_000;
  const net = fakeMdns(answer);
  const probe = new MdnsNameProbe({
    hostname: () => hostname, addresses: () => new Set(own), getInterface: () => iface, factory: net.factory, now: () => t,
    everyMs: 600_000, timeoutMs: 30, keepMs: 1_800_000,
  });
  return { probe, made: net.made, advance: (ms) => { t += ms; } };
}

const A = (name, ip) => ({ answers: [{ name, type: 'A', data: ip }], additionals: [] });
const tick = () => new Promise((r) => setImmediate(r));

describe('mDNS name of the gateway (telemetry.mdns_name)', () => {
  // der Zeitgeber der Abfrage hält den Prozess nicht am Leben (unref) – im Test tut es dieser
  let keep;
  before(() => { keep = setInterval(() => {}, 1000); });
  after(() => clearInterval(keep));

  it('mdnsNameOf: first label, lower case; nothing for an odd host name', () => {
    assert.equal(mdnsNameOf('Pi-Keller'), 'pi-keller.local');
    assert.equal(mdnsNameOf('nas.fritz.box'), 'nas.local');
    assert.equal(mdnsNameOf('localhost'), null);
    assert.equal(mdnsNameOf('bad_name'), null);
    assert.equal(mdnsNameOf('-x'), null);
    assert.equal(mdnsNameOf(''), null);
    assert.equal(mdnsNameOf(undefined), null);
  });

  it('ownLanAddresses: LAN interfaces only, without zone', () => {
    const own = ownLanAddresses({
      lo: [{ address: '127.0.0.1', internal: true }],
      eth0: [{ address: '192.168.1.5', internal: false }, { address: 'FE80::1%eth0', internal: false }],
      gatecontrol0: [{ address: '10.8.0.9', internal: false }],
      docker0: [{ address: '172.17.0.1', internal: false }],
    });
    assert.deepEqual([...own].sort(), ['192.168.1.5', 'fe80::1']);
  });

  it('reported once the name answers with an own LAN address', async () => {
    const { probe, made } = setup({ answer: () => A('Pi-Keller.local', '192.168.1.5') });
    assert.equal(probe.current(), null, 'nothing before the first answer');
    assert.deepEqual(made[0].asked, [{ name: 'pi-keller.local', type: 'A' }, { name: 'pi-keller.local', type: 'AAAA' }]);
    assert.deepEqual(made[0].opts, { multicast: true, reuseAddr: true, loopback: true, bind: '0.0.0.0', interface: '192.168.1.5' });
    await tick();
    assert.equal(probe.current(), 'pi-keller.local');
    assert.equal(made.length, 1, 'no second probe before the interval is over');
    assert.equal(made[0].destroyed, true);
  });

  it('an IPv6 answer (AAAA) counts as well', async () => {
    const { probe } = setup({ answer: () => ({ answers: [], additionals: [{ name: 'pi-keller.local', type: 'AAAA', data: 'FD00::5' }] }) });
    assert.equal(await probe.probe(), 'pi-keller.local');
  });

  it('not reported: no answer, a foreign address, another name', async () => {
    assert.equal(await setup({}).probe.probe(), null);
    assert.equal(await setup({ answer: () => A('pi-keller.local', '192.168.1.77') }).probe.probe(), null);
    assert.equal(await setup({ answer: () => A('other.local', '192.168.1.5') }).probe.probe(), null);
    const s = setup({ answer: () => A('pi-keller.local', '192.168.1.5'), iface: null });
    assert.equal(await s.probe.probe(), null);
    assert.equal(s.made.length, 0, 'no socket without a LAN interface');
    assert.equal(setup({ hostname: 'bad_name' }).probe.current(), null);
  });

  it('the name is dropped when it stops answering', async () => {
    let on = true;
    const { probe, made, advance } = setup({ answer: () => (on ? A('pi-keller.local', '192.168.1.5') : null) });
    probe.current();
    await tick();
    assert.equal(probe.current(), 'pi-keller.local');
    on = false;
    advance(600_001);
    assert.equal(probe.current(), 'pi-keller.local', 'still inside the keep time');
    assert.equal(made.length, 2, 'asked again after the interval');
    while (probe.probing) await new Promise((r) => setTimeout(r, 10)); // die zweite Abfrage bleibt ohne Antwort
    advance(1_200_000);
    assert.equal(probe.current(), null);
  });

  it('a failing mDNS socket never throws', async () => {
    const probe = new MdnsNameProbe({ hostname: () => 'gw', getInterface: () => '192.168.1.5', factory: () => { throw new Error('EADDRINUSE'); }, timeoutMs: 20 });
    assert.equal(await probe.probe(), null);
    assert.equal(probe.current(), null);
  });
});
