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

async function runSelfCheck({ proxyPort, apiPort, tcpPorts, wgStatus, dnsResolveFn, reachabilityFn, routes }) {
  // Layer 1 — Process: HTTP-Proxy localhost probe
  const proxyHealthy = (await tcpProbe('127.0.0.1', proxyPort)).reachable;
  const apiHealthy = (await tcpProbe('127.0.0.1', apiPort)).reachable;

  // Layer 1b — TCP-Listeners
  const tcp_listeners = await Promise.all((tcpPorts || []).map(async (port) => ({
    port,
    status: (await tcpProbe('127.0.0.1', port)).reachable ? 'listening' : 'listener_failed',
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
