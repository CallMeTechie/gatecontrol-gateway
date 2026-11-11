'use strict';

// Einrichtungsseite (docs/setup-page.md): wer darf sie erreichen, und wie
// werden Serveradresse und Einrichtungscode geprüft. Alles hier ist Eingabe
// aus dem Heimnetz und wird streng behandelt.

const net = require('node:net');

/** IPv4 als Zahl oder null. */
function ipv4ToInt(ip) {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}

function inV4(ip, base, prefix) {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (a & mask) === (b & mask);
}

/** `::ffff:192.168.1.2` → `192.168.1.2`, Zonen-Suffix (`%eth0`) weg. */
function normalizeAddress(addr) {
  if (typeof addr !== 'string') return '';
  let a = addr.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return m ? m[1] : a;
}

/** Loopback, privat (RFC 1918), Link-lokal; IPv6: ::1, fe80::/10, fc00::/7. */
function addressKind(addr) {
  const a = normalizeAddress(addr);
  if (net.isIPv4(a)) {
    if (inV4(a, '127.0.0.0', 8)) return 'loopback';
    if (inV4(a, '10.0.0.0', 8) || inV4(a, '172.16.0.0', 12) || inV4(a, '192.168.0.0', 16)) return 'private';
    if (inV4(a, '169.254.0.0', 16)) return 'link-local';
    return 'public';
  }
  if (net.isIPv6(a)) {
    if (a === '::1') return 'loopback';
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xffc0) === 0xfe80) return 'link-local';
    if ((first & 0xfe00) === 0xfc00) return 'private';
    return 'public';
  }
  return 'invalid';
}

/** CIDR-Liste (`10.8.0.5/32, 10.8.0.0/24`) → [{ base, prefix }], nur IPv4. */
function parseCidrs(list) {
  const out = [];
  for (const part of String(list || '').split(',')) {
    const [base, p] = part.trim().split('/');
    if (!net.isIPv4(base)) continue;
    const prefix = p === undefined ? 32 : Number(p);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) continue;
    out.push({ base, prefix });
  }
  return out;
}

/**
 * Darf diese Verbindung die Seite sehen? Nur Heimnetz: private und
 * Link-lokale Absender (und der Rechner selbst), nie Adressen des Tunnels und
 * nie über die Tunnel-Adresse des Gateways.
 *
 * @param {{ remote: string, local?: string }} conn
 * @param {{ tunnelIp?: string|null, tunnelCidrs?: {base:string,prefix:number}[] }} [tunnel]
 */
function isLanPeer(conn, tunnel = {}) {
  const remote = normalizeAddress(conn.remote);
  const kind = addressKind(remote);
  if (kind !== 'private' && kind !== 'link-local' && kind !== 'loopback') return false;
  const local = normalizeAddress(conn.local || '');
  if (tunnel.tunnelIp && local === tunnel.tunnelIp) return false;
  for (const c of tunnel.tunnelCidrs || []) {
    // 0.0.0.0/0 (alles durch den Tunnel) sagt nichts über den Absender
    if (c.prefix >= 8 && inV4(remote, c.base, c.prefix)) return false;
  }
  return true;
}

// Namen, unter denen ein Gerät im Heimnetz üblich erreichbar ist. Keine
// öffentlichen Endungen: sonst ließe sich die Seite per DNS-Rebinding von einer
// fremden Website aus ansprechen.
const LOCAL_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localdomain'];
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Host-Kopfzeile: nur IP-Adressen des Heimnetzes oder lokale Namen
 * (`gatecontrol.local`, `nas`, …) plus die in GC_SETUP_ALLOWED_HOSTS genannten.
 */
function isAllowedHost(hostHeader, extra = []) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0 || hostHeader.length > 255) return false;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return false;
    const rest = host.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return false;
    const kind = addressKind(host.slice(1, end));
    return kind === 'private' || kind === 'link-local' || kind === 'loopback';
  }
  const colon = host.lastIndexOf(':');
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(host.slice(colon + 1))) return false;
    host = host.slice(0, colon);
  }
  if (net.isIPv4(host)) {
    const kind = addressKind(host);
    return kind === 'private' || kind === 'link-local' || kind === 'loopback';
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host || !host.split('.').every((l) => LABEL_RE.test(l))) return false;
  if (extra.includes(host)) return true;
  if (!host.includes('.')) return true; // einzelner Name (nas, localhost)
  return LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

const CODE_RE = /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/;

/**
 * Einrichtungscode normalisieren. Akzeptiert Kleinbuchstaben, Leerzeichen und
 * fehlende Bindestriche; die alte Form `CODE@host` liefert zusätzlich `host`.
 * @returns {{ code: string, host: string|null } | null}
 */
function parseCode(input) {
  if (typeof input !== 'string' || input.length > 400) return null;
  let s = input.trim();
  let host = null;
  const at = s.indexOf('@');
  if (at >= 0) { host = s.slice(at + 1).trim() || null; s = s.slice(0, at); }
  const hex = s.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(hex)) return null;
  const code = `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
  return CODE_RE.test(code) ? { code, host } : null;
}

/**
 * Serveradresse bereinigen: `gate.example.de`, `https://gate.example.de/login`,
 * `gate.example.de:8443`. Ergebnis ist immer https; http wird nicht verwendet.
 * @returns {{ host: string, port: number, display: string, origin: string } | null}
 */
function parseServer(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length > 300) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (/[\s@\\]/.test(s.split(/[/?#]/)[0])) return null;
  let url;
  try { url = new URL(`https://${s}`); } catch { return null; }
  if (url.username || url.password) return null;
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  const v6 = host.startsWith('[');
  if (v6) {
    if (!net.isIPv6(host.slice(1, -1))) return null;
  } else if (!net.isIPv4(host)) {
    if (host.length > 253 || !host.includes('.') || !host.split('.').every((l) => LABEL_RE.test(l))) return null;
  }
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const display = port === 443 ? host : `${host}:${port}`;
  return { host: v6 ? host.slice(1, -1) : host, port, display, origin: `https://${display}` };
}

module.exports = {
  normalizeAddress, addressKind, parseCidrs, isLanPeer, isAllowedHost, parseCode, parseServer, CODE_RE,
};
