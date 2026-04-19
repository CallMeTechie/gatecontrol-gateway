'use strict';

const EventEmitter = require('node:events');

class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this.peerId = null;
    this.httpRoutes = [];
    this.l4Routes = [];
    this.currentHash = null;
  }

  /**
   * Replace config and emit 'change' if hash differs. Returns diff {l4Added, l4Removed, l4Changed}.
   */
  replaceConfig(cfg, newHash) {
    if (this.currentHash === newHash) {
      return { l4Added: [], l4Removed: [], l4Changed: [], unchanged: true };
    }
    const oldL4 = new Map(this.l4Routes.map(r => [r.id, r]));
    const newL4 = new Map((cfg.l4_routes || []).map(r => [r.id, r]));

    const l4Added = [];
    const l4Removed = [];
    const l4Changed = [];

    for (const [id, nr] of newL4) {
      const or = oldL4.get(id);
      if (!or) l4Added.push(nr);
      else if (or.listen_port !== nr.listen_port
            || or.target_lan_host !== nr.target_lan_host
            || or.target_lan_port !== nr.target_lan_port) {
        l4Changed.push({ ...nr, oldPort: or.listen_port });
      }
    }
    for (const [id, or] of oldL4) {
      if (!newL4.has(id)) l4Removed.push(or);
    }

    this.peerId = cfg.peer_id;
    this.httpRoutes = cfg.routes || [];
    this.l4Routes = cfg.l4_routes || [];
    this.currentHash = newHash;

    const diff = { l4Added, l4Removed, l4Changed, unchanged: false };
    this.emit('change', { cfg, hash: newHash, diff });
    return diff;
  }

  /**
   * Lookup HTTP route by domain (O(n) — fine for typical Heimnetz size).
   */
  findHttpRouteByDomain(domain) {
    return this.httpRoutes.find(r => r.domain === domain) || null;
  }

  /**
   * Check if a MAC is in the WoL-whitelist of any current route.
   */
  isMacInWolWhitelist(mac) {
    const mSelf = (mac || '').toUpperCase();
    for (const r of [...this.httpRoutes, ...this.l4Routes]) {
      if (r.wol_enabled && r.wol_mac && r.wol_mac.toUpperCase() === mSelf) return true;
    }
    return false;
  }
}

module.exports = { ConfigStore };
