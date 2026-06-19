'use strict';
const { buildKeepalivedConf } = require('./keepalivedConfig');
const { buildRedirectRuleArgs } = require('./redirect');
const logger = require('../logger');

const RUN_DIR = '/run/keepalived';

class NearManager {
  constructor({ io, iface, selfLanIp, peerLanIps, hubTunnelIp }) {
    this.io = io;                 // { writeFile, chmod, mkdir, exec }
    this.iface = iface;
    this.selfLanIp = selfLanIp;
    this.peerLanIps = peerLanIps || [];
    this.hubTunnelIp = hubTunnelIp;
    this._role = 'none';
    this._lastSig = null;
    this._activeRedirects = new Map(); // key `${vip}:445->${toPort}` → {vip, toPort}
  }

  /** PURE: derive keepalived conf + health script from egress routes. */
  plan(egressRoutes) {
    const near = (egressRoutes || []).filter(r => r.vip_ip); // only Synology-near routes carry a VIP
    const healthScript = `#!/bin/sh\nping -c1 -W2 ${this.hubTunnelIp} >/dev/null 2>&1\n`;
    const instances = near.map((r, idx) => ({
      name: `EGRESS_${r.id}`,
      vrid: 51 + (r.id % 200),  // assumes route_id < 201 (VRID 1..254); widen if IDs grow
      // Equal base priority on both gateways; keepalived breaks the tie by higher
      // unicast_src_ip. The `weight -60` tunnel-health gate (keepalivedConfig) is what
      // actually elects: a tunnel-dead master drops to 90, the healthy peer (150) wins.
      priority: 150 - idx,
      vip: r.vip_ip,
      vipPrefix: r.vip_prefix || 24,   // Review-I1: VIP must carry its prefix (not /32)
      unicastSrc: this.selfLanIp,
      unicastPeers: (Array.isArray(r.near_peers) && r.near_peers.length) ? r.near_peers : this.peerLanIps,
    }));
    const conf = buildKeepalivedConf({
      iface: this.iface, healthCheckCmd: `${RUN_DIR}/health.sh`, instances,
    });
    return { instances, conf, healthScript };
  }

  async _keepalivedRunning() {
    const r = await this.io.exec('sh', ['-c', 'pgrep keepalived >/dev/null 2>&1 && echo yes || echo no']);
    return r.ok && (r.stdout || '').includes('yes');
  }

  async _ensureRedirect(vip, toPort) {
    const c = await this.io.exec('iptables', buildRedirectRuleArgs('-C', vip, 445, toPort));
    if (!c.ok) await this.io.exec('iptables', buildRedirectRuleArgs('-A', vip, 445, toPort));
  }

  async _delRedirect(vip, toPort) {
    await this.io.exec('iptables', buildRedirectRuleArgs('-D', vip, 445, toPort));
  }

  /** Write the plan to /run/keepalived and (re)load keepalived. Owns the REDIRECT directly. */
  async apply(egressRoutes) {
    const p = this.plan(egressRoutes);
    const near = (egressRoutes || []).filter(r => r.vip_ip);
    const sig = JSON.stringify({
      conf: p.conf,
      health: p.healthScript,
      redirects: near.map(r => `${r.vip_ip}:445->${r.lan_listen_port}`).sort(),
    });
    const running = await this._keepalivedRunning();

    if (p.instances.length === 0) {
      if (running) await this.io.exec('sh', ['-c', 'pkill keepalived 2>/dev/null || true']);
      for (const { vip, toPort } of this._activeRedirects.values()) {
        await this._delRedirect(vip, toPort);
      }
      this._activeRedirects.clear();
      this._role = 'none';
      this._lastSig = sig;
      return;
    }

    // Churn guard: config unchanged AND keepalived already running → re-ensure only, no reload
    if (sig === this._lastSig && running) {
      for (const { vip, toPort } of this._activeRedirects.values()) {
        await this._ensureRedirect(vip, toPort);
      }
      return;
    }

    // Config changed or keepalived not running: write files and (re)start
    await this.io.mkdir(RUN_DIR, { recursive: true });
    await this.io.writeFile(`${RUN_DIR}/health.sh`, p.healthScript);
    await this.io.chmod(`${RUN_DIR}/health.sh`, 0o755);
    await this.io.writeFile(`${RUN_DIR}/keepalived.conf`, p.conf);

    if (!running) {
      // NOTE: NO `-n` (no-daemonize) — foreground keepalived never exits, execFile's
      // 6s timeout would kill it → restart loop (Review-Critical). Let it daemonize.
      await this.io.exec('keepalived', ['-l', '-f', `${RUN_DIR}/keepalived.conf`, '-p', `${RUN_DIR}/keepalived.pid`, '-D']);
    } else {
      await this.io.exec('sh', ['-c', 'pkill -HUP keepalived 2>/dev/null']);
    }

    // Reconcile REDIRECTs: add new, remove stale, re-ensure all desired (idempotent)
    const desired = new Map();
    for (const r of near) {
      const key = `${r.vip_ip}:445->${r.lan_listen_port}`;
      desired.set(key, { vip: r.vip_ip, toPort: r.lan_listen_port });
    }
    for (const [key, { vip, toPort }] of desired) {
      if (!this._activeRedirects.has(key)) await this._ensureRedirect(vip, toPort);
    }
    for (const [key, { vip, toPort }] of this._activeRedirects) {
      if (!desired.has(key)) await this._delRedirect(vip, toPort);
    }
    for (const { vip, toPort } of desired.values()) {
      await this._ensureRedirect(vip, toPort);
    }

    this._activeRedirects = desired;
    this._lastSig = sig;

    logger.info({ vips: p.instances.map(i => i.vip) }, 'near: keepalived applied');
  }

  /** Best-effort role for telemetry: master if we currently hold any VIP. */
  async getStatus(egressRoutes) {
    const near = (egressRoutes || []).filter(r => r.vip_ip);
    if (near.length === 0) return { vips: [], role: 'none' };
    const held = [];
    for (const r of near) {
      // grep -qF "<vip>/" — exact match (keepalived prints the prefix), avoids .25 matching .250.
      const res = await this.io.exec('sh', ['-c', `ip addr show dev ${this.iface} | grep -qF "${r.vip_ip}/" && echo yes || echo no`]);
      if (res.ok && (res.stdout || '').includes('yes')) held.push(r.vip_ip);
    }
    return { vips: near.map(r => r.vip_ip), role: held.length ? 'master' : 'backup' };
  }
}
module.exports = { NearManager, RUN_DIR };
