'use strict';
const { buildKeepalivedConf, renderMasterScript, renderBackupScript } = require('./keepalivedConfig');
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
  }

  /** PURE: derive keepalived conf + notify/health scripts from egress routes. */
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
      iface: this.iface, healthCheckCmd: `${RUN_DIR}/health.sh`, notifyDir: RUN_DIR, instances,
    });
    const scripts = {};
    for (const r of near) {
      const a = { vip: r.vip_ip, dport: 445, toPort: r.lan_listen_port };
      scripts[`EGRESS_${r.id}_master.sh`] = renderMasterScript(a);
      scripts[`EGRESS_${r.id}_backup.sh`] = renderBackupScript(a);
    }
    return { instances, conf, scripts, healthScript };
  }

  /** Write the plan to /run/keepalived and (re)load keepalived. */
  async apply(egressRoutes) {
    const p = this.plan(egressRoutes);
    await this.io.mkdir(RUN_DIR, { recursive: true });
    await this.io.writeFile(`${RUN_DIR}/health.sh`, p.healthScript); await this.io.chmod(`${RUN_DIR}/health.sh`, 0o755);
    for (const [name, body] of Object.entries(p.scripts)) {
      await this.io.writeFile(`${RUN_DIR}/${name}`, body); await this.io.chmod(`${RUN_DIR}/${name}`, 0o755);
    }
    await this.io.writeFile(`${RUN_DIR}/keepalived.conf`, p.conf);
    if (p.instances.length === 0) {
      await this.io.exec('sh', ['-c', 'pkill keepalived 2>/dev/null || true']);
      this._role = 'none';
      return;
    }
    // Reload if running, else start. keepalived honours SIGHUP for config reload.
    const reload = await this.io.exec('sh', ['-c', 'pkill -HUP keepalived 2>/dev/null']);
    if (!reload.ok) {
      // NOTE: NO `-n` (no-daemonize) — foreground keepalived never exits, execFile's
      // 6s timeout would kill it → restart loop (Review-Critical). Let it daemonize.
      await this.io.exec('keepalived', ['-l','-f',`${RUN_DIR}/keepalived.conf`,'-p',`${RUN_DIR}/keepalived.pid`,'-D']);
    }
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
