'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../src/logger');

describe('logger', () => {
  it('exposes pino log levels', () => {
    assert.ok(typeof logger.info === 'function');
    assert.ok(typeof logger.warn === 'function');
    assert.ok(typeof logger.error === 'function');
    assert.ok(typeof logger.debug === 'function');
  });

  it('has a child() for sub-loggers', () => {
    const child = logger.child({ module: 'test' });
    assert.ok(typeof child.info === 'function');
  });
});
