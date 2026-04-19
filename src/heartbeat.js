'use strict';

const axios = require('axios');
const logger = require('./logger');

async function sendHeartbeat({ serverUrl, apiToken, health }) {
  try {
    await axios.post(`${serverUrl}/api/v1/gateway/heartbeat`, health, {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      timeout: 10_000,
    });
  } catch (err) {
    logger.warn({ err: err.message, status: err.response?.status }, 'Heartbeat failed');
  }
}

function startHeartbeatTicker({ serverUrl, apiToken, getHealth, intervalMs }) {
  const tick = async () => {
    const health = await getHealth();
    await sendHeartbeat({ serverUrl, apiToken, health });
  };
  const timer = setInterval(tick, intervalMs);
  tick(); // fire immediately
  return { stop: () => clearInterval(timer) };
}

module.exports = { sendHeartbeat, startHeartbeatTicker };
