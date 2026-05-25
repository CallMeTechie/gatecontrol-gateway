'use strict';

const express = require('express');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const logger = require('../../logger');

const COOLDOWN_MS = 60_000;

function createSelfUpdateRouter({ stateDir }) {
  const router = express.Router();
  router.post('/self-update', async (req, res) => {
    const { request_id, target_version } = req.body || {};
    if (!request_id || typeof request_id !== 'string') {
      return res.status(400).json({ error: 'request_id_required' });
    }
    try { await fs.access(stateDir, fssync.constants.W_OK); }
    catch { return res.status(500).json({ error: 'state_unavailable' }); }

    try {
      const lp = JSON.parse(await fs.readFile(path.join(stateDir, 'last-pull'), 'utf8'));
      const already = lp && lp.request_id === request_id;
      const postSuccessLoop = lp && lp.ok === true && typeof lp.pulled_at === 'number'
        && (Date.now() - lp.pulled_at) < COOLDOWN_MS;
      if (already || postSuccessLoop) {
        return res.status(200).json({ ok: true, skipped: 'cooldown' });
      }
    } catch { /* no/invalid last-pull → proceed */ }

    const flag = path.join(stateDir, 'pending-update');
    try {
      await fs.writeFile(flag, JSON.stringify({
        request_id,
        target_version: typeof target_version === 'string' ? target_version : null,
        requested_at: new Date().toISOString(),
        triggered_via: 'server-push',
      }) + '\n', { mode: 0o600 });
      logger.info({ request_id }, 'Self-update flag written');
      res.status(200).json({ ok: true, queued: true });
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to write self-update flag');
      res.status(500).json({ error: 'flag_write_failed' });
    }
  });
  return router;
}

module.exports = { createSelfUpdateRouter };
