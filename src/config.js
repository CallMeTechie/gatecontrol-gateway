'use strict';

const fs = require('node:fs');
const { z } = require('zod');

const ConfigSchema = z.object({
  GC_SERVER_URL: z.string().url(),
  GC_API_TOKEN: z.string().regex(/^gc_gw_[a-f0-9]{64}$/, 'GC_API_TOKEN must be gc_gw_<64-hex>'),
  GC_GATEWAY_TOKEN: z.string().regex(/^[a-f0-9]{64}$/, 'GC_GATEWAY_TOKEN must be 64-hex'),
  GC_TUNNEL_IP: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/, 'GC_TUNNEL_IP must be IPv4'),
  GC_PROXY_PORT: z.coerce.number().int().min(1024).max(65535).default(8080),
  GC_API_PORT: z.coerce.number().int().min(1024).max(65535).default(9876),
  GC_HEARTBEAT_INTERVAL_S: z.coerce.number().int().min(5).max(600).default(30),
  GC_POLL_INTERVAL_S: z.coerce.number().int().min(30).max(3600).default(300),
  GC_LAN_PROBE_TARGET: z.string().optional(),
  WG_PRIVATE_KEY: z.string().min(1),
  WG_PUBLIC_KEY: z.string().min(1),
  WG_ENDPOINT: z.string().min(1),
  WG_SERVER_PUBLIC_KEY: z.string().min(1),
  WG_ADDRESS: z.string().min(1),
  WG_DNS: z.string().optional(),
  // Default tunnel-only routing (NOT 0.0.0.0/0 — would break LAN access).
  // Format: CIDR or comma-separated list. Must include Server-Tunnel-IP-Subnet.
  WG_ALLOWED_IPS: z.string().default('10.8.0.0/24'),
});

function parseEnvFile(contents) {
  const out = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function loadConfig(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const kv = parseEnvFile(raw);
  const parsed = ConfigSchema.parse(kv);

  if (!isTunnelIpValid(parsed.GC_TUNNEL_IP)) {
    throw new Error(`GC_TUNNEL_IP cannot be 0.0.0.0 (binding to all interfaces is forbidden)`);
  }

  return {
    serverUrl: parsed.GC_SERVER_URL,
    apiToken: parsed.GC_API_TOKEN,
    gatewayToken: parsed.GC_GATEWAY_TOKEN,
    tunnelIp: parsed.GC_TUNNEL_IP,
    proxyPort: parsed.GC_PROXY_PORT,
    apiPort: parsed.GC_API_PORT,
    heartbeatIntervalS: parsed.GC_HEARTBEAT_INTERVAL_S,
    pollIntervalS: parsed.GC_POLL_INTERVAL_S,
    lanProbeTarget: parsed.GC_LAN_PROBE_TARGET || null,
    wg: {
      privateKey: parsed.WG_PRIVATE_KEY,
      publicKey: parsed.WG_PUBLIC_KEY,
      endpoint: parsed.WG_ENDPOINT,
      serverPublicKey: parsed.WG_SERVER_PUBLIC_KEY,
      address: parsed.WG_ADDRESS,
      dns: parsed.WG_DNS || null,
      allowedIps: parsed.WG_ALLOWED_IPS,
    },
  };
}

function isRfc1918(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => Number.isNaN(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function isTunnelIpValid(ip) {
  return ip !== '0.0.0.0' && /^\d+\.\d+\.\d+\.\d+$/.test(ip);
}

module.exports = { loadConfig, isRfc1918, isTunnelIpValid };
