'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isUlaIpv6, lanSubnets6, primaryLanIp6, primaryLanIp, lanSubnets } = require('../src/discovery/lanInterfaces');

const v6 = (address, bits, extra = {}) => ({ address, family: 'IPv6', internal: false, cidr: `${address}/${bits}`, scopeid: 0, ...extra });

// Heimnetz ohne IPv4: ULA vom Router, dazu Link-Local und eine globale Adresse
const V6_ONLY = {
  lo: [{ address: '::1', family: 'IPv6', internal: true, cidr: '::1/128' }],
  eth0: [v6('2a02:8070:1234:5600::5', 64), v6('FD12:3456:789A:1:0:0:0:5', 64), v6('fe80::be24:11ff:fe00:1', 64, { scopeid: 2 })],
  gatecontrol0: [v6('fd00:8::9', 64)],
  docker0: [v6('fd00:d0c::1', 64)],
};

test('isUlaIpv6: fc00::/7 only — never link-local, global, loopback, zone or IPv4-mapped', () => {
  for (const ip of ['fd00::1', 'fc00::1', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'FD12:3456:789a:1::5']) assert.equal(isUlaIpv6(ip), true, ip);
  for (const ip of ['fe80::1', 'fe00::1', '2a02:8070::5', '::1', '::', 'fd00::1%eth0', '::ffff:10.0.0.1', 'fd00::10.0.0.1', '192.168.1.5', 'fd00', '', null, undefined, 5]) {
    assert.equal(isUlaIpv6(ip), false, String(ip));
  }
});

test('lan_ip6 / lan_subnets6: the ULA of the physical LAN, not tunnel, bridge, link-local or global', () => {
  assert.equal(primaryLanIp6(V6_ONLY), 'fd12:3456:789a:1::5');
  assert.deepEqual(lanSubnets6(V6_ONLY), [{ iface: 'eth0', cidr: 'fd12:3456:789a:1::/64' }]);
  // ohne IPv4 bleiben die IPv4-Felder leer – wie bisher
  assert.equal(primaryLanIp(null, V6_ONLY), null);
  assert.deepEqual(lanSubnets(null, V6_ONLY), []);
});

test('lan_subnets6: one entry per subnet, the prefix masked, at most 8', () => {
  const ifaces = {
    eth0: [v6('fd12:3456:789a:1::5', 64), v6('fd12:3456:789a:1::6', 64), v6('fdab:0:0:ff01::1', 56)],
    wlan0: [v6('fd12:3456:789a:1::77', 64), v6('fd00::1:0:0:1', 48)],
  };
  assert.deepEqual(lanSubnets6(ifaces), [
    { iface: 'eth0', cidr: 'fd12:3456:789a:1::/64' },
    { iface: 'eth0', cidr: 'fdab:0:0:ff00::/56' },
    { iface: 'wlan0', cidr: 'fd00::/48' },
  ]);
  const many = { eth0: Array.from({ length: 12 }, (_, i) => v6(`fd00:0:0:${i + 1}::1`, 64)) };
  assert.equal(lanSubnets6(many).length, 8);
});

test('lan_subnets6: prefixes wider than a ULA site (/48) and host routes are skipped; odd entries never throw', () => {
  const ifaces = {
    eth0: [v6('fd00::1', 7), v6('fd00::2', 47), v6('fd00::3', 128), { address: 'fd00::4', family: 'IPv6', internal: false }, null,
      { address: 'fd00::5', family: 'IPv6', internal: false, cidr: 'fd00::5/xx' }, v6('fd00:1:2:3::9', 64, { family: 6 })],
    eth1: null,
  };
  assert.deepEqual(lanSubnets6(ifaces), [{ iface: 'eth0', cidr: 'fd00:1:2:3::/64' }]);
  assert.equal(primaryLanIp6(ifaces), 'fd00:1:2:3::9');
  assert.deepEqual(lanSubnets6({}), []);
  assert.equal(primaryLanIp6({}), null);
});

test('a dual-stack LAN reports both families', () => {
  const dual = { eth0: [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }, v6('fd00:1::5', 64)] };
  assert.equal(primaryLanIp('192.168.1.1', dual), '192.168.1.5');
  assert.equal(primaryLanIp6(dual), 'fd00:1::5');
  assert.deepEqual(lanSubnets6(dual), [{ iface: 'eth0', cidr: 'fd00:1::/64' }]);
});
