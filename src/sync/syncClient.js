'use strict';

const axios = require('axios');
const http = require('node:http');
const https = require('node:https');
const logger = require('../logger');

// Disable keep-alive: see heartbeat.js for rationale (stale TLS reuse
// causes EPROTO / TLS alert 80 after any network hiccup).
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

async function fetchConfig({ serverUrl, apiToken }) {
  const res = await axios.get(`${serverUrl}/api/v1/gateway/config`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    timeout: 10_000,
    httpAgent,
    httpsAgent,
  });
  return res.data;
}

async function checkHash({ serverUrl, apiToken, hash }) {
  try {
    const res = await axios.get(`${serverUrl}/api/v1/gateway/config/check`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      params: { hash },
      timeout: 5_000,
      validateStatus: (s) => s === 200 || s === 304,
      httpAgent,
      httpsAgent,
    });
    return { changed: res.status === 200, hash: res.data?.config_hash };
  } catch (err) {
    logger.warn({ err: err.message }, 'checkHash failed');
    throw err;
  }
}

module.exports = { fetchConfig, checkHash };
