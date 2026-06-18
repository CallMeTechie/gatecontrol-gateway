'use strict';

const net = require('node:net');
const logger = require('../logger');

const DUAL_BIND_OVERLAP_MS = 10_000;

/** Strip the IPv4-mapped-IPv6 prefix from a socket remoteAddress. */
function normalizeIp(addr) {
  if (!addr) return addr;
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** IPv4 dotted-quad → 32-bit unsigned int, or null if not a valid IPv4. */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/**
 * Source-lock check: is `remoteAddr` inside any CIDR in `allowedCidrs`?
 * Empty/missing allowlist ⇒ DENY (default-deny — an egress door must never
 * accept an unconfigured source).
 */
function ipInAllowlist(remoteAddr, allowedCidrs) {
  if (!Array.isArray(allowedCidrs) || allowedCidrs.length === 0) return false;
  const ip = ipv4ToInt(normalizeIp(remoteAddr));
  if (ip === null) return false;
  for (const cidr of allowedCidrs) {
    const [base, prefixStr] = String(cidr).split('/');
    const prefix = prefixStr === undefined ? 32 : parseInt(prefixStr, 10);
    const baseInt = ipv4ToInt(base);
    if (baseInt === null || !(prefix >= 0 && prefix <= 32)) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((ip & mask) === (baseInt & mask)) return true;
  }
  return false;
}

module.exports = { ipInAllowlist, normalizeIp, DUAL_BIND_OVERLAP_MS };
