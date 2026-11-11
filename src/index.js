'use strict';

const { bootstrap } = require('./bootstrap');
const logger = require('./logger');
const wireguard = require('./wireguard');

// Safety net: an unhandled promise rejection — e.g. an async EventEmitter
// listener that rejects (TcpProxyManager.setRoutes failing to bind during a
// config apply) — would otherwise terminate the process on Node's default
// 'throw' mode and crash-loop a remote, hard-to-reach gateway. Log it loudly
// and stay alive; the next config poll / heartbeat recovers. Known sources are
// also hardened at the source (per-route isolation in setRoutes); this guards
// against unknown future ones.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason?.message || String(reason), stack: reason?.stack },
    'Unhandled promise rejection — kept alive',
  );
});

const ENV_PATH = process.env.GATEWAY_ENV_PATH || '/config/gateway.env';
const STATE_DIR = process.env.GATEWAY_STATE_DIR || '/state';

function envPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/**
 * Einrichtungs-/Statusseite im Heimnetz (docs/setup-page.md): ohne (gültige)
 * gateway.env wartet das Gateway dort auf einen Einrichtungscode, statt sich zu
 * beenden; danach zeigt dieselbe Adresse nur noch den Zustand.
 * GC_SETUP_PAGE=off schaltet sie ganz ab (Verhalten wie früher).
 */
function startSetupPage() {
  if (/^(off|0|false|no)$/i.test(process.env.GC_SETUP_PAGE || '')) return null;
  const { createSetupController } = require('./setup/controller');
  const { createSetupServer } = require('./setup/server');
  const { primaryLanIp } = require('./discovery/lanInterfaces');
  const { defaultGatewayIp } = require('./health/telemetry');
  const controller = createSetupController({
    envPath: ENV_PATH,
    stateDir: STATE_DIR,
    logger,
    wireguard,
    lanIp: () => { try { return primaryLanIp(defaultGatewayIp()); } catch { return null; } },
    onRestart: () => restartForNewAccess(),
  });
  const server = createSetupServer({
    controller,
    logger,
    port: envPort('GC_SETUP_PORT', 8642),
    altPort: envPort('GC_SETUP_ALT_PORT', null),
    allowedHosts: (process.env.GC_SETUP_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  });
  return { controller, server };
}

let shutdownFn = null;
/** Zustand F: neue gateway.env geschrieben → sauber beenden, der Dienst (Docker/systemd) startet mit ihr neu. */
function restartForNewAccess() {
  logger.info('New access data stored — restarting the gateway process');
  if (shutdownFn) shutdownFn('new-access', 1); else process.exit(1);
}

async function main() {
  let ctx;
  const setup = startSetupPage();
  let config = setup ? setup.controller.load() : null;
  if (setup) {
    await setup.server.start();
    if (!config) {
      // noch läuft nichts, was aufzuräumen wäre
      const quit = () => process.exit(0);
      process.on('SIGTERM', quit);
      process.on('SIGINT', quit);
      logger.info('Waiting for a setup code on the setup page');
      config = await setup.controller.waitForPairing();
      process.removeListener('SIGTERM', quit);
      process.removeListener('SIGINT', quit);
    }
  }
  try {
    ctx = await bootstrap({ config: config || undefined, hooks: setup ? setup.controller.hooks : undefined });
    logger.info('Gateway running');
  } catch (err) {
    logger.fatal({ err: err.message, stack: err.stack }, 'Bootstrap failed — exiting');
    if (setup) {
      // die Seite sagt noch kurz, was los ist; der Dienst startet das Gateway neu
      setup.controller.hooks.startFailed();
      await new Promise((r) => setTimeout(r, 3000));
    }
    process.exit(1);
  }

  // Graceful shutdown — guards against partial init (ctx might be undefined
  // if bootstrap failed, or individual ctx.* might be undefined for early failures)
  async function shutdown(signal, exitCode = 0) {
    logger.info({ signal }, 'Shutting down');
    try {
      if (setup) await setup.server.stop();
      ctx?.hb?.stop();
      // Tell the server first (≤ 2 s): it shows "Update läuft" / "startet neu"
      // right away instead of "online" until the heartbeat goes stale.
      await require('./shutdownNotice').notifyGoingDown(ctx?.config);
      await ctx?.edgeLink?.stop();
      ctx?.featureMgr?.stop();
      ctx?.poller?.stop();
      if (ctx?.apiServer) await new Promise(r => ctx.apiServer.close(r));
      if (ctx?.httpProxyServer) await new Promise(r => ctx.httpProxyServer.close(r));
      if (ctx?.tcpMgr) await ctx.tcpMgr.stopAll();
      if (ctx?.egressMgr) await ctx.egressMgr.stopAll();
      await wireguard.bringDown();
    } catch (err) {
      logger.warn({ err: err.message }, 'Shutdown error');
    }
    process.exit(exitCode);
  }
  shutdownFn = shutdown;
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
