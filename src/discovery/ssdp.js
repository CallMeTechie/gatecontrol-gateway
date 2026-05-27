'use strict';

const dgram = require('node:dgram');
const logger = require('../logger');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function _header(raw, name) {
  const re = new RegExp('^' + name + ':\\s*(.+)$', 'im');
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

// Parse a raw SSDP/HTTPU response into { location, st, server }.
function parseSsdpResponse(raw) {
  return { location: _header(raw, 'LOCATION'), st: _header(raw, 'ST'), server: _header(raw, 'SERVER') };
}

// Extract { host, port } from a LOCATION URL. We DO NOT fetch the URL (SSRF).
function locationHostPort(url) {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return { host: u.hostname, port };
  } catch (_e) { return null; }
}

// Send an M-SEARCH on the given LAN interface and collect responses for a window.
// Bound to a specific interface IP so multicast leaves the LAN, not wg0/docker.
// Returns [{ host, port, st, server }]. Thin wrapper — covered by smoke, not unit.
function discoverSsdp({ ifaceIp, timeoutMs = 4000, mx = 2 }) {
  return new Promise(resolve => {
    const out = [];
    if (!ifaceIp) return resolve(out); // never bind multicast to 0.0.0.0/wg0 (spec §4.2)
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ssdp:all\r\n\r\n`);
    sock.on('error', (err) => { logger.debug({ err: err.message }, 'ssdp socket error'); try { sock.close(); } catch (_e) { /* already closed */ } resolve(out); });
    sock.on('message', (buf) => {
      const r = parseSsdpResponse(buf.toString());
      const hp = r.location ? locationHostPort(r.location) : null;
      if (hp) out.push({ host: hp.host, port: hp.port, st: r.st, server: r.server });
    });
    sock.bind(0, ifaceIp, () => {
      try { sock.setMulticastInterface(ifaceIp); } catch (_e) { /* optional, ignore if unsupported */ }
      sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR);
    });
    setTimeout(() => { try { sock.close(); } catch (_e) { /* already closed */ } resolve(out); }, timeoutMs);
  });
}

module.exports = { parseSsdpResponse, locationHostPort, discoverSsdp };
