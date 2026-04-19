'use strict';

const express = require('express');
const logger = require('../../logger');

function createConfigChangedRouter({ poller }) {
  const router = express.Router();
  router.post('/config-changed', (req, res) => {
    logger.info({ ip: req.ip }, 'Received config-changed push, triggering poll');
    poller.triggerImmediate();
    res.status(200).json({ ok: true });
  });
  return router;
}

module.exports = { createConfigChangedRouter };
