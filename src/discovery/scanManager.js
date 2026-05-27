'use strict';

const fs = require('node:fs');
const logger = require('../logger');
const { lanSubnets } = require('./lanInterfaces');
const { parseArp } = require('./tcpSweep');

// Long-lived: enforces one scan at a time, re-validates requested subnets
// against the gateway's OWN physical-LAN interfaces (defense in depth), and runs
// the engine async, streaming batches to the server and guaranteeing a terminal
// `done` even on timeout/error.
class ScanManager {
  constructor({ config, discoveryClient, runScan, sources, lanSubnetsFn, arpReader }) {
    this.config = config;
    this.client = discoveryClient;
    this.runScan = runScan;
    this.sources = sources;
    this.lanSubnetsFn = lanSubnetsFn || lanSubnets; // injectable for tests
    this.arpReader = arpReader || (() => {
      try { return parseArp(fs.readFileSync('/proc/net/arp', 'utf8')); } catch (_e) { /* not available outside Linux */ return new Map(); }
    });
    this.active = null; // null | { requestId, startedAt }
  }

  canStart() { return this.active === null; }

  // Keep only requested CIDRs that exactly match an owned physical-LAN subnet
  // AND are no larger than the configured cap (prefix >= discoveryMaxPrefix).
  validateSubnets(requested, gwIp) {
    const owned = new Set(this.lanSubnetsFn(gwIp).map(s => s.cidr));
    const cap = this.config.discoveryMaxPrefix;
    return (Array.isArray(requested) ? requested : []).filter(cidr => {
      if (!owned.has(cidr)) return false;
      const prefix = Number(String(cidr).split('/')[1]);
      return Number.isInteger(prefix) && prefix >= cap;
    });
  }

  async start({ requestId, subnets, activeScan, categoryMode, categories }) {
    if (this.active) throw new Error('scan_in_progress');
    this.active = { requestId, startedAt: Date.now() };
    const send = (devices, done) => this.client.sendBatch({ requestId, devices, done });
    let timer = null;
    try {
      await Promise.race([
        this.runScan({ subnets, activeScan, categoryMode, categories, config: this.config, sources: this.sources, arpReader: this.arpReader, onBatch: send }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('scan_timeout')), this.config.discoveryTimeoutMs + 15_000); }),
      ]);
    } catch (err) {
      logger.warn({ err: err.message, requestId }, 'scan failed/timed out');
      await send([], true); // guarantee a terminal batch so the server/UI never hangs
    } finally {
      if (timer) clearTimeout(timer);
      this.active = null;
    }
  }
}

module.exports = { ScanManager };
