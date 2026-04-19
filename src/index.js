'use strict';

const { bootstrap } = require('./bootstrap');
const logger = require('./logger');
const wireguard = require('./wireguard');

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
