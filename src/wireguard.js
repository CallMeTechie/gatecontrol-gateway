'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const logger = require('./logger');

const WG_INTERFACE = 'gatecontrol0';
const CONFIG_DIR = process.env.GC_WG_CONFIG_DIR || '/etc/wireguard';

function parseWgShowDump(text, nowSec = Math.floor(Date.now() / 1000)) {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return { interface: {}, peers: [] };

  const ifaceLine = lines[0].split('\t');
  const interfaceInfo = {
    privateKey: ifaceLine[0],
    publicKey: ifaceLine[1],
    listenPort: parseInt(ifaceLine[2], 10) || null,
    fwmark: ifaceLine[3] === 'off' ? null : ifaceLine[3],
  };

  const peers = lines.slice(1).filter(l => l.trim()).map(line => {
    const parts = line.split('\t');
    const latestHandshakeTs = parseInt(parts[4], 10) || 0;
    return {
      publicKey: parts[0],
      presharedKey: parts[1] === '(none)' ? null : parts[1],
      endpoint: parts[2],
      allowedIps: parts[3],
      latestHandshakeTs,
      handshakeAgeS: latestHandshakeTs > 0 ? nowSec - latestHandshakeTs : null,
      rxBytes: parseInt(parts[5], 10) || 0,
      txBytes: parseInt(parts[6], 10) || 0,
      persistentKeepalive: parts[7] === 'off' ? null : parseInt(parts[7], 10),
    };
  });

  return { interface: interfaceInfo, peers };
}

function buildWgConfFile(config) {
  const lines = [
    '[Interface]',
    `PrivateKey = ${config.wg.privateKey}`,
    `Address = ${config.wg.address}`,
  ];
  if (config.wg.dns) lines.push(`DNS = ${config.wg.dns}`);
  // AllowedIPs: ONLY the tunnel subnet (default 10.8.0.0/24). NOT 0.0.0.0/0 —
  // that would hijack LAN routes and break direct access to LAN targets.
  lines.push('',
    '[Peer]',
    `PublicKey = ${config.wg.serverPublicKey}`,
  );
  if (config.wg.presharedKey) {
    lines.push(`PresharedKey = ${config.wg.presharedKey}`);
  }
  lines.push(
    `Endpoint = ${config.wg.endpoint}`,
    `AllowedIPs = ${config.wg.allowedIps || '10.8.0.0/24'}`,
    `PersistentKeepalive = 25`,
  );
  return lines.join('\n') + '\n';
}

function runCommand(cmd, args, opts = {}) {
  const { timeoutMs, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOpts });
    let stdout = '', stderr = '';
    let settled = false;
    let killTimer = null;
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    // Use 'exit' event (fires on process exit) instead of 'close' (waits for
    // all stdio pipes to close). wg-quick spawns wireguard-go as a daemon
    // that inherits pipes — 'close' never fires because wireguard-go runs
    // forever keeping stdout/stderr open. 'exit' fires when wg-quick itself
    // exits, which is what we want.
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      // Give 50ms for final buffered stdout/stderr to arrive before we read
      setTimeout(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr}`));
      }, 50);
    });
    // Optional hard-timeout: kill the child if it hasn't exited in time.
    // Used by getStatus() so a hung `wg show` can never block the heartbeat
    // collection. wg-quick up/down deliberately runs without a timeout
    // because boot-time setup (resolv.conf, route table) can legitimately
    // take longer.
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      killTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch (_e) { /* already gone */ }
        reject(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

async function writeConfAndBringUp(config) {
  const confPath = path.join(CONFIG_DIR, `${WG_INTERFACE}.conf`);
  const ini = buildWgConfFile(config);
  await fs.writeFile(confPath, ini, { mode: 0o600 });
  logger.info({ interface: WG_INTERFACE, path: confPath }, 'Wrote WireGuard config, bringing up');
  await runCommand('wg-quick', ['up', confPath]);
}

async function bringDown() {
  const confPath = path.join(CONFIG_DIR, `${WG_INTERFACE}.conf`);
  try { await runCommand('wg-quick', ['down', confPath]); } catch (e) {
    logger.warn({ err: e.message }, 'wg-quick down failed (may already be down)');
  }
}

async function getStatus() {
  // 1500ms is generous — `wg show` reads from kernel/userspace netlink and
  // returns in <50ms in practice. Cap exists to keep self-check / heartbeat
  // bounded if the wg interface ever wedges (rare but observed on resume
  // from suspend / TUN device hiccups).
  const out = await runCommand('wg', ['show', WG_INTERFACE, 'dump'], { timeoutMs: 1500 });
  return parseWgShowDump(out);
}

module.exports = {
  WG_INTERFACE,
  parseWgShowDump,
  buildWgConfFile,
  writeConfAndBringUp,
  bringDown,
  getStatus,
  // Exported for unit tests of the timeout/kill behaviour. Not part of the
  // module's public API — internal modules should call the named helpers above.
  _runCommand: runCommand,
};
