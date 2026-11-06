'use strict';

// The "going down" notice of a graceful shutdown (index.js): why the gateway
// stops and the notice to the server (heartbeat.sendGoingDown).
//
// 'update' when an update is under way — the pending-update flag is still
// there (the host's updater has not picked it up yet) or the server asked for
// one in the last UPDATE_WINDOW_MS (update.sh consumes the flag, pulls the
// image and then recreates the container: that recreate is this SIGTERM).
// Otherwise 'restart' (docker restart, host reboot, compose up).

const fs = require('node:fs');
const path = require('node:path');
const { sendGoingDown } = require('./heartbeat');
const { lastRequestAt } = require('./api/routes/selfUpdate');

const UPDATE_WINDOW_MS = 30 * 60 * 1000;

function shutdownReason({ stateDir, now = Date.now(), requestedAt = lastRequestAt() } = {}) {
  if (requestedAt && now - requestedAt < UPDATE_WINDOW_MS) return 'update';
  if (stateDir) {
    try { fs.accessSync(path.join(stateDir, 'pending-update')); return 'update'; } catch { /* no flag */ }
  }
  return 'restart';
}

/** Send the notice; never throws, never takes longer than the heartbeat module's cap. */
async function notifyGoingDown(config, opts = {}) {
  if (!config || !config.serverUrl || !config.apiToken) return false;
  const reason = shutdownReason({ stateDir: config.stateDir, ...opts });
  return sendGoingDown({ serverUrl: config.serverUrl, apiToken: config.apiToken, reason, timeoutMs: opts.timeoutMs });
}

module.exports = { shutdownReason, notifyGoingDown, UPDATE_WINDOW_MS };
