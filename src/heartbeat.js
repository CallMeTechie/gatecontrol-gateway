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

// Cap on getHealth() so a wedged self-check (hung `wg show`, slow per-route
// LAN-probe, blocked DNS-resolve) cannot block the heartbeat tick. If the
// cap fires we still send a heartbeat with a minimal payload — the server's
// _isHeartbeatHealthy() treats missing tcp_listeners as "no failure", so the
// gateway stays online but the operator sees the timeout reason in
// last_health for diagnosis. Default 8s is below the heartbeat HTTP-timeout
// (10s) so the next tick can land before the previous overruns it.
const DEFAULT_HEALTH_TIMEOUT_MS = 8_000;

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

async function _collectHealth(getHealth, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([getHealth(), timeout]);
    if (result && result.__timedOut) {
      logger.warn({ timeoutMs }, 'getHealth() timed out — sending minimal heartbeat');
      return { overall_healthy: false, reason: 'health_collection_timeout' };
    }
    return result;
  } catch (err) {
    logger.warn({ err: err.message }, 'getHealth() threw — sending minimal heartbeat');
    return { overall_healthy: false, reason: 'health_collection_error', error: err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function startHeartbeatTicker({ serverUrl, apiToken, getHealth, intervalMs, healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS }) {
  const tick = async () => {
    const health = await _collectHealth(getHealth, healthTimeoutMs);
    await sendHeartbeat({ serverUrl, apiToken, health });
  };
  const timer = setInterval(tick, intervalMs);
  tick(); // fire immediately
  return { stop: () => clearInterval(timer) };
}

module.exports = { sendHeartbeat, startHeartbeatTicker, _collectHealth, DEFAULT_HEALTH_TIMEOUT_MS };
