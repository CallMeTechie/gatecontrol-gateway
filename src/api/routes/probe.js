'use strict';

const express = require('express');
const logger = require('../../logger');

// Accept only a sane hostname/IP and a 1..65535 port. Auth is already
// enforced by the X-Gateway-Token middleware on this router; this guard
// just keeps malformed input from reaching the socket layer.
function validTarget(host, port) {
  if (typeof host !== 'string' || !host || host.length > 255) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) return null;
  const p = parseInt(port, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  return { host, port: p };
}

function createProbeRouter({ lanProbeFn, tcpProbe, isHostAllowed }) {
  if (tcpProbe && !isHostAllowed) {
    throw new Error('createProbeRouter: isHostAllowed is required when tcpProbe is provided');
  }
  const router = express.Router();
  // POST /api/probe — triggered by the Server as an end-to-end health check.
  // With {host,port} → probe that exact target (real RDP host behind the
  // gateway). Without → legacy self-check via lanProbeFn.
  router.post('/probe', async (req, res) => {
    const start = Date.now();
    const body = req.body || {};
    const target = (body.host != null || body.port != null)
      ? validTarget(body.host, body.port)
      : null;

    // LAN-scope: a targeted probe must stay within the gateway's own
    // physical LAN. Out-of-scope IPv4 literals are reported as offline with
    // probed_target SET — so the server trusts the verdict (offline) instead
    // of falling back to its loopback probe (which would false-positive).
    if (target && isHostAllowed && !isHostAllowed(target.host)) {
      logger.warn({ host: target.host, port: target.port }, 'probe rejected: out_of_lan_scope');
      return res.json({
        gateway_timestamp: Date.now(),
        probe_latency_ms: Date.now() - start,
        probe_result: false,
        probed_target: target,
        rejected: 'out_of_lan_scope',
        echo: req.body || null,
      });
    }

    let result;
    if (target) {
      result = await tcpProbe(target.host, target.port);
    } else {
      result = await lanProbeFn();
    }

    res.json({
      gateway_timestamp: Date.now(),
      probe_latency_ms: Date.now() - start,
      probe_result: result,
      probed_target: target,        // present ⇒ this gateway honored the target
      echo: req.body || null,
    });
  });
  return router;
}

module.exports = { createProbeRouter, validTarget };
