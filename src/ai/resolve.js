'use strict';

// Namen eines KI-Servers im LAN auflösen (docs/local-ai.md §3): erst beim
// Verbinden, auf dem Gateway – es steht im selben Heimnetz. `.local` fragt
// per mDNS (das Gateway-Image hat kein nss-mdns), sonst der DNS des Hosts
// (z. B. die FRITZ!Box für pc.fritz.box). Verbunden wird nur an private
// Adressen (RFC 1918, fc00::/7); löst ein Name nur öffentlich auf, gibt es
// `not_private` – kein Weg ins Internet über diesen Namen (auch nicht durch
// DNS-Rebinding: die geprüfte Adresse ist die, an die verbunden wird).

const dns = require('node:dns');
const net = require('node:net');
const { isLanAddress } = require('./config');

const DNS_CACHE_MS = 60_000;
const MDNS_CACHE_MS = 5 * 60_000;
const MDNS_TIMEOUT_MS = 3000;
const MAX_CACHE = 16;

function err(code, message) { return Object.assign(new Error(message || code), { code }); }

/** Eine mDNS-Frage nach A/AAAA → Adressen (leer, wenn niemand antwortet). */
function mdnsQuery(name, { timeoutMs = MDNS_TIMEOUT_MS, factory = (o) => require('multicast-dns')(o) } = {}) {
  return new Promise((resolve) => {
    let m;
    try { m = factory({ multicast: true }); } catch { resolve([]); return; }
    const out = new Set();
    let timer = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { m.destroy(); } catch { /* zu */ }
      resolve([...out]);
    };
    m.on('error', () => done());
    m.on('response', (p) => {
      const recs = [...((p && p.answers) || []), ...((p && p.additionals) || [])];
      for (const a of recs) {
        if (!a || typeof a.name !== 'string' || a.name.toLowerCase() !== name) continue;
        if ((a.type === 'A' || a.type === 'AAAA') && typeof a.data === 'string' && net.isIP(a.data)) out.add(a.data);
      }
      // die erste Antwort genügt; kurz auf die zweite Adressart warten
      if (out.size) setTimeout(done, 150);
    });
    timer = setTimeout(done, timeoutMs);
    try { m.query({ questions: [{ name, type: 'A' }, { name, type: 'AAAA' }] }); } catch { done(); }
  });
}

function createResolver({ lookup = dns.promises.lookup, mdns = mdnsQuery, now = Date.now } = {}) {
  const cache = new Map(); // host → { addrs, until }

  /** host (Name oder IP) → private Adressen (IPv4 zuerst); wirft unreachable | not_private. */
  async function resolve(host) {
    if (net.isIP(host)) {
      if (!isLanAddress(host)) throw err('not_private', 'not an address in the home network');
      return [host];
    }
    const hit = cache.get(host);
    if (hit && hit.until > now()) return hit.addrs;
    let all = [];
    let viaMdns = false;
    if (host.endsWith('.local')) {
      try { all = await mdns(host); viaMdns = all.length > 0; } catch { all = []; }
    }
    if (!all.length) {
      try { all = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address); } catch { all = []; }
    }
    if (!all.length) throw err('unreachable', 'name not found in the home network');
    const lan = all.filter(isLanAddress).sort((a, b) => net.isIP(a) - net.isIP(b));
    if (!lan.length) throw err('not_private', 'the name points outside the home network');
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(host, { addrs: lan, until: now() + (viaMdns ? MDNS_CACHE_MS : DNS_CACHE_MS) });
    return lan;
  }

  /** lookup() für http/https: nur die geprüften Adressen (Node fragt mit und ohne all). */
  function lookupFor(host) {
    return (hostname, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      resolve(host).then((addrs) => {
        const list = addrs.map((address) => ({ address, family: net.isIP(address) }));
        if (opts && opts.all) cb(null, list);
        else cb(null, list[0].address, list[0].family);
      }, (e) => cb(e));
    };
  }

  function forget(host) { cache.delete(host); }

  return { resolve, lookupFor, forget };
}

module.exports = { createResolver, mdnsQuery };
