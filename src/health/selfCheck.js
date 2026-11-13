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

// The heartbeat body is capped at 16 kB on the server — the two lists below
// name at most this many routes each (the counters stay exact).
const MAX_L4_ENTRIES = 20;

async function runSelfCheck({ proxyPort, apiPort, tcpPorts, bindIp, wgStatus, dnsResolveFn, reachabilityFn, routes, l4RouteCount, l4Issues, l4Direct }) {
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

  // Listener-deficit detection. A configured L4 route whose bind failed never
  // enters the TcpProxyManager Map, so its port is absent from `tcpPorts`
  // entirely (distinct from `listener_failed`, which means registered-but-
  // unreachable). Because the config hash is already committed after the failed
  // apply, the 'change' event never re-fires and the listener is never retried.
  // Surfacing the deficit here lets the heartbeat path trigger a re-apply.
  //
  // Not missing: a route that points at this host on its own listen port
  // while the target service holds that port (TcpProxyManager "direct"). The
  // server dials <tunnel IP>:<listen port> — the service answers there itself.
  // Whether it answers right now is probed like a LAN target and reported per
  // route; like route_reachability it does not make the gateway unhealthy.
  const l4_listeners_direct = await Promise.all((l4Direct || []).map(async (d) => ({
    route_id: d.route_id,
    listen_port: d.listen_port,
    reachable: (await tcpProbe(probeIp, d.listen_port)).reachable,
  })));
  const l4_routes_configured = l4RouteCount || 0;
  const l4_listeners_present = tcp_listeners.length;
  const l4_listeners_missing = Math.max(0, l4_routes_configured - l4_listeners_present - l4_listeners_direct.length);
  // Which listeners are missing and why (port_in_use, permission_denied,
  // address_unavailable, error). New fields — an older server ignores them.
  const l4_listener_issues = l4_listeners_missing > 0 ? (l4Issues || []).slice(0, MAX_L4_ENTRIES) : [];

  return {
    http_proxy_healthy: proxyHealthy,
    api_healthy: apiHealthy,
    tcp_listeners,
    l4_routes_configured,
    l4_listeners_missing,
    l4_listener_issues,
    l4_listeners_direct: l4_listeners_direct.slice(0, MAX_L4_ENTRIES),
    wg_handshake_age_s,
    dns_resolve_ok,
    route_reachability,
    overall_healthy: proxyHealthy && apiHealthy && !anyListenerFailed && l4_listeners_missing === 0,
  };
}

module.exports = { runSelfCheck, tcpProbe };
