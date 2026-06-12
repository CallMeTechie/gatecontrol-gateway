'use strict';

const dns = require('node:dns/promises');
const { runSelfCheck, tcpProbe } = require('./selfCheck');
const logger = require('../logger');

/**
 * Build a parameterless `runHealthCheck()` that closes over the long-lived
 * dependencies (config, in-memory store, tcp-manager, wireguard module).
 * Both the management /api/status route and the heartbeat ticker call it,
 * so the boilerplate around routes, dnsResolveFn and reachabilityFn stays
 * in one place — the call-sites just `await runHealthCheck()`.
 */
function createSelfCheckRunner({ config, store, tcpMgr, wireguard }) {
  const serverHostname = new URL(config.serverUrl).hostname;

  const buildRoutes = () => [
    ...store.httpRoutes,
    ...store.l4Routes.map(r => ({
      id: r.id,
      // Synthesize a domain label so route_reachability entries for L4
      // routes carry something more useful than `undefined` in the UI.
      domain: `l4:${r.listen_port}`,
      target_lan_host: r.target_lan_host,
      target_lan_port: r.target_lan_port,
    })),
  ];

  const doCheck = () => runSelfCheck({
    proxyPort: config.proxyPort,
    apiPort: config.apiPort,
    tcpPorts: tcpMgr.listListenerPorts(),
    l4RouteCount: store.l4Routes.length,
    bindIp: config.tunnelIp,
    wgStatus: () => wireguard.getStatus(),
    dnsResolveFn: () => dns.resolve4(serverHostname),
    reachabilityFn: async (h, p) => {
      const res = await tcpProbe(h, p);
      return { reachable: res.reachable, latencyMs: res.latencyMs };
    },
    routes: buildRoutes(),
  });

  /**
   * @param {{reconcile?: boolean}} [opts] — when `reconcile` is true (heartbeat
   *   path only), a detected L4 listener deficit triggers a one-shot re-apply
   *   of the route table. The /api/status read-path leaves it false so a GET
   *   never mutates listener state.
   */
  return async function runHealthCheck({ reconcile = false } = {}) {
    let result = await doCheck();

    // Self-heal: configured L4 routes with no registered listener mean a prior
    // bind failed and — since the config hash is unchanged — will never be
    // retried via the 'change' event. setRoutes is idempotent (healthy
    // listeners untouched, missing ones rebound), so re-applying is safe.
    if (reconcile && result.l4_listeners_missing > 0) {
      logger.warn(
        { missing: result.l4_listeners_missing, configured: result.l4_routes_configured },
        'L4 listener deficit detected — re-applying route table to retry missing binds',
      );
      try {
        await tcpMgr.setRoutes(store.l4Routes);
        result = await doCheck();
        result.listener_reapply_triggered = true;
      } catch (err) {
        logger.error({ err: err.message }, 'L4 listener re-apply failed');
      }
    }

    return result;
  };
}

module.exports = { createSelfCheckRunner };
