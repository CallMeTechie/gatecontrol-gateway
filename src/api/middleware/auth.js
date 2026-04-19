'use strict';

const crypto = require('node:crypto');
const logger = require('../../logger');

/**
 * Create middleware that validates X-Gateway-Token header against expectedToken
 * using timing-safe comparison.
 */
function createAuthMiddleware({ expectedToken }) {
  if (!expectedToken || typeof expectedToken !== 'string') {
    throw new Error('expectedToken required');
  }
  const expected = Buffer.from(expectedToken, 'utf8');

  return function authMiddleware(req, res, next) {
    const header = req.headers['x-gateway-token'];
    if (!header || typeof header !== 'string') {
      return res.status(401).json({ error: 'missing_gateway_token' });
    }
    const presented = Buffer.from(header, 'utf8');
    if (presented.length !== expected.length) {
      logger.warn({ ip: req.ip, len: presented.length }, 'Invalid gateway-token length');
      return res.status(403).json({ error: 'invalid_token' });
    }
    if (!crypto.timingSafeEqual(presented, expected)) {
      logger.warn({ ip: req.ip }, 'Invalid gateway-token value');
      return res.status(403).json({ error: 'invalid_token' });
    }
    next();
  };
}

module.exports = { createAuthMiddleware };
