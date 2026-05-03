'use strict';

const { loadConfig } = require('./config');
const wireguard = require('./wireguard');
const { ConfigStore } = require('./sync/configStore');
const { Poller } = require('./sync/poller');
const { fetchConfig, checkHash } = require('./sync/syncClient');
const { Router } = require('./proxy/router');
const { createHttpProxy } = require('./proxy/http');
const { TcpProxyManager } = require('./proxy/tcp');
const { createApiServer } = require('./api/server');
const { createConfigChangedRouter } = require('./api/routes/configChanged');
const { createWolRouter } = require('./api/routes/wol');
const { createStatusRouter } = require('./api/routes/status');
const { createProbeRouter } = require('./api/routes/probe');
const { createSelfCheckRunner } = require('./health/selfCheckRunner');
const { tcpProbe } = require('./health/selfCheck');
const { collectTelemetry } = require('./health/telemetry');
const { sendMagicPacket, waitForReachable } = require('./wol');
const { startHeartbeatTicker } = require('./heartbeat');
const { computeConfigHash: libComputeHash } = require('@callmetechie/gatecontrol-config-hash');
const logger = require('./logger');
const os = require('node:os');

const DEFAULT_ENV_PATH = process.env.GATEWAY_ENV_PATH || '/config/gateway.env';

async function bootstrap() {
  const config = loadConfig(DEFAULT_ENV_PATH);
  logger.info({ tunnelIp: config.tunnelIp, apiPort: config.apiPort, proxyPort: config.proxyPort }, 'Starting GateControl Home Gateway');

  // 1. Bring up WireGuard
  await wireguard.writeConfAndBringUp(config);

  // 2. In-memory state
  const store = new ConfigStore();
  const router = new Router();
  const tcpMgr = new TcpProxyManager({ bindIp: config.tunnelIp });

  // 3. On config change → apply
  store.on('change', async ({ cfg, hash }) => {
    logger.info({ hash, httpRoutes: cfg.routes.length, l4Routes: cfg.l4_routes.length }, 'Applying new config');
    router.setRoutes(cfg.routes);
    await tcpMgr.setRoutes(cfg.l4_routes);
  });

  // 4. Declare Poller (initial fetch runs LATER, after servers listen)
  const poller = new Poller({
    intervalMs: config.pollIntervalS * 1000,
    debounceMs: 500,
    fetcher: async () => {
      if (store.currentHash) {
        const hc = await checkHash({ serverUrl: config.serverUrl, apiToken: config.apiToken, hash: store.currentHash });
        if (!hc.changed) return { changed: false };
      }
      const data = await fetchConfig({ serverUrl: config.serverUrl, apiToken: config.apiToken });
      const { config_hash, ...cfgBody } = data;
      const recomputed = libComputeHash(cfgBody);
      if (config_hash && config_hash !== recomputed) {
        logger.warn({ server_hash: config_hash, our_hash: recomputed }, 'Hash mismatch — this should not happen if shared library is correct');
      }
      store.replaceConfig(cfgBody, config_hash || recomputed);
      return { changed: true };
    },
  });

  // 5. HTTP Proxy (listen BEFORE first poll — so config-change events during
  //    initial poll don't hit a non-listening proxy)
  const httpProxyServer = createHttpProxy({
    router,
    onUpstreamUnreachable: ({ domain, target }) => {
      if (target.wolMac) {
        logger.info({ domain, mac: target.wolMac }, 'Triggering WoL for unreachable upstream');
        sendMagicPacket(target.wolMac).catch(() => {});
      }
    },
  });
  await new Promise(r => httpProxyServer.listen(config.proxyPort, config.tunnelIp, r));
  logger.info({ bind: `${config.tunnelIp}:${config.proxyPort}` }, 'HTTP proxy listening');

  // Shared self-check runner — used by /api/status AND the heartbeat ticker.
  // Centralised so the route-list, DNS resolver and reachability probe are
  // wired up once instead of duplicated at each call-site.
  const runHealthCheck = createSelfCheckRunner({ config, store, tcpMgr, wireguard });

  // 6. Management API
  const apiApp = createApiServer({
    bindIp: config.tunnelIp,
    port: config.apiPort,
    expectedToken: config.gatewayToken,
    routerFactories: {
      '/api': () => {
        const mergeRouter = require('express').Router();
        mergeRouter.use(createConfigChangedRouter({ poller }));
        mergeRouter.use(createWolRouter({
          configStore: store,
          sendMagicPacket,
          waitForReachable,
        }));
        mergeRouter.use(createStatusRouter({
          getSelfCheckResult: runHealthCheck,
        }));
        mergeRouter.use(createProbeRouter({
          lanProbeFn: async () => {
            if (!config.lanProbeTarget) return { skipped: true };
            const [host, port = 80] = config.lanProbeTarget.split(':');
            return tcpProbe(host, parseInt(port, 10));
          },
        }));
        return mergeRouter;
      },
    },
  });
  const apiServer = apiApp.listen(config.apiPort, config.tunnelIp, () => {
    logger.info({ bind: `${config.tunnelIp}:${config.apiPort}` }, 'Management API listening');
  });

  // 7. Initial config-poll NOW (servers are listening). Tolerate first-poll
  //    failures: gateway can start with empty route-table and fill it on next
  //    successful poll (exponential backoff handled by Poller).
  try {
    await poller._runOnce();
    logger.info('Initial config poll successful');
  } catch (err) {
    logger.warn({ err: err.message }, 'Initial config poll failed — gateway starting with empty route table; Poller will retry with backoff');
  }
  poller.start();

  // 8. Heartbeat LAST — so if an earlier step throws, the ticker is never
  //    started and shutdown handler needn't defend against undefined ctx.hb.
  const hb = startHeartbeatTicker({
    serverUrl: config.serverUrl,
    apiToken: config.apiToken,
    intervalMs: config.heartbeatIntervalS * 1000,
    getHealth: async () => {
      const health = await runHealthCheck();
      // Opportunistic hostname report — server populates peers.hostname for
      // internal DNS on every heartbeat. Sticky-admin is enforced server-side.
      health.hostname = os.hostname();
      // Gateway telemetry (versions, resources, LAN context) — stapled onto
      // every heartbeat; server persists the whole payload into
      // gateway_meta.last_health and the admin UI pulls what it needs.
      health.telemetry = collectTelemetry();
      health.config_hash = store.currentHash || null;
      return health;
    },
  });

  return { config, poller, httpProxyServer, apiServer, tcpMgr, hb };
}

module.exports = { bootstrap };
