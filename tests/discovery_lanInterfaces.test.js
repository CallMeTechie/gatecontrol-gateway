'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lanSubnets, netmaskToPrefix, networkAddress, ipInCidr, isPhysicalLan } =
  require('../src/discovery/lanInterfaces');

const FAKE = {
  lo:           [{ address: '127.0.0.1',   netmask: '255.0.0.0',     family: 'IPv4', internal: true }],
  eth0:         [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  gatecontrol0: [{ address: '10.8.0.79',    netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  wg0:          [{ address: '10.9.0.2',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  docker0:      [{ address: '172.17.0.1',   netmask: '255.255.0.0',   family: 'IPv4', internal: false }],
};

test('helpers compute prefix / network / membership', () => {
  assert.equal(netmaskToPrefix('255.255.255.0'), 24);
  assert.equal(netmaskToPrefix('255.255.0.0'), 16);
  assert.equal(netmaskToPrefix('255.255.255.128'), 25);
  assert.equal(networkAddress('192.168.1.50', '255.255.255.0'), '192.168.1.0');
  assert.equal(ipInCidr('192.168.1.1', '192.168.1.0', 24), true);
  assert.equal(ipInCidr('192.168.2.1', '192.168.1.0', 24), false);
  assert.equal(ipInCidr('10.0.0.255', '10.0.0.0', 24), true);
});

test('isPhysicalLan excludes loopback / WG (gatecontrol0 + wg*) / docker / VPN', () => {
  assert.equal(isPhysicalLan('eth0'), true);
  assert.equal(isPhysicalLan('ens18'), true);
  assert.equal(isPhysicalLan('lo'), false);
  assert.equal(isPhysicalLan('gatecontrol0'), false);
  assert.equal(isPhysicalLan('wg0'), false);      // generic WireGuard
  assert.equal(isPhysicalLan('docker0'), false);
  assert.equal(isPhysicalLan('tailscale0'), false);
});

test('lanSubnets returns only physical LAN subnets, marks default-route subnet primary', () => {
  const subs = lanSubnets('192.168.1.1', FAKE);
  assert.deepEqual(subs, [{ iface: 'eth0', cidr: '192.168.1.0/24', primary: true }]);
});

test('lanSubnets marks the subnet containing the default gw as primary (non-first)', () => {
  const two = {
    eth0: [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    eth1: [{ address: '10.0.0.5',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  const subs = lanSubnets('10.0.0.1', two); // gw lives in eth1's subnet
  assert.equal(subs.filter(s => s.primary).length, 1);
  assert.equal(subs.find(s => s.cidr === '10.0.0.0/24').primary, true);
  assert.equal(subs.find(s => s.cidr === '192.168.1.0/24').primary, false);
});

test('lanSubnets: deterministic fallback to first when no gw match, exactly one primary', () => {
  const two = {
    eth0: [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    eth1: [{ address: '10.0.0.5',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  const subs = lanSubnets(null, two); // no default gw → fall back to first
  assert.equal(subs.filter(s => s.primary).length, 1);
  assert.equal(subs[0].primary, true);
});

test('lanSubnets dedups same subnet and skips /32 host routes', () => {
  const ifaces = {
    eth0: [
      { address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false },
      { address: '192.168.1.51', netmask: '255.255.255.0', family: 'IPv4', internal: false }, // same /24 → dedup
    ],
    ens18: [{ address: '54.36.233.20', netmask: '255.255.255.255', family: 'IPv4', internal: false }], // /32 → skipped
  };
  const subs = lanSubnets('192.168.1.1', ifaces);
  assert.deepEqual(subs, [{ iface: 'eth0', cidr: '192.168.1.0/24', primary: true }]);
});
