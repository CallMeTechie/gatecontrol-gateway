'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ipInAllowlist } = require('../src/proxy/egress');

describe('ipInAllowlist (source-lock matcher)', () => {
  it('matches an exact /32', () => {
    assert.equal(ipInAllowlist('192.168.2.45', ['192.168.2.45/32']), true);
  });
  it('treats a bare IP as /32', () => {
    assert.equal(ipInAllowlist('10.0.0.5', ['10.0.0.5']), true);
  });
  it('matches inside a /24', () => {
    assert.equal(ipInAllowlist('192.168.2.45', ['192.168.2.0/24']), true);
  });
  it('rejects outside the /24', () => {
    assert.equal(ipInAllowlist('192.168.3.9', ['192.168.2.0/24']), false);
  });
  it('default-denies an empty allowlist', () => {
    assert.equal(ipInAllowlist('192.168.2.45', []), false);
  });
  it('default-denies a missing allowlist', () => {
    assert.equal(ipInAllowlist('192.168.2.45', undefined), false);
  });
  it('normalises IPv4-mapped IPv6', () => {
    assert.equal(ipInAllowlist('::ffff:127.0.0.1', ['127.0.0.1/32']), true);
  });
  it('rejects garbage input', () => {
    assert.equal(ipInAllowlist('not-an-ip', ['192.168.2.0/24']), false);
    assert.equal(ipInAllowlist('192.168.2.45', ['garbage/33']), false);
  });
});
