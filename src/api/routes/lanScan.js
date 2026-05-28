'use strict';

const express = require('express');
const logger = require('../../logger');

// POST /api/lan-scan — async: validate, accept (202), then run the scan in the
// background (results stream back to the server via the scan manager).
function createLanScanRouter({ scanMgr, defaultGatewayIp }) {
  const router = express.Router();
  router.post('/lan-scan', (req, res) => {
    const { request_id, subnets, category_mode, categories, active_scan } = req.body || {};
    // NB: req.body.timeout_ms is advisory and intentionally NOT read — the gateway
    // enforces its own GC_DISCOVERY_TIMEOUT_MS (spec §4.5) via the ScanManager.
    if (typeof request_id !== 'string' || !request_id) return res.status(400).json({ error: 'request_id_required' });
    if (!Array.isArray(subnets) || subnets.length === 0) return res.status(400).json({ error: 'subnets_required' });
    if (!scanMgr.canStart()) return res.status(409).json({ error: 'scan_in_progress' });

    const allowed = scanMgr.validateSubnets(subnets, defaultGatewayIp());
    if (allowed.length === 0) return res.status(403).json({ error: 'no_valid_subnets' });

    res.status(202).json({ accepted: true, request_id, subnets_scanned: allowed });
    scanMgr.start({
      requestId: request_id, subnets: allowed, activeScan: active_scan === true,
      categoryMode: category_mode === 'exclude' ? 'exclude' : 'include',
      categories: Array.isArray(categories) ? categories : [],
    }).catch(err => logger.warn({ err: err.message, request_id }, 'lan-scan start failed'));
  });
  return router;
}

module.exports = { createLanScanRouter };
