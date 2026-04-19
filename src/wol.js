'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const net = require('node:net');
const logger = require('./logger');

const WG_INTERFACE = 'gatecontrol0';

function validateMac(mac) {
  return /^([0-9a-fA-F]{2}[:-]?){5}[0-9a-fA-F]{2}$/.test(mac);
}

function normalizeMac(mac) {
  const clean = mac.replace(/[:-]/g, '').toLowerCase();
  if (clean.length !== 12) throw new Error(`Invalid MAC: ${mac}`);
  if (!/^[0-9a-f]{12}$/.test(clean)) throw new Error(`Invalid MAC hex: ${mac}`);
  return Buffer.from(clean, 'hex');
}

function buildMagicPacket(mac) {
  const bytes = normalizeMac(mac);
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6);
  return packet;
}

/**
 * Send magic packet on all non-loopback, non-WG interfaces that have a broadcast address.
 * Returns array of { interface, broadcast, sent }.
 */
async function sendMagicPacket(mac) {
  const packet = buildMagicPacket(mac);
  const ifaces = os.networkInterfaces();
  const sendPromises = [];
  const results = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name === 'lo' || name.startsWith(WG_INTERFACE)) continue;
    if (name.startsWith('docker') || name.startsWith('br-')) continue;
    if (name.startsWith('veth') || name.startsWith('tailscale')) continue;
    if (name.startsWith('zt') || name.startsWith('nebula')) continue; // ZeroTier, Nebula
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const broadcast = _computeBroadcast(addr.address, addr.netmask);
      if (!broadcast) continue;

      sendPromises.push(new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        sock.bind(() => {
          sock.setBroadcast(true);
          sock.send(packet, 9, broadcast, (err) => {
            sock.close();
            results.push({ interface: name, broadcast, sent: !err, err: err?.message });
            resolve();
          });
        });
      }));
    }
  }

  await Promise.all(sendPromises);
  logger.info({ mac, results }, 'Magic packet sent');
  return results;
}

function _computeBroadcast(ip, netmask) {
  const ipParts = ip.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);
  if (ipParts.length !== 4 || maskParts.length !== 4) return null;
  if (ipParts.some(o => Number.isNaN(o) || o < 0 || o > 255)) return null;
  if (maskParts.some(o => Number.isNaN(o) || o < 0 || o > 255)) return null;
  const broadcastParts = ipParts.map((o, i) => (o & maskParts[i]) | (~maskParts[i] & 0xff));
  return broadcastParts.join('.');
}

/**
 * After sending magic packet, poll TCP reachability until timeout.
 */
async function waitForReachable(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const sock = net.createConnection({ host, port, timeout: 2000 });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
    });
    if (ok) return Date.now() - (deadline - timeoutMs);
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

module.exports = { buildMagicPacket, validateMac, sendMagicPacket, waitForReachable, _computeBroadcast };
