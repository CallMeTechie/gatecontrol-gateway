'use strict';

// Eine gemeinsame mDNS-Instanz des Edge-Hosts (multicast-dns, wie der
// LAN-Scan des Gateways): gc.lan.mdns.browse der Plugins und – mit dem
// MQTT-Broker – die Ankündigung von _mqtt._tcp. Bindet 0.0.0.0:5353 mit
// SO_REUSEADDR, verträgt sich also mit Avahi auf demselben Host.

const EventEmitter = require('node:events');
const { mapMdnsResponse } = require('../discovery/mdns');

const QUERY_EVERY_MS = 60000;

class MdnsService extends EventEmitter {
  constructor({ logger, factory, getInterface = null } = {}) {
    super();
    this.getInterface = getInterface; // IPv4 der LAN-Schnittstelle (sonst Standard-Route des Hosts)
    this.logger = logger || { debug() {}, warn() {} };
    this.factory = factory || ((opts) => require('multicast-dns')(opts));
    this.mdns = null;
    this.browses = new Map(); // id → { service, onFound, seen:Set }
    this.nextId = 0;
    this.timer = null;
    this.announcement = null; // { records } – Antwort auf passende Fragen
  }

  ensure() {
    if (this.mdns) return this.mdns;
    try {
      const iface = this.getInterface ? this.getInterface() : null;
      // bind 0.0.0.0: an die Unicast-Adresse gebunden kämen unter Linux keine Multicast-Pakete an
      this.mdns = this.factory({ multicast: true, reuseAddr: true, loopback: true, bind: '0.0.0.0', ...(iface ? { interface: iface } : {}) });
    } catch (e) {
      this.logger.warn({ err: e.message }, 'edge: mDNS not available');
      return null;
    }
    this.mdns.on('error', (e) => this.logger.debug({ err: e.message }, 'edge: mDNS error'));
    this.mdns.on('response', (packet) => this.onResponse(packet));
    this.mdns.on('query', (packet) => this.onQuery(packet));
    this.timer = setInterval(() => this.queryAll(), QUERY_EVERY_MS);
    if (this.timer.unref) this.timer.unref();
    return this.mdns;
  }

  onResponse(packet) {
    if (!this.browses.size) return;
    const found = mapMdnsResponse(packet);
    const txtByName = new Map();
    for (const r of [...(packet.answers || []), ...(packet.additionals || [])]) {
      if (r.type === 'TXT' && Array.isArray(r.data)) {
        txtByName.set(r.name, r.data.map((b) => Buffer.isBuffer(b) ? b.toString('utf8') : String(b)).slice(0, 32));
      }
    }
    for (const b of this.browses.values()) {
      for (const f of found) {
        if (f.mdnsType !== b.service) continue;
        const key = `${f.host}|${f.ip}|${f.port}`;
        if (b.seen.has(key)) continue;
        b.seen.add(key);
        const name = [...txtByName.keys()].find((n) => n.endsWith(`.${b.service}.local`)) || null;
        try { b.onFound({ host: f.host, ip: f.ip, port: f.port, service: b.service, txt: name ? txtByName.get(name) : [] }); } catch { /* Empfänger */ }
      }
    }
  }

  onQuery(packet) {
    const a = this.announcement;
    if (!a || !this.mdns) return;
    const asked = (packet.questions || []).some((q) => a.names.has(String(q.name).toLowerCase()));
    if (!asked) return;
    try { this.mdns.respond({ answers: a.answers, additionals: a.additionals }); } catch (e) { this.logger.debug({ err: e.message }, 'edge: mDNS respond failed'); }
  }

  query(service) {
    if (!this.mdns) return;
    try { this.mdns.query({ questions: [{ name: `${service}.local`, type: 'PTR' }] }); } catch { /* nächste Runde */ }
  }

  queryAll() {
    for (const s of new Set([...this.browses.values()].map((b) => b.service))) this.query(s);
  }

  browse(service, onFound) {
    if (!this.ensure()) throw Object.assign(new Error('mDNS not available'), { code: 'not_available' });
    const id = ++this.nextId;
    this.browses.set(id, { service, onFound, seen: new Set() });
    this.query(service);
    return id;
  }

  stopBrowse(id) {
    this.browses.delete(id);
    this.maybeClose();
  }

  /**
   * Dienst ankündigen (z. B. _mqtt._tcp). `records`: { instance, service, host, port, addresses[] } oder null.
   */
  announce(rec) {
    if (!rec) { this.announcement = null; this.maybeClose(); return; }
    const fqService = `${rec.service}.local`;
    const instance = `${rec.instance}.${fqService}`;
    const target = `${rec.host}.local`;
    const answers = [{ name: fqService, type: 'PTR', ttl: 120, data: instance }];
    const additionals = [
      { name: instance, type: 'SRV', ttl: 120, data: { port: rec.port, weight: 0, priority: 0, target } },
      { name: instance, type: 'TXT', ttl: 120, data: [] },
      ...rec.addresses.map((ip) => ({ name: target, type: 'A', ttl: 120, data: ip })),
    ];
    this.announcement = { answers, additionals, names: new Set([fqService.toLowerCase(), instance.toLowerCase(), '_services._dns-sd._udp.local']) };
    if (this.ensure()) {
      try { this.mdns.respond({ answers, additionals }); } catch { /* bei der nächsten Frage */ }
    }
  }

  maybeClose() {
    if (this.browses.size || this.announcement || !this.mdns) return;
    this.close();
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.mdns) { try { this.mdns.destroy(); } catch { /* zu */ } }
    this.mdns = null;
  }
}

module.exports = { MdnsService };
