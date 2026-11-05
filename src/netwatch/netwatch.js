'use strict';

// Netzwerk-Wächter (Vertrag Phase 3a, Abschnitt 2): alle 5 Min. die eigenen
// LAN-Subnetze absuchen, Namen und Hersteller ermitteln, neue Geräte sofort
// und alle Geräte einmal nachts auf offene Ports prüfen und dem Server
// berichten (vollständig höchstens alle 30 Min., sonst nur Änderungen).
// Gerätezustand liegt in /state/netwatch.json (firstSeen überlebt Neustarts).

const os = require('node:os');
const dns = require('node:dns');
const logger = require('../logger');
const { FeatureStatus, loop } = require('../features/status');
const { readJson, writeJson } = require('../features/persist');
const { nextNightly } = require('../features/schedule');
const { normalizeMac } = require('../features/config');
const { hostsInSubnet } = require('../discovery/tcpSweep');
const { isPrivateIpv4 } = require('../discovery/lanInterfaces');
const { cleanHostname } = require('./scanner');
const { scanPorts } = require('./ports');

const STATE_FILE = 'netwatch.json';
const INTERVAL_MS = 5 * 60_000;
const FIRST_RUN_MS = 20_000;
const FULL_EVERY_MS = 30 * 60_000;
const PERSIST_EVERY_MS = 30 * 60_000;
const NAMES_REFRESH_MS = 6 * 3600_000;
const FORGET_AFTER_MS = 30 * 24 * 3600_000;
const MAX_DEVICES = 1024;
const MAX_PORTS = 64;
const REPORT_PATH = '/api/v1/gateway/netwatch';

/** Locally-administered-Bit (zweitniedrigstes Bit des ersten Oktetts) = zufällige/private MAC. */
function isRandomMac(mac) {
  return (parseInt(String(mac).slice(0, 2), 16) & 0x02) === 0x02;
}

function ownIpv4s(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const addrs of Object.values(ifaces || {})) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/**
 * Zu prüfende Hosts eines Subnetzes. Größer als `maxPrefix` (Standard /22):
 * nur das /24 um die eigene Adresse – ein /16 abzuklopfen wäre zu viel Last.
 */
function hostsFor(cidr, { maxPrefix = 22, localIp = null } = {}) {
  const prefix = Number(String(cidr).split('/')[1]);
  if (prefix >= maxPrefix) return hostsInSubnet(cidr);
  if (!localIp) return [];
  return hostsInSubnet(localIp.split('.').slice(0, 3).join('.') + '.0/24');
}

function makeReverseDns({ timeoutMs = 1500 } = {}) {
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  return async (ip) => {
    try { return cleanHostname((await resolver.reverse(ip))[0]); } catch (_e) { return null; }
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const wire = (d) => ({
  mac: d.mac, ip: d.ip, vendor: d.vendor, hostname: d.hostname, nameSource: d.nameSource,
  randomMac: d.randomMac, online: d.online, firstSeen: d.firstSeen, lastSeen: d.lastSeen, ports: d.ports,
});
const sig = (d) => JSON.stringify([d.ip, d.vendor, d.hostname, d.nameSource, d.randomMac, d.online, d.firstSeen, d.ports]);

class NetWatch {
  /**
   * @param {object} o
   * @param {object} o.scanner   createScanner()
   * @param {object} o.oui       makeOuiLookup()
   * @param {object} o.reporter  makeReporter()
   * @param {Function} o.getSubnets  () → [{ cidr, localIp }] (eigene private LAN-Subnetze)
   */
  constructor({
    scanner, oui, reporter, stateDir, tunnelIp, getSubnets, maxPrefix = 22,
    reverseDns = makeReverseDns(), portScanner = scanPorts, ownIps = ownIpv4s,
    now = Date.now, rand = Math.random, intervalMs = INTERVAL_MS, firstRunMs = FIRST_RUN_MS,
  }) {
    Object.assign(this, { scanner, oui, reporter, stateDir, tunnelIp, getSubnets, maxPrefix, reverseDns, portScanner, ownIps, now, rand });
    this.status = new FeatureStatus(now);
    this.cfg = { enabled: false, portscan: false };
    this.devices = new Map();
    this.sent = new Map();
    this.forceFull = true;
    this.lastFullAt = null;
    this.lastPortscanAt = null;
    this.nextPortscanAt = null;
    this.lastPersistAt = 0;
    this.loaded = false;
    this.busy = false;
    this.firstRunMs = firstRunMs;
    this.loop = loop(() => this.run({ reason: 'interval' }), () => intervalMs);
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    const s = readJson(this.stateDir, STATE_FILE);
    if (!s || !Array.isArray(s.devices)) return;
    for (const d of s.devices.slice(0, MAX_DEVICES)) {
      const mac = normalizeMac(d && d.mac);
      if (!mac || typeof d.ip !== 'string' || !isPrivateIpv4(d.ip)) continue;
      this.devices.set(mac, {
        mac, ip: d.ip,
        vendor: typeof d.vendor === 'string' ? d.vendor : null,
        hostname: typeof d.hostname === 'string' ? d.hostname : null,
        nameSource: typeof d.nameSource === 'string' ? d.nameSource : null,
        randomMac: isRandomMac(mac),
        online: false,
        firstSeen: Number(d.firstSeen) || this.now(),
        lastSeen: Number(d.lastSeen) || this.now(),
        ports: Array.isArray(d.ports) ? d.ports.slice(0, MAX_PORTS) : null,
        namesAt: Number(d.namesAt) || null,
      });
    }
    this.lastPortscanAt = Number(s.lastPortscanAt) || null;
    this.nextPortscanAt = Number(s.nextPortscanAt) || null;
  }

  _persist(force) {
    const now = this.now();
    if (!force && now - this.lastPersistAt < PERSIST_EVERY_MS) return;
    this.lastPersistAt = now;
    writeJson(this.stateDir, STATE_FILE, {
      v: 1,
      devices: [...this.devices.values()],
      lastPortscanAt: this.lastPortscanAt,
      nextPortscanAt: this.nextPortscanAt,
    });
  }

  apply({ enabled, portscan }) {
    const was = this.cfg.enabled;
    this.cfg = { enabled: !!enabled, portscan: !!portscan };
    this.status.setEnabled(this.cfg.enabled);
    if (this.cfg.enabled && !was) {
      this._load();
      this.forceFull = true;
      this.loop.start(this.firstRunMs);
    } else if (!this.cfg.enabled && was) {
      this.loop.stop();
      this._persist(true);
    }
    if (this.cfg.portscan && !this.nextPortscanAt) this.nextPortscanAt = nextNightly(this.now(), this.rand);
  }

  stop() {
    this.loop.stop();
    if (this.loaded) this._persist(true);
  }

  /** Bekannte IP einer MAC (für die Anwesenheit), sonst null. */
  knownIp(mac) {
    const d = this.devices.get(mac);
    return d ? d.ip : null;
  }

  /** „Jetzt scannen“ (Mgmt-API). → 'accepted' | 'busy' | 'disabled' */
  requestScan({ ports = false } = {}) {
    if (!this.cfg.enabled) return 'disabled';
    if (this.busy) return 'busy';
    this.run({ reason: 'manual', portsAll: ports === true }).catch(() => {});
    return 'accepted';
  }

  async _names(found, now) {
    const need = [];
    for (const [mac, f] of found) {
      const d = this.devices.get(mac);
      if (f.name) continue;
      if (d.nameSource === 'mdns' && d.hostname) continue; // mDNS-Name wird nur durch mDNS ersetzt
      if (d.hostname && d.namesAt && now - d.namesAt < NAMES_REFRESH_MS) continue;
      need.push({ d, ip: f.ip });
    }
    if (!need.length) return;
    let nb = new Map();
    try { nb = await this.scanner.netbiosNames(need.map((x) => x.ip)); } catch (_e) { /* best effort */ }
    const rest = need.filter((x) => !nb.has(x.ip));
    const rdns = await mapLimit(rest, 8, (x) => this.reverseDns(x.ip));
    rest.forEach((x, i) => { if (rdns[i]) { x.d.hostname = rdns[i]; x.d.nameSource = 'dns'; } });
    for (const x of need) {
      if (nb.has(x.ip)) { x.d.hostname = nb.get(x.ip); x.d.nameSource = 'netbios'; }
      x.d.namesAt = now;
    }
  }

  async _ports({ portsAll, now }) {
    if (!this.cfg.portscan) return false;
    const nightly = this.nextPortscanAt !== null && now >= this.nextPortscanAt;
    const online = [...this.devices.values()].filter((d) => d.online);
    const targets = online.filter((d) => portsAll || nightly || d.ports === null);
    if (!targets.length && !nightly) return false;
    const res = await this.portScanner(targets.map((d) => d.ip), { tunnelIp: this.tunnelIp, ownIps: this.ownIps() });
    for (const d of targets) if (res.has(d.ip)) d.ports = res.get(d.ip).slice(0, MAX_PORTS);
    if (nightly) {
      this.lastPortscanAt = now;
      this.nextPortscanAt = nextNightly(now, this.rand);
    }
    return targets.length > 0;
  }

  _prune(now) {
    for (const [mac, d] of this.devices) if (now - d.lastSeen > FORGET_AFTER_MS) this.devices.delete(mac);
    if (this.devices.size > MAX_DEVICES) {
      const keep = [...this.devices.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_DEVICES);
      this.devices = new Map(keep.map((d) => [d.mac, d]));
    }
  }

  async _report(scanAt) {
    const full = this.forceFull || this.lastFullAt === null || scanAt - this.lastFullAt >= FULL_EVERY_MS;
    const list = [...this.devices.values()];
    const devs = full ? list : list.filter((d) => this.sent.get(d.mac) !== sig(d));
    const res = await this.reporter.post(REPORT_PATH, { scanAt, full, devices: devs.map(wire) });
    if (!res.ok) {
      this.forceFull = true;
      throw new Error(`report failed${res.status ? `: HTTP ${res.status}` : `: ${res.error}`}`);
    }
    if (full) { this.sent.clear(); this.lastFullAt = scanAt; this.forceFull = false; }
    for (const d of devs) this.sent.set(d.mac, sig(d));
  }

  async run({ reason = 'interval', portsAll = false } = {}) {
    if (!this.cfg.enabled || this.busy) return false;
    this.busy = true;
    this.status.start();
    try {
      this._load();
      const now = this.now();
      const found = new Map();
      const subnets = (this.getSubnets() || []).filter((s) => isPrivateIpv4(String(s.cidr).split('/')[0]));
      const own = new Set(this.ownIps());
      for (const sn of subnets) {
        const hosts = hostsFor(sn.cidr, { maxPrefix: this.maxPrefix, localIp: sn.localIp })
          .filter((h) => !own.has(h) && h !== this.tunnelIp);
        if (!hosts.length) continue;
        const { online, names } = await this.scanner.sweep(hosts, { bindIp: sn.localIp || undefined });
        for (const [ip, mac] of online) if (!found.has(mac)) found.set(mac, { ip, name: names.get(ip) || null });
      }
      let structural = false;
      for (const [mac, f] of found) {
        let d = this.devices.get(mac);
        if (!d) {
          d = {
            mac, ip: f.ip, vendor: this.oui.lookup(mac), hostname: null, nameSource: null,
            randomMac: isRandomMac(mac), online: true, firstSeen: now, lastSeen: now, ports: null, namesAt: null,
          };
          this.devices.set(mac, d);
          structural = true;
        }
        if (d.ip !== f.ip) structural = true;
        d.ip = f.ip;
        d.online = true;
        d.lastSeen = now;
        if (f.name) { d.hostname = f.name; d.nameSource = 'mdns'; d.namesAt = now; }
      }
      for (const d of this.devices.values()) if (!found.has(d.mac)) d.online = false;
      await this._names(found, now);
      if (await this._ports({ portsAll, now })) structural = true;
      this._prune(now);
      this._persist(structural);
      await this._report(now);
      this.status.ok();
      logger.debug({ reason, devices: this.devices.size, online: found.size }, 'netwatch: sweep done');
      return true;
    } catch (err) {
      this.status.fail(err);
      logger.warn({ err: err.message, reason }, 'netwatch: run failed');
      return false;
    } finally {
      this.busy = false;
    }
  }

  telemetry() {
    let online = 0;
    for (const d of this.devices.values()) if (d.online) online++;
    return this.status.snapshot({
      running: this.busy,
      devices: this.devices.size,
      online,
      lastFullReportAt: this.lastFullAt,
      lastPortscanAt: this.lastPortscanAt,
      nextPortscanAt: this.cfg.portscan ? this.nextPortscanAt : null,
      degraded: this.scanner.mode && this.scanner.mode() === 'proc' ? 'no_neighbor_states' : null,
    });
  }
}

module.exports = { NetWatch, isRandomMac, hostsFor, ownIpv4s, REPORT_PATH };
