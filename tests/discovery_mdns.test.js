'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapMdnsResponse } = require('../src/discovery/mdns');

test('mapMdnsResponse builds service records from PTR/SRV/A/TXT answers', () => {
  const packet = {
    answers: [
      { type: 'PTR', name: '_http._tcp.local', data: 'nas._http._tcp.local' },
      { type: 'SRV', name: 'nas._http._tcp.local', data: { port: 5000, target: 'nas.local' } },
      { type: 'A', name: 'nas.local', data: '192.168.1.20' },
    ],
    additionals: [],
  };
  const recs = mapMdnsResponse(packet);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], { ip: '192.168.1.20', host: 'nas.local', port: 5000, mdnsType: '_http._tcp' });
});

test('mapMdnsResponse skips records without a resolvable A address', () => {
  const recs = mapMdnsResponse({ answers: [{ type: 'PTR', name: '_x._tcp.local', data: 'y._x._tcp.local' }], additionals: [] });
  assert.deepEqual(recs, []);
});

test('mapMdnsResponse matches the A record regardless of case (SRV target lower, A upper case)', () => {
  const recs = mapMdnsResponse({
    answers: [{ type: 'SRV', name: 'p._ipp._tcp.local', data: { port: 631, target: 'hp5a3b2c.local' } }],
    additionals: [{ type: 'A', name: 'HP5A3B2C.local', data: '192.168.1.57' }],
  });
  assert.deepEqual(recs, [{ ip: '192.168.1.57', host: 'hp5a3b2c.local', port: 631, mdnsType: '_ipp._tcp' }]);
});
