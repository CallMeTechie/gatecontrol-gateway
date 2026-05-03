'use strict';

const dns = require('node:dns/promises');
const { runSelfCheck, tcpProbe } = require('./selfCheck');

/**
 * Build a parameterless `runHealthCheck()` that closes over the long-lived
 * dependencies (config, in-memory store, tcp-manager, wireguard module).
 * Both the management /api/status route and the heartbeat ticker call it,
 * so the boilerplate around routes, dnsResolveFn and reachabilityFn stays
 * in one place — the call-sites just `await runHealthCheck()`.
 */
function createSelfCheckRunner({ config, store, tcpMgr, wireguard }) {
  const serverHostname = new URL(config.serverUrl).hostname;

  return async function runHealthCheck() {
    const routes = [
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

    return runSelfCheck({
      proxyPort: config.proxyPort,
      apiPort: config.apiPort,
      tcpPorts: tcpMgr.listListenerPorts(),
      bindIp: config.tunnelIp,
      wgStatus: () => wireguard.getStatus(),
      dnsResolveFn: () => dns.resolve4(serverHostname),
      reachabilityFn: async (h, p) => {
        const res = await tcpProbe(h, p);
        return { reachable: res.reachable, latencyMs: res.latencyMs };
      },
      routes,
    });
  };
}

module.exports = { createSelfCheckRunner };
