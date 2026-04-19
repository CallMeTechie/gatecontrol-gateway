'use strict';

const express = require('express');

function createProbeRouter({ lanProbeFn }) {
  const router = express.Router();
  // POST /api/probe — triggered by Server as end-to-end health check
  router.post('/probe', async (req, res) => {
    const start = Date.now();
    const result = await lanProbeFn();
    res.json({
      gateway_timestamp: Date.now(),
      probe_latency_ms: Date.now() - start,
      probe_result: result,
      echo: req.body || null,
    });
  });
  return router;
}

module.exports = { createProbeRouter };
