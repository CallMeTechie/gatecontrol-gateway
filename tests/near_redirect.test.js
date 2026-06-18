'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRedirectRuleArgs, buildAliasArgs } = require('../src/near/redirect');

describe('redirect builders', () => {
  it('builds the PREROUTING REDIRECT rule argv', () => {
    assert.deepEqual(
      buildRedirectRuleArgs('192.168.2.250', 445, 14450),
      ['-t','nat','PREROUTING','-d','192.168.2.250','-p','tcp','--dport','445','-j','REDIRECT','--to-ports','14450'],
    );
  });
  it('rejects bad input', () => {
    assert.throws(() => buildRedirectRuleArgs('nope', 445, 14450));
    assert.throws(() => buildRedirectRuleArgs('192.168.2.250', 70000, 14450));
  });
  it('builds the ip addr alias argv', () => {
    assert.deepEqual(
      buildAliasArgs('192.168.2.250', 24, 'eth0'),
      ['192.168.2.250/24','dev','eth0'],
    );
  });
});
