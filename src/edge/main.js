'use strict';

// Startpunkt des Edge-Containers (gleiches Image wie das Gateway, anderer
// Befehl: node src/edge/main.js, Benutzer gcedge/61001, keine Capabilities).

const fs = require('node:fs');

process.env.GC_LOG_SERVICE = process.env.GC_LOG_SERVICE || 'gatecontrol-edge';
const logger = require('../logger');
const { paths } = require('./constants');
const { EdgeHost } = require('./host');
const { MdnsService } = require('./mdnsService');

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason && reason.message ? reason.message : String(reason) }, 'edge: unhandled rejection — kept alive');
});

async function main() {
  const p = paths();
  for (const d of [p.stateDir, p.packagesDir, p.dataDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const mdns = new MdnsService({ logger });
  const host = new EdgeHost({ paths: p, logger, mdns });
  await host.start();
  // Die Zeitgeber des Hosts sind unref() (Tests); der Container-Prozess soll
  // aber auch ohne Verbindung und ohne Zugangsdatei weiterlaufen.
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
  logger.info({ uid: process.getuid && process.getuid() }, 'edge: host running');
  const shutdown = async (signal) => {
    logger.info({ signal }, 'edge: shutting down');
    clearInterval(keepAlive);
    try { await host.stop(); } catch (e) { logger.warn({ err: e.message }, 'edge: shutdown error'); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((e) => {
    logger.fatal({ err: e.message, stack: e.stack }, 'edge: start failed');
    process.exit(1);
  });
}

module.exports = { main };
