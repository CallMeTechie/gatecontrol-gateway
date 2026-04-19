'use strict';

const express = require('express');
const { validateMac } = require('../../wol');
const { isRfc1918 } = require('../../config');
const logger = require('../../logger');

const DEFAULT_REACH_PORT = 80;

function createWolRouter({ configStore, sendMagicPacket, waitForReachable }) {
  const router = express.Router();

  router.post('/wol', async (req, res) => {
    const { mac, lan_host, lan_host_port, timeout_ms } = req.body || {};
    if (!mac || !validateMac(mac)) {
      return res.status(400).json({ error: 'invalid_mac' });
    }
    if (!lan_host || typeof lan_host !== 'string' || !isRfc1918(lan_host)) {
      logger.warn({ lan_host }, 'WoL rejected: lan_host not RFC1918');
      return res.status(400).json({ error: 'lan_host_must_be_rfc1918' });
    }
    if (!configStore.isMacInWolWhitelist(mac)) {
      logger.warn({ mac }, 'WoL request MAC not in whitelist');
      return res.status(403).json({ error: 'mac_not_whitelisted' });
    }
    const reachPort = Number.isInteger(lan_host_port) && lan_host_port > 0 && lan_host_port < 65536
      ? lan_host_port
      : DEFAULT_REACH_PORT;
    const results = await sendMagicPacket(mac);
    const elapsed_ms = await waitForReachable(lan_host, reachPort, timeout_ms || 60000);
    if (elapsed_ms === null) {
      return res.status(200).json({ success: false, reason: 'timeout', sent_on: results });
    }
    res.json({ success: true, elapsed_ms, sent_on: results });
  });

  return router;
}

module.exports = { createWolRouter };
