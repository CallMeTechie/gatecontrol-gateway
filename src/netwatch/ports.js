'use strict';

// Portscan des Netzwerk-Wächters (Vertrag Phase 3a, Abschnitt 2): TCP-Connect
// auf eine feste Liste, kurzes Zeitlimit, höchstens 16 Verbindungen
// gleichzeitig, nur private Ziele (RFC 1918), nie die eigene Tunnel-Adresse
// und nie eigene Adressen. Nutzt den Sweep der LAN-Erkennung.

const { sweep, probePort } = require('../discovery/tcpSweep');
const { isPrivateIpv4 } = require('../discovery/lanInterfaces');

const PORTS = Object.freeze([
  21, 22, 23, 25, 53, 80, 81, 110, 139, 143, 443, 445, 548, 554, 631, 1883, 1900, 3000, 3306, 3389,
  5000, 5001, 5432, 5900, 6379, 8000, 8001, 8008, 8080, 8081, 8123, 8443, 8883, 9000, 9100, 10000,
  32400, 49152, 62078,
]);

// Nur eindeutige Zuordnungen; mehrdeutige Ports (3000, 5000, 8000 …) bleiben null.
const SERVICES = Object.freeze({
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 80: 'http', 81: 'http', 110: 'pop3',
  139: 'netbios', 143: 'imap', 443: 'https', 445: 'smb', 548: 'afp', 554: 'rtsp', 631: 'ipp',
  1883: 'mqtt', 1900: 'upnp', 3306: 'mysql', 3389: 'rdp', 5432: 'postgres', 5900: 'vnc',
  6379: 'redis', 8080: 'http', 8123: 'home-assistant', 8443: 'https', 8883: 'mqtts',
  9100: 'jetdirect', 32400: 'plex', 62078: 'iphone-sync',
});

const MAX_CONCURRENCY = 16;
const TIMEOUT_MS = 700;

function serviceFor(port) {
  return Object.prototype.hasOwnProperty.call(SERVICES, port) ? SERVICES[port] : null;
}

/**
 * Erlaubte Ziele: privat (RFC 1918), nicht die Tunnel-Adresse, keine eigene Adresse.
 */
function allowedTargets(ips, { tunnelIp, ownIps = [] } = {}) {
  const own = new Set(ownIps);
  return [...new Set(ips)].filter((ip) => typeof ip === 'string' && isPrivateIpv4(ip) && ip !== tunnelIp && !own.has(ip));
}

/**
 * Scannt `ips` → Map(ip → [{ port, service }]) (nur für erlaubte Ziele, jedes
 * erlaubte Ziel hat einen Eintrag, ggf. leer).
 */
async function scanPorts(ips, { tunnelIp, ownIps, concurrency = MAX_CONCURRENCY, timeoutMs = TIMEOUT_MS, probeFn = probePort, ports = PORTS } = {}) {
  const hosts = allowedTargets(ips, { tunnelIp, ownIps });
  const out = new Map(hosts.map((h) => [h, []]));
  if (!hosts.length) return out;
  const open = await sweep({
    hosts, ports, concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, concurrency)), timeoutMs, jitterMs: 5, probeFn,
  });
  for (const { ip, port } of open) out.get(ip).push({ port, service: serviceFor(port) });
  for (const list of out.values()) list.sort((a, b) => a.port - b.port);
  return out;
}

module.exports = { PORTS, SERVICES, serviceFor, allowedTargets, scanPorts, MAX_CONCURRENCY };
