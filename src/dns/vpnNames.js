'use strict';

// „Namen im VPN“ im Heimnetz: Der Server nennt im Config-Pull die Zonen, in
// denen die VPN-Geräte heißen (`features.internal_dns`: server, domains,
// primary, resolve – z. B. vpn.example.com und gc.internal). Der DNS-Filter
// behandelt genau diese Zonen gesondert:
//
//   resolve = true   Fragen gehen durch den Tunnel an den DNS des Servers
//   resolve = false  das Gateway antwortet selbst „gibt es nicht“ (NXDOMAIN)
//
// In keinem Fall erreicht eine Frage nach einer dieser Zonen den Router oder
// einen öffentlichen Resolver: Gerätenamen bleiben im Haus, und für die eigene
// Domain käme sonst die Antwort der öffentlichen Zone zurück.
//
// Fehlt `internal_dns` (älterer Server), gibt es keine Zonen – alles wie zuvor.
// Alles hier ist Server-Eingabe und wird geprüft.

const net = require('node:net');
const { cleanDomain, routerQuery, UpstreamError } = require('../dnsfilter-core');
const { isPrivateIpv4, ipInCidr } = require('../discovery/lanInterfaces');

const MAX_ZONES = 8;
const QUERY_TIMEOUT_MS = 1500;
const DOWN_AFTER = 2;
const DOWN_MS = 30_000;

/** Adresse, wie sie ein VPN-Netz vergibt: privat (RFC 1918) oder 100.64.0.0/10 (RFC 6598). */
function isTunnelAddress(ip) {
  return typeof ip === 'string' && net.isIPv4(ip) && (isPrivateIpv4(ip) || ipInCidr(ip, '100.64.0.0', 10));
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `features.internal_dns` → { server, domains, primary, forward } oder null
 * (fehlt, kaputt oder keine gültige Zone). Zonen: echte Domains mit Punkt,
 * kleingeschrieben, ohne Doppelte, höchstens MAX_ZONES. `server`: eine Adresse,
 * wie sie ein VPN-Netz vergibt, sonst null (dann wird nie weitergeleitet).
 */
function normalizeInternalDns(raw) {
  if (!isObj(raw) || !Array.isArray(raw.domains)) return null;
  const domains = [];
  for (const d of raw.domains.slice(0, MAX_ZONES * 4)) {
    const c = cleanDomain(d);
    if (c && !domains.includes(c) && domains.length < MAX_ZONES) domains.push(c);
  }
  if (!domains.length) return null;
  const server = isTunnelAddress(raw.server) ? raw.server : null;
  const p = cleanDomain(raw.primary);
  return { server, domains, primary: p && domains.includes(p) ? p : domains[0], forward: raw.resolve === true };
}

/** 'a.b.c.d/n[, …]' → [{ network, prefix }] (nur gültige IPv4-Netze). */
function parseCidrs(text) {
  const out = [];
  for (const part of String(text || '').split(',')) {
    const [network, bits, ...rest] = part.trim().split('/');
    const prefix = Number(bits);
    if (rest.length || !net.isIPv4(network) || !/^\d{1,2}$/.test(bits || '') || prefix > 32) continue;
    out.push({ network, prefix });
  }
  return out;
}

/**
 * Fragt den DNS des Servers – nur durch den Tunnel:
 *   - die Adresse muss in einem Netz liegen, das der Tunnel routet (AllowedIPs),
 *   - der Absender wird an die eigene Tunnel-Adresse gebunden: Gibt es den
 *     Tunnel nicht, scheitert die Anfrage sofort, statt über die Standardroute
 *     zum Router zu gehen.
 * Nach DOWN_AFTER Fehlern in Folge gilt der Weg DOWN_MS lang als gestört:
 * Anfragen scheitern dann sofort (der Filter antwortet SERVFAIL), danach wird
 * wieder versucht. Kein Rückfall auf einen anderen Resolver.
 */
class VpnNamesForwarder {
  constructor({ tunnelIp = null, allowedIps = '', queryFn = routerQuery, now = Date.now, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
    Object.assign(this, { tunnelIp, queryFn, now, timeoutMs });
    this.routes = parseCidrs(allowedIps);
    this.server = null;
    this.state = { lastOkAt: null, lastError: null, failures: 0, downUntil: 0 };
    this.streak = 0;
  }

  /** Liegt die Adresse hinter dem Tunnel (und ist nicht die eigene)? */
  reachable(server) {
    return !!server && !!this.tunnelIp && server !== this.tunnelIp && this.routes.some((r) => ipInCidr(server, r.network, r.prefix));
  }

  setServer(server) {
    if (server === this.server) return;
    this.server = server;
    this.streak = 0;
    this.state = { lastOkAt: null, lastError: null, failures: 0, downUntil: 0 };
  }

  _fail(code) {
    this.state.failures++;
    this.state.lastError = { at: this.now(), code };
    if (++this.streak >= DOWN_AFTER) { this.state.downUntil = this.now() + DOWN_MS; this.streak = 0; }
  }

  /** → { wire, via: 'tunnel' } oder wirft UpstreamError. */
  async query(wire) {
    if (!this.reachable(this.server)) throw new UpstreamError('no_tunnel_route');
    if (this.state.downUntil > this.now()) throw new UpstreamError('tunnel_dns_down');
    try {
      const r = await this.queryFn(this.server, wire, { timeoutMs: this.timeoutMs, localAddress: this.tunnelIp });
      this.state.lastOkAt = this.now();
      this.streak = 0;
      return { wire: r, via: 'tunnel' };
    } catch (err) {
      this._fail(err.code || 'error');
      throw err;
    }
  }

  telemetry() {
    return { lastOkAt: this.state.lastOkAt, lastError: this.state.lastError, failures: this.state.failures, down: this.state.downUntil > this.now() };
  }
}

module.exports = { normalizeInternalDns, parseCidrs, isTunnelAddress, VpnNamesForwarder, MAX_ZONES, QUERY_TIMEOUT_MS, DOWN_AFTER, DOWN_MS };
