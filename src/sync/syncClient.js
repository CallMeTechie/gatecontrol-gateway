'use strict';

const axios = require('axios');
const logger = require('../logger');

async function fetchConfig({ serverUrl, apiToken }) {
  const res = await axios.get(`${serverUrl}/api/v1/gateway/config`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    timeout: 10_000,
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
    });
    return { changed: res.status === 200, hash: res.data?.config_hash };
  } catch (err) {
    logger.warn({ err: err.message }, 'checkHash failed');
    throw err;
  }
}

module.exports = { fetchConfig, checkHash };
