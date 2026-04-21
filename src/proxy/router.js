'use strict';

class Router {
  constructor() {
    this._map = new Map();
  }

  /**
   * Atomic swap of the routing table. Existing in-flight requests use the old
   * map via their closure; new requests get the new map.
   */
  setRoutes(httpRoutes) {
    const next = new Map();
    for (const route of httpRoutes) {
      next.set(route.domain, {
        host: route.target_lan_host,
        port: route.target_lan_port,
        // LAN-side scheme. true = https:// with cert verification off
        // (self-signed is the LAN default — DSM on :5001, router admin
        // panels, etc). Omitted / falsy = http://.
        backendHttps: !!route.backend_https,
        wolMac: route.wol_enabled ? (route.wol_mac || null) : null,
        routeId: route.id,
      });
    }
    this._map = next;
  }

  resolve(domain) {
    return this._map.get(domain) || null;
  }
}

module.exports = { Router };
