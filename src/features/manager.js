'use strict';

// Hält die Funktionen des Gateways zusammen: Netzwerk-Wächter,
// Internetqualität, Anwesenheit, USV (Phase 3a), DNS-Filter, Zwischenspeicher
// und Zeitzone (Phase 3b), Drucken & Scannen, Funk, Lokale KI und Kameras (Phase 3c). Schaltet sie nach `features` aus dem Config-Pull
// (fehlt es → alles aus) und liefert ihren Zustand für die Telemetrie. Alles
// läuft im Gateway-Prozess, Zustand in /state.

const { normalizeFeatures } = require('./config');
const { applyTimezone, timezoneTelemetry, validTimezone } = require('./timezone');
const { readJson, writeJson } = require('./persist');
const { normalizeDns } = require('../dns/config');
const { DnsFilter } = require('../dns/dns');
const { HomeCache } = require('../cache/cache');
const { PrintService } = require('../print/print');
const { RadioService } = require('../radio/radio');
const { AiService } = require('../ai/ai');
const { CameraService } = require('../cameras/cameras');
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

// print-convert: PDF für Drucker ohne PDF im Gateway umwandeln (docs/print.md „Umwandeln“)
// print-ocr / print-office / print-media: Texterkennung, Office-Dateien, Papier und Fach (docs/print.md)
// radio-stacks: Funk mit zigbee2mqtt, Thread Border Router und Schlüsseln verschlüsselter Sensoren (docs/radio.md)
const CAPABILITIES = Object.freeze(['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'storage', 'timezone', 'print', 'print-convert', 'print-ocr', 'print-office', 'print-media', 'radio', 'radio-stacks', 'ai', 'cameras']);
// DNS-Einstellung und Zeitzone überstehen den Neustart: Zeigt der Router auch
// den Gateway-Host auf den Filter, braucht schon der erste Config-Pull ihn.
const BOOT_FILE = 'features-boot.json';
const noop = { apply: async () => {}, stop() {}, telemetry: () => null, featureTelemetry: () => ({ enabled: false }) };
const noopPrint = { ...noop, requestSearch: () => 'disabled', requestJobs: () => 'disabled', requestScan: () => 'disabled', cancelScan: () => 'disabled' };
const noopRadio = { ...noop, requestPair: async () => 'disabled', requestUnlock: async () => 'disabled', requestRetry: async () => 'disabled', requestRemove: async () => 'disabled', requestSet: async () => 'disabled',
  requestThreadForm: async () => 'disabled', requestThreadJoin: async () => 'disabled', requestThreadDataset: async () => ({ outcome: 'disabled' }), attachMqtt() {}, status: async () => null };
const noopCameras = { ...noop, cfg: { enabled: false } };
const noopAi = { ...noop, cfg: { enabled: false }, requestPull: () => 'disabled', cancelPull: () => 'disabled', removeModel: async () => 'disabled', canChat: () => 'disabled', status: async () => null };

/** Eigene private LAN-Subnetze mit der eigenen Adresse darin. */
function privateSubnets(defaultGatewayIp) {
  return lanSubnets(defaultGatewayIp())
    .filter((s) => isPrivateIpv4(s.cidr.split('/')[0]))
    .map((s) => ({ cidr: s.cidr, localIp: localIpForSubnet(s.cidr) }));
}

class FeatureManager {
  constructor({ netwatch, inetq, presence, ups, dns = noop, cache = noop, print = noopPrint, radio = noopRadio, ai = noopAi, cameras = noopCameras, stateDir = null }) {
    Object.assign(this, { netwatch, inetq, presence, ups, dns, cache, print, radio, ai, cameras, stateDir });
    this.features = normalizeFeatures(undefined);
    this.chain = Promise.resolve(); // DNS/Zwischenspeicher nacheinander anwenden
  }

  _serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch((err) => logger.warn({ err: err.message }, 'features: apply failed'));
    return this.chain;
  }

  _timezone(tz) {
    if (!applyTimezone(tz)) return;
    logger.info({ timezone: timezoneTelemetry().effective }, 'timezone changed');
    for (const x of [this.netwatch, this.inetq]) {
      if (typeof x.replan === 'function') try { x.replan(); } catch (_e) { /* best effort */ }
    }
  }

  /** Letzte DNS-Einstellung/Zeitzone vor dem ersten Config-Pull (nur Gateway-Start). */
  restoreBoot() {
    if (!this.stateDir) return this.chain;
    const b = readJson(this.stateDir, BOOT_FILE);
    if (!b) return this.chain;
    this._timezone(validTimezone(b.timezone));
    const dns = normalizeDns(b.dns);
    if (!dns.enabled) return this.chain;
    logger.info('dns: starting with the last known configuration');
    return this._serial(() => this.dns.apply(dns));
  }

  /** Neue `features` aus dem Config-Pull anwenden (undefined = alter Server → alles aus). */
  apply(raw) {
    const f = normalizeFeatures(raw);
    this.features = f;
    this._timezone(f.timezone);
    this.netwatch.apply(f.netwatch);
    this.inetq.apply(f.inetq);
    this.presence.apply(f.presence);
    this.ups.apply(f.ups);
    if (this.stateDir) {
      writeJson(this.stateDir, BOOT_FILE, { timezone: f.timezone, dns: f.dns.enabled && raw && raw.dns ? raw.dns : null });
    }
    logger.info({
      netwatch: f.netwatch.enabled, portscan: f.netwatch.portscan, inetq: f.inetq.enabled,
      speedtest: f.inetq.speedtest, presence: f.presence.enabled, presenceMacs: f.presence.macs.length, ups: f.ups.enabled,
      dns: f.dns.enabled, dnsProfiles: f.dns.profiles.length, cache: f.cache.enabled, print: f.print.enabled,
      zigbee: f.radio.zigbee, zigbeeStack: f.radio.stack, ble: f.radio.ble, thread: f.radio.thread, ai: f.ai.enabled, aiSource: f.ai.source, cameras: f.cameras.enabled, cameraCount: f.cameras.cameras.length, timezone: f.timezone,
    }, 'features applied');
    return this._serial(async () => {
      await this.dns.apply(f.dns);
      await this.cache.apply(f.cache);
      await this.print.apply(f.print);
      await this.radio.apply(f.radio);
      await this.ai.apply(f.ai);
      await this.cameras.apply(f.cameras);
    });
  }

  stop() {
    for (const x of [this.netwatch, this.inetq, this.presence, this.ups, this.dns, this.cache, this.print, this.radio, this.ai, this.cameras]) {
      try { x.stop(); } catch (_e) { /* best effort */ }
    }
  }

  /** Telemetrie-Teile: { capabilities, features, ups, dns, cache, timezone, process_mem } (Drucken: nur features.print, die Geräte gehen als eigener Bericht) */
  telemetry() {
    const mem = process.memoryUsage();
    return {
      capabilities: [...CAPABILITIES],
      features: {
        netwatch: this.netwatch.telemetry(),
        inetq: this.inetq.telemetry(),
        presence: this.presence.telemetry(),
        ups: this.ups.featureTelemetry(),
        dns: this.dns.featureTelemetry(),
        cache: this.cache.featureTelemetry(),
        print: this.print.featureTelemetry(),
        radio: this.radio.featureTelemetry(),
        ai: this.ai.featureTelemetry(),
        cameras: this.cameras.featureTelemetry(),
      },
      ups: this.ups.telemetry(),
      dns: this.dns.telemetry(),
      cache: this.cache.telemetry(),
      timezone: timezoneTelemetry(),
      process_mem: { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external, arrayBuffers: mem.arrayBuffers },
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
  const dns = new DnsFilter({
    reporter, stateDir: config.stateDir, serverUrl: config.serverUrl, routerIp: defaultGatewayIp, tunnelIp: config.tunnelIp,
  });
  const cache = new HomeCache({
    reporter, serverUrl: config.serverUrl, apiToken: config.apiToken, stateDir: config.stateDir, tunnelIp: config.tunnelIp,
  });
  const print = new PrintService({
    reporter, serverUrl: config.serverUrl, apiToken: config.apiToken, stateDir: config.stateDir, getSubnets,
  });
  const radio = new RadioService({ reporter, stateDir: config.stateDir, serverUrl: config.serverUrl, apiToken: config.apiToken });
  const ai = new AiService({ stateDir: config.stateDir, serverUrl: config.serverUrl, apiToken: config.apiToken });
  const cameras = new CameraService({
    reporter, serverUrl: config.serverUrl, apiToken: config.apiToken, stateDir: config.stateDir, getSubnets,
  });
  return new FeatureManager({ netwatch, inetq, presence, ups, dns, cache, print, radio, ai, cameras, stateDir: config.stateDir });
}

module.exports = { FeatureManager, createFeatureManager, privateSubnets, CAPABILITIES };
