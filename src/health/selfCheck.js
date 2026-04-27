'use strict';

const net = require('node:net');

async function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const start = Date.now();
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve({ reachable: true, latencyMs: Date.now() - start }); });
    sock.once('error', () => resolve({ reachable: false }));
    sock.once('timeout', () => { sock.destroy(); resolve({ reachable: false, reason: 'timeout' }); });
  });
}

async function runSelfCheck({ proxyPort, apiPort, tcpPorts, bindIp, wgStatus, dnsResolveFn, reachabilityFn, routes }) {
  // Layer 1 — Process: probe the address each listener actually binds to.
  // The HTTP proxy, management API, and TCP listeners all bind to the WG
  // tunnel IP (config.tunnelIp), NOT 127.0.0.1 — so probing localhost
  // always reported false and made every gateway look unhealthy in the
  // dashboard. Fall back to 127.0.0.1 only when bindIp wasn't supplied
  // (older bootstrap.js or unit tests).
  const probeIp = bindIp || '127.0.0.1';
  const proxyHealthy = (await tcpProbe(probeIp, proxyPort)).reachable;
  const apiHealthy = (await tcpProbe(probeIp, apiPort)).reachable;

  // Layer 1b — TCP-Listeners
  const tcp_listeners = await Promise.all((tcpPorts || []).map(async (port) => ({
    port,
    status: (await tcpProbe(probeIp, port)).reachable ? 'listening' : 'listener_failed',
  })));

  // Layer 2 — Network: WG + DNS
  let wg_handshake_age_s = null;
  try {
    const wgs = await wgStatus();
    const peer = (wgs.peers || [])[0];
    wg_handshake_age_s = peer ? peer.handshakeAgeS : null;
  } catch { /* tunnel down */ }

  let dns_resolve_ok = false;
  try { const list = await dnsResolveFn(); dns_resolve_ok = Array.isArray(list) && list.length > 0; } catch { /* dns failed */ }

  // Layer 3 — Per-Route LAN reachability
  const route_reachability = await Promise.all((routes || []).map(async (r) => {
    const res = await reachabilityFn(r.target_lan_host, r.target_lan_port);
    return { route_id: r.id, domain: r.domain, reachable: res.reachable, latency_ms: res.latencyMs || null, last_checked_at: Date.now() };
  }));

  const anyListenerFailed = tcp_listeners.some(l => l.status === 'listener_failed');

  return {
    http_proxy_healthy: proxyHealthy,
    api_healthy: apiHealthy,
    tcp_listeners,
    wg_handshake_age_s,
    dns_resolve_ok,
    route_reachability,
    overall_healthy: proxyHealthy && apiHealthy && !anyListenerFailed,
  };
}

module.exports = { runSelfCheck, tcpProbe };
