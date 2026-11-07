'use strict';

// Berichte an den Server (Gateway-Token als Bearer, wie Heartbeat und
// Discovery). Wirft nie: Ergebnis { ok, status, error }.

const axios = require('axios');
const http = require('node:http');
const https = require('node:https');

// Kein Keep-Alive (Begründung in src/heartbeat.js).
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function makeReporter({ serverUrl, apiToken, timeoutMs = 15_000 }) {
  async function post(path, body) {
    try {
      const res = await axios.post(`${serverUrl}${path}`, body, {
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        timeout: timeoutMs,
        httpAgent,
        httpsAgent,
      });
      return { ok: true, status: res.status, data: res.data };
    } catch (err) {
      return { ok: false, status: err.response?.status ?? null, error: err.message, retryAfter: err.response?.headers?.['retry-after'] ?? null };
    }
  }
  return { post };
}

module.exports = { makeReporter };
