'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildRedirectRuleArgs, buildAliasArgs } = require('../src/near/redirect');

describe('redirect builders', () => {
  it('builds the PREROUTING REDIRECT rule argv (-A, table before verb)', () => {
    assert.deepEqual(
      buildRedirectRuleArgs('-A', '192.168.2.250', 445, 14450),
      ['-t','nat','-A','PREROUTING','-d','192.168.2.250','-p','tcp','--dport','445','-j','REDIRECT','--to-ports','14450'],
    );
  });
  it('builds the PREROUTING REDIRECT rule argv (-C, table before verb)', () => {
    assert.deepEqual(
      buildRedirectRuleArgs('-C', '192.168.2.250', 445, 14450),
      ['-t','nat','-C','PREROUTING','-d','192.168.2.250','-p','tcp','--dport','445','-j','REDIRECT','--to-ports','14450'],
    );
  });
  it('builds the PREROUTING REDIRECT rule argv (-D, table before verb)', () => {
    assert.deepEqual(
      buildRedirectRuleArgs('-D', '192.168.2.250', 445, 14450),
      ['-t','nat','-D','PREROUTING','-d','192.168.2.250','-p','tcp','--dport','445','-j','REDIRECT','--to-ports','14450'],
    );
  });
  it('rejects bad input', () => {
    assert.throws(() => buildRedirectRuleArgs('-A', 'nope', 445, 14450));
    assert.throws(() => buildRedirectRuleArgs('-A', '192.168.2.250', 70000, 14450));
  });
  it('builds the ip addr alias argv', () => {
    assert.deepEqual(
      buildAliasArgs('192.168.2.250', 24, 'eth0'),
      ['192.168.2.250/24','dev','eth0'],
    );
  });
});
