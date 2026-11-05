'use strict';

// Netzgrenze des Edge-Containers – läuft im Gateway-Container (root,
// CAP_NET_ADMIN, Host-Netz). Regeln mit Owner-Match auf die UID des
// Edge-Benutzers (61001) im OUTPUT-Pfad: erlaubt sind nur
//   - der lokale MQTT-Broker (Loopback, Port 1883, beide Richtungen),
//   - der Server (Adressen von serverUrl, TCP auf dessen Port),
//   - Multicast 224.0.0.0/4 (mDNS, genehmigte Gruppen),
//   - die LAN-Subnetze des Gateways (ohne eigene Tunnel-Adresse/-Schnittstelle);
// alles andere DROP – auch IPv6 (außer Broker auf ::1).
//
// Backend: nftables (eigene Tabelle `inet gc_edge`, atomar ersetzt), sonst
// legacy-iptables (Synology-DSM-Kernel kennt nur x_tables: eigene Kette
// GC_EDGE, per iptables-restore --noflush atomar ersetzt, Sprung aus OUTPUT
// mit -m owner --uid-owner). Ergebnis + Zeitpunkt landen in
// /run/gc-edge/fence.json; der Edge-Host startet ohne frischen Marker und
// ohne bestandene EPERM-Probe keine Plugin-Prozesse (fail closed).

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EDGE_UID } = require('./constants');

const TABLE = 'gc_edge';
const CHAIN = 'GC_EDGE';
const BROKER_PORT = 1883;
const WG_IFACE = 'gatecontrol0';
const MARKER = 'fence.json';

const CIDR4 = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

function v4(list) { return (list || []).filter((a) => net.isIPv4(a)); }
function v6(list) { return (list || []).filter((a) => net.isIPv6(a)); }

function assertInputs({ uid, lanCidrs, serverAddrs, serverPort, tunnelIp }) {
  if (!Number.isInteger(uid) || uid < 1) throw new Error('fence: invalid uid');
  for (const c of lanCidrs) if (!CIDR4.test(c)) throw new Error(`fence: invalid cidr ${c}`);
  for (const a of serverAddrs) if (!net.isIP(a)) throw new Error(`fence: invalid server address ${a}`);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error('fence: invalid server port');
  if (tunnelIp && !net.isIPv4(tunnelIp)) throw new Error('fence: invalid tunnel ip');
}

/** nft-Skript (eine Transaktion: Tabelle anlegen, löschen, neu aufbauen). */
function buildNftRuleset(o) {
  assertInputs(o);
  const s4 = v4(o.serverAddrs);
  const s6 = v6(o.serverAddrs);
  const lines = [
    `table inet ${TABLE}`,
    `delete table inet ${TABLE}`,
    `table inet ${TABLE} {`,
    '  chain output {',
    '    type filter hook output priority 0; policy accept;',
    `    meta skuid ${o.uid} jump edge`,
    '  }',
    '  chain edge {',
    `    oifname "lo" tcp dport ${BROKER_PORT} accept`,
    `    oifname "lo" tcp sport ${BROKER_PORT} accept`,
  ];
  if (s4.length) lines.push(`    ip daddr { ${s4.join(', ')} } tcp dport ${o.serverPort} accept`);
  if (s6.length) lines.push(`    ip6 daddr { ${s6.join(', ')} } tcp dport ${o.serverPort} accept`);
  if (o.tunnelIp) lines.push(`    ip daddr ${o.tunnelIp} drop`);
  lines.push(`    oifname "${WG_IFACE}" drop`);
  lines.push('    ip daddr 224.0.0.0/4 accept');
  if (o.lanCidrs.length) lines.push(`    ip daddr { ${o.lanCidrs.join(', ')} } accept`);
  lines.push('    counter drop', '  }', '}', '');
  return lines.join('\n');
}

/** iptables-restore-Eingabe (--noflush) für die Kette GC_EDGE; family 4 oder 6. */
function buildIptablesRestore(o, family = 4) {
  assertInputs(o);
  const r = ['*filter', `:${CHAIN} - [0:0]`,
    `-A ${CHAIN} -o lo -p tcp --dport ${BROKER_PORT} -j ACCEPT`,
    `-A ${CHAIN} -o lo -p tcp --sport ${BROKER_PORT} -j ACCEPT`];
  if (family === 4) {
    for (const a of v4(o.serverAddrs)) r.push(`-A ${CHAIN} -d ${a}/32 -p tcp --dport ${o.serverPort} -j ACCEPT`);
    if (o.tunnelIp) r.push(`-A ${CHAIN} -d ${o.tunnelIp}/32 -j DROP`);
    r.push(`-A ${CHAIN} -o ${WG_IFACE} -j DROP`);
    r.push(`-A ${CHAIN} -d 224.0.0.0/4 -j ACCEPT`);
    for (const c of o.lanCidrs) r.push(`-A ${CHAIN} -d ${c} -j ACCEPT`);
  } else {
    for (const a of v6(o.serverAddrs)) r.push(`-A ${CHAIN} -d ${a}/128 -p tcp --dport ${o.serverPort} -j ACCEPT`);
  }
  r.push(`-A ${CHAIN} -j DROP`, 'COMMIT', '');
  return r.join('\n');
}

function jumpArgs(verb, uid) {
  return [verb, 'OUTPUT', ...(verb === '-I' ? ['1'] : []), '-m', 'owner', '--uid-owner', String(uid), '-j', CHAIN];
}

function defaultExec(bin, args, input) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '') });
    });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

function ipv6Present() {
  try { return fs.readFileSync('/proc/net/if_inet6', 'utf8').trim().length > 0; } catch { return false; }
}

class FenceManager {
  constructor({ runDir, uid = EDGE_UID, exec = defaultExec, logger, now = Date.now, env = process.env, hasIpv6 = ipv6Present } = {}) {
    this.runDir = runDir;
    this.uid = uid;
    this.exec = exec;
    this.logger = logger || { info() {}, warn() {}, debug() {} };
    this.now = now;
    this.hasIpv6 = hasIpv6;
    this.bins = {
      nft: env.GC_FENCE_NFT || 'nft',
      iptables: env.GC_FENCE_IPTABLES || 'iptables',
      iptablesRestore: env.GC_FENCE_IPTABLES_RESTORE || 'iptables-restore',
      ip6tables: env.GC_FENCE_IP6TABLES || 'ip6tables',
      ip6tablesRestore: env.GC_FENCE_IP6TABLES_RESTORE || 'ip6tables-restore',
    };
    this.mode = (env.GC_FENCE_BACKEND || 'auto').toLowerCase(); // auto | nft | iptables
    this.backend = null;
    this.lastApplied = null;
    this.state = { active: false, backend: null, error: 'not_applied' };
  }

  async applyNft(o) {
    const script = buildNftRuleset(o);
    if (this.backend === 'nft' && this.lastApplied === script) {
      const chk = await this.exec(this.bins.nft, ['list', 'chain', 'inet', TABLE, 'edge']);
      if (chk.ok) return;
    }
    const r = await this.exec(this.bins.nft, ['-f', '-'], script);
    if (!r.ok) throw new Error(`nft: ${r.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
    const chk = await this.exec(this.bins.nft, ['list', 'chain', 'inet', TABLE, 'output']);
    if (!chk.ok || !chk.stdout.includes(`skuid ${this.uid}`)) throw new Error('nft: rules not visible after apply');
    this.lastApplied = script;
  }

  async applyIptablesFamily(o, family) {
    const bin = family === 4 ? this.bins.iptables : this.bins.ip6tables;
    const restore = family === 4 ? this.bins.iptablesRestore : this.bins.ip6tablesRestore;
    const r = await this.exec(restore, ['--noflush'], buildIptablesRestore(o, family));
    if (!r.ok) throw new Error(`${restore}: ${r.stderr.trim().split('\n').slice(-1)[0].slice(0, 200)}`);
    const c = await this.exec(bin, jumpArgs('-C', this.uid));
    if (!c.ok) {
      const i = await this.exec(bin, jumpArgs('-I', this.uid));
      if (!i.ok) throw new Error(`${bin} owner match: ${i.stderr.trim().slice(0, 200)}`);
    }
    const v = await this.exec(bin, jumpArgs('-C', this.uid));
    if (!v.ok) throw new Error(`${bin}: jump rule not visible after apply`);
  }

  async applyIptables(o) {
    await this.applyIptablesFamily(o, 4);
    try {
      await this.applyIptablesFamily(o, 6);
    } catch (e) {
      if (this.hasIpv6()) throw e; // IPv6 vorhanden, aber nicht abgesichert → fail closed
      this.logger.debug({ err: e.message }, 'edge fence: no IPv6 on this host — ip6tables skipped');
    }
  }

  /**
   * Regeln setzen/prüfen und den Marker schreiben.
   * @param {{lanCidrs:string[], serverAddrs:string[], serverPort:number, tunnelIp:string|null}} o
   */
  async apply(o) {
    const input = { uid: this.uid, lanCidrs: [...new Set(o.lanCidrs || [])], serverAddrs: o.serverAddrs || [], serverPort: o.serverPort, tunnelIp: o.tunnelIp || null };
    const errors = [];
    const order = this.mode === 'nft' ? ['nft'] : this.mode === 'iptables' ? ['iptables']
      : (this.backend === 'iptables' ? ['iptables', 'nft'] : ['nft', 'iptables']);
    let ok = null;
    for (const b of order) {
      try {
        if (b === 'nft') await this.applyNft(input); else await this.applyIptables(input);
        ok = b;
        break;
      } catch (e) {
        errors.push(e.message);
      }
    }
    const prev = this.state;
    if (ok) {
      if (this.backend !== ok) this.logger.info({ backend: ok, uid: this.uid, lan: input.lanCidrs }, 'edge fence: rules active');
      this.backend = ok;
      this.state = { active: true, backend: ok, error: null };
    } else {
      this.state = { active: false, backend: null, error: errors.join(' | ').slice(0, 300) };
      if (prev.active || prev.error !== this.state.error) this.logger.warn({ err: this.state.error }, 'edge fence: could not set rules — edge parts stay stopped');
    }
    this.writeMarker(input);
    return this.state;
  }

  writeMarker(input) {
    const body = JSON.stringify({
      v: 1, active: this.state.active, backend: this.state.backend, error: this.state.error, uid: this.uid,
      appliedAt: new Date(this.now()).toISOString(), lan: input.lanCidrs, server: input.serverAddrs, serverPort: input.serverPort,
    });
    try {
      const tmp = path.join(this.runDir, `.${MARKER}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, body, { mode: 0o440 });
      fs.chmodSync(tmp, 0o440);
      fs.renameSync(tmp, path.join(this.runDir, MARKER));
    } catch (e) {
      this.logger.warn({ err: e.message }, 'edge fence: marker not written');
    }
  }
}

module.exports = { FenceManager, buildNftRuleset, buildIptablesRestore, jumpArgs, TABLE, CHAIN, MARKER };
