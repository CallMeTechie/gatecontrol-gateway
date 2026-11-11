'use strict';

// mDNS-Name des Gateways für die Telemetrie (`telemetry.mdns_name`, z. B.
// "pi-keller.local") – der Server zeigt ihn als zweite Adresse des Gateways im
// Heimnetz (Karte „MQTT-Broker“). Gemeldet wird der Name nur, wenn er im LAN
// wirklich aufgelöst wird: das Gateway fragt alle paar Minuten per mDNS nach
// <Rechnername>.local und meldet ihn, sobald eine Antwort mit einer eigenen
// LAN-Adresse kommt (Avahi/Bonjour des Hosts: Pi-Image, Synology, viele
// Linux-Rechner). Ohne Antwort – Bridge-Netz, kein mDNS-Dienst auf dem Host –
// bleibt das Feld null.

const os = require('node:os');
const { isPhysicalLan } = require('../discovery/lanInterfaces');

const PROBE_EVERY_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 2500;
const KEEP_MS = 3 * PROBE_EVERY_MS; // so lange gilt eine Antwort ohne neue Bestätigung
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Rechnername → "name.local" (erstes Label, klein) oder null, wenn er kein gültiges Label ist. */
function mdnsNameOf(hostname) {
  const label = String(hostname || '').split('.')[0].toLowerCase();
  return LABEL_RE.test(label) && label !== 'localhost' ? `${label}.local` : null;
}

/** Eigene Adressen auf den LAN-Schnittstellen (IPv4 und IPv6 ohne Zone, klein). */
function ownLanAddresses(ifaces = os.networkInterfaces()) {
  const out = new Set();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!isPhysicalLan(name)) continue;
    for (const a of addrs || []) if (a && !a.internal && a.address) out.add(String(a.address).split('%')[0].toLowerCase());
  }
  return out;
}

class MdnsNameProbe {
  /**
   * @param {object} o
   * @param {() => string} [o.hostname]      Rechnername
   * @param {() => Set<string>} [o.addresses] eigene LAN-Adressen
   * @param {() => string|null} [o.getInterface] IPv4 der LAN-Schnittstelle (ohne: keine Abfrage)
   * @param {(opts) => object} [o.factory]   multicast-dns
   */
  constructor({ hostname = os.hostname, addresses = ownLanAddresses, getInterface = () => null, factory, now = Date.now, logger,
    everyMs = PROBE_EVERY_MS, timeoutMs = PROBE_TIMEOUT_MS, keepMs = KEEP_MS } = {}) {
    Object.assign(this, { hostname, addresses, getInterface, now, everyMs, timeoutMs, keepMs });
    this.factory = factory || ((opts) => require('multicast-dns')(opts));
    this.logger = logger || { debug() {} };
    this.name = null;
    this.seenAt = 0;
    this.lastProbeAt = null;
    this.probing = false;
  }

  /** Der zuletzt bestätigte Name (null: keiner) – stößt bei Bedarf die nächste Abfrage an, wartet nie. */
  current() {
    const now = this.now();
    if (!this.probing && (this.lastProbeAt === null || now - this.lastProbeAt >= this.everyMs)) {
      this.lastProbeAt = now;
      this.probe().catch(() => {});
    }
    if (this.name && now - this.seenAt > this.keepMs) this.name = null;
    return this.name;
  }

  /** Eine Abfrage: A/AAAA für <Rechnername>.local; → der bestätigte Name oder null. */
  probe() {
    const name = mdnsNameOf(this.hostname());
    const iface = name ? this.getInterface() : null;
    if (!name || !iface) return Promise.resolve(null);
    this.probing = true;
    return new Promise((resolve) => {
      let mdns = null;
      let timer = null;
      let settled = false;
      const finish = (found) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (mdns) { try { mdns.destroy(); } catch (_e) { /* zu */ } }
        this.probing = false;
        if (found) { this.name = name; this.seenAt = this.now(); }
        resolve(found ? name : null);
      };
      try {
        // bind 0.0.0.0 + reuseAddr: verträgt sich mit Avahi und dem Edge-Host auf demselben Rechner
        mdns = this.factory({ multicast: true, reuseAddr: true, loopback: true, bind: '0.0.0.0', interface: iface });
      } catch (e) {
        this.logger.debug({ err: e.message }, 'mdns name: mDNS not available');
        finish(false);
        return;
      }
      mdns.on('error', (e) => { this.logger.debug({ err: e.message }, 'mdns name: probe failed'); finish(false); });
      mdns.on('response', (packet) => {
        const own = this.addresses();
        for (const r of [...((packet && packet.answers) || []), ...((packet && packet.additionals) || [])]) {
          if (!r || (r.type !== 'A' && r.type !== 'AAAA') || String(r.name).toLowerCase() !== name) continue;
          if (typeof r.data === 'string' && own.has(r.data.toLowerCase())) { finish(true); return; }
        }
      });
      timer = setTimeout(() => finish(false), this.timeoutMs);
      if (timer.unref) timer.unref();
      try { mdns.query({ questions: [{ name, type: 'A' }, { name, type: 'AAAA' }] }); } catch (_e) { finish(false); }
    });
  }
}

module.exports = { MdnsNameProbe, mdnsNameOf, ownLanAddresses };
