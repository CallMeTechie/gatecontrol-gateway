'use strict';

const express = require('express');

// Management-Aufrufe des Servers für Phase 3a (über den Tunnel, X-Gateway-Token):
//   POST /api/netwatch/scan     { ports?: true }  – „Jetzt scannen“
//   POST /api/inetq/speedtest   {}                – „Jetzt messen“
// Antwort sofort (202); das Ergebnis kommt über die normalen Berichte.
function reply(res, outcome, busyError) {
  if (outcome === 'accepted') return res.status(202).json({ accepted: true });
  if (outcome === 'busy') return res.status(409).json({ error: busyError });
  return res.status(503).json({ error: 'feature_disabled' });
}

function createFeaturesRouter({ featureMgr }) {
  const router = express.Router();
  router.post('/netwatch/scan', (req, res) => {
    const ports = req.body && req.body.ports === true;
    reply(res, featureMgr.netwatch.requestScan({ ports }), 'scan_in_progress');
  });
  router.post('/inetq/speedtest', (req, res) => {
    reply(res, featureMgr.inetq.requestSpeedtest(), 'speedtest_running');
  });
  return router;
}

module.exports = { createFeaturesRouter };
