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

async function main() {
  let ctx;
  try {
    ctx = await bootstrap();
    logger.info('Gateway running');
  } catch (err) {
    logger.fatal({ err: err.message, stack: err.stack }, 'Bootstrap failed — exiting');
    process.exit(1);
  }

  // Graceful shutdown — guards against partial init (ctx might be undefined
  // if bootstrap failed, or individual ctx.* might be undefined for early failures)
  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down');
    try {
      ctx?.hb?.stop();
      ctx?.poller?.stop();
      if (ctx?.apiServer) await new Promise(r => ctx.apiServer.close(r));
      if (ctx?.httpProxyServer) await new Promise(r => ctx.httpProxyServer.close(r));
      if (ctx?.tcpMgr) await ctx.tcpMgr.stopAll();
      if (ctx?.egressMgr) await ctx.egressMgr.stopAll();
      await wireguard.bringDown();
    } catch (err) {
      logger.warn({ err: err.message }, 'Shutdown error');
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
