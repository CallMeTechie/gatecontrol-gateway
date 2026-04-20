'use strict';

const express = require('express');
const { createAuthMiddleware } = require('./middleware/auth');

/**
 * Build the Express app for the management API. Hard-refuses 0.0.0.0 binding
 * (management API must only be reachable through the tunnel).
 */
function createApiServer({ bindIp, port, expectedToken, routerFactories = {} }) {
  if (bindIp === '0.0.0.0' || bindIp === '::') {
    throw new Error(`Management API refuses to bind on ${bindIp} — must bind on tunnel-ip only`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  // Health endpoint — must be registered BEFORE the auth-guarded /api mount,
  // otherwise the auth middleware on /api/* rejects the probe with 401.
  // Used by Docker HEALTHCHECK (probes $GC_TUNNEL_IP, not 127.0.0.1, because
  // the API binds tunnel-IP-only).
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  const auth = createAuthMiddleware({ expectedToken });

  // Mount routers from provided factories (config-changed, wol, status, etc.)
  for (const [mountPath, factory] of Object.entries(routerFactories)) {
    app.use(mountPath, auth, factory());
  }

  app._bindIp = bindIp;
  app._port = port;

  return app;
}

module.exports = { createApiServer };
