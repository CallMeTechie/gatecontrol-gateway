'use strict';

const express = require('express');

function createStatusRouter({ getSelfCheckResult }) {
  const router = express.Router();
  router.get('/status', async (req, res) => {
    const result = await getSelfCheckResult();
    res.json(result);
  });
  return router;
}

module.exports = { createStatusRouter };
