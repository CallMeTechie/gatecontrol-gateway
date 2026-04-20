'use strict';

const axios = require('axios');
const http = require('node:http');
const https = require('node:https');
const logger = require('./logger');

// Disable keep-alive: reusing sockets across long-lived intervals causes
// stale TLS connections (Node 20 globalAgent defaults keepAlive=true) —
// after any network hiccup the server closes the socket, but the client
// keeps sending on it and gets EPROTO / TLS alert 80 indefinitely.
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

async function sendHeartbeat({ serverUrl, apiToken, health }) {
  try {
    await axios.post(`${serverUrl}/api/v1/gateway/heartbeat`, health, {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      timeout: 10_000,
      httpAgent,
      httpsAgent,
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
