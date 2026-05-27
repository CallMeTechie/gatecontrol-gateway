'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSsdpResponse, locationHostPort } = require('../src/discovery/ssdp');

test('parseSsdpResponse extracts LOCATION/ST/SERVER (case-insensitive headers)', () => {
  const raw = [
    'HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=1800',
    'LOCATION: http://192.168.1.10:8200/rootDesc.xml',
    'ST: urn:schemas-upnp-org:device:MediaServer:1',
    'Server: Linux/3 UPnP/1.0 MiniDLNA/1.2', '', '',
  ].join('\r\n');
  const r = parseSsdpResponse(raw);
  assert.equal(r.location, 'http://192.168.1.10:8200/rootDesc.xml');
  assert.equal(r.st, 'urn:schemas-upnp-org:device:MediaServer:1');
  assert.equal(r.server, 'Linux/3 UPnP/1.0 MiniDLNA/1.2');
});

test('locationHostPort parses host:port without fetching', () => {
  assert.deepEqual(locationHostPort('http://192.168.1.10:8200/x.xml'), { host: '192.168.1.10', port: 8200 });
  assert.deepEqual(locationHostPort('https://192.168.1.20/desc'), { host: '192.168.1.20', port: 443 });
  assert.equal(locationHostPort('not a url'), null);
});
