'use strict';

const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level,
  base: { service: 'gatecontrol-gateway' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['*.password', '*.token', '*.api_token', '*.push_token', '*.authorization'],
});

module.exports = logger;
