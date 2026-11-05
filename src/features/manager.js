'use strict';

// Hält die Phase-3a-Funktionen des Gateways zusammen: Netzwerk-Wächter,
// Internetqualität, Anwesenheit, USV. Schaltet sie nach `features` aus dem
// Config-Pull (fehlt es → alles aus) und liefert ihren Zustand für die
// Telemetrie. Alles läuft im Gateway-Prozess, Zustand in /state.

const { normalizeFeatures } = require('./config');
const { makeReporter } = require('./reporter');
const { NetWatch } = require('../netwatch/netwatch');
const { createScanner } = require('../netwatch/scanner');
const { makeOuiLookup } = require('../netwatch/oui');
const { Presence } = require('../presence/presence');
const { InetQuality } = require('../inetq/inetq');
const { UpsMonitor } = require('../ups/nut');
const { lanSubnets, isPrivateIpv4 } = require('../discovery/lanInterfaces');
const { localIpForSubnet } = require('../discovery/scanEngine');
const logger = require('../logger');

const CAPABILITIES = Object.freeze(['netwatch', 'inetq', 'presence', 'ups']);

/** Eigene private LAN-Subnetze mit der eigenen Adresse darin. */
function privateSubnets(defaultGatewayIp) {
  return lanSubnets(defaultGatewayIp())
    .filter((s) => isPrivateIpv4(s.cidr.split('/')[0]))
    .map((s) => ({ cidr: s.cidr, localIp: localIpForSubnet(s.cidr) }));
}

class FeatureManager {
  constructor({ netwatch, inetq, presence, ups }) {
    Object.assign(this, { netwatch, inetq, presence, ups });
    this.features = normalizeFeatures(undefined);
  }

  /** Neue `features` aus dem Config-Pull anwenden (undefined = alter Server → alles aus). */
  apply(raw) {
    const f = normalizeFeatures(raw);
    this.features = f;
    this.netwatch.apply(f.netwatch);
    this.inetq.apply(f.inetq);
    this.presence.apply(f.presence);
    this.ups.apply(f.ups);
    logger.info({
      netwatch: f.netwatch.enabled, portscan: f.netwatch.portscan, inetq: f.inetq.enabled,
      speedtest: f.inetq.speedtest, presence: f.presence.enabled, presenceMacs: f.presence.macs.length, ups: f.ups.enabled,
    }, 'features applied');
  }

  stop() {
    for (const x of [this.netwatch, this.inetq, this.presence, this.ups]) {
      try { x.stop(); } catch (_e) { /* best effort */ }
    }
  }

  /** Telemetrie-Teile: { capabilities, features, ups, process_mem } */
  telemetry() {
    const mem = process.memoryUsage();
    return {
      capabilities: [...CAPABILITIES],
      features: {
        netwatch: this.netwatch.telemetry(),
        inetq: this.inetq.telemetry(),
        presence: this.presence.telemetry(),
        ups: this.ups.featureTelemetry(),
      },
      ups: this.ups.telemetry(),
      process_mem: { rss: mem.rss, heapUsed: mem.heapUsed },
    };
  }
}

function createFeatureManager({ config, defaultGatewayIp }) {
  const reporter = makeReporter({ serverUrl: config.serverUrl, apiToken: config.apiToken });
  const scanner = createScanner();
  const getSubnets = () => privateSubnets(defaultGatewayIp);
  const netwatch = new NetWatch({
    scanner, oui: makeOuiLookup(), reporter, stateDir: config.stateDir, tunnelIp: config.tunnelIp,
    getSubnets, maxPrefix: config.discoveryMaxPrefix,
  });
  const presence = new Presence({
    scanner, reporter, getSubnets, maxPrefix: config.discoveryMaxPrefix,
    knownIp: (mac) => (netwatch.cfg.enabled ? netwatch.knownIp(mac) : null),
    ownSweep: () => !netwatch.cfg.enabled,
  });
  const inetq = new InetQuality({
    reporter, serverUrl: config.serverUrl, apiToken: config.apiToken, stateDir: config.stateDir,
    routerIp: defaultGatewayIp,
  });
  const ups = new UpsMonitor();
  return new FeatureManager({ netwatch, inetq, presence, ups });
}

module.exports = { FeatureManager, createFeatureManager, privateSubnets, CAPABILITIES };
