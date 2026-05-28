'use strict';

const axios = require('axios');
const http = require('node:http');
const https = require('node:https');
const logger = require('../logger');

const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

// Mirrors src/heartbeat.js: Bearer POST to the server, tolerant of failures.
function makeDiscoveryClient({ serverUrl, apiToken }) {
  async function sendBatch({ requestId, devices, done }) {
    try {
      await axios.post(`${serverUrl}/api/v1/gateway/discovery`,
        { request_id: requestId, devices, done },
        { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          timeout: 10_000, httpAgent, httpsAgent });
    } catch (err) {
      logger.warn({ err: err.message, status: err.response?.status }, 'discovery batch post failed');
    }
  }
  return { sendBatch };
}

module.exports = { makeDiscoveryClient };
