'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('smoke', () => {
  it('node test runner works', () => {
    assert.equal(1 + 1, 2);
  });
});
