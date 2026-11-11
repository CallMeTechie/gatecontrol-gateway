'use strict';

// Standalone healthcheck for Docker HEALTHCHECK. Cannot use process.env
// because config vars live in /config/gateway.env (volume-mounted), not in
// the container's Docker env. Parses the file, probes /api/health.
//
// Without a usable gateway.env the gateway waits on its setup page
// (docs/setup-page.md) — then the container is healthy when that page answers.

const fs = require('node:fs');
const http = require('node:http');

const envPath = process.env.GATEWAY_ENV_PATH || '/config/gateway.env';

let ip;
let port = 9876;
try {
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k === 'GC_TUNNEL_IP') ip = v;
    else if (k === 'GC_API_PORT') port = Number(v) || port;
  }
} catch {
  ip = undefined;
}

let url = `http://${ip}:${port}/api/health`;
if (!ip) {
  if (/^(off|0|false|no)$/i.test(process.env.GC_SETUP_PAGE || '')) process.exit(1);
  const setupPort = Number(process.env.GC_SETUP_PORT) || 8642;
  url = `http://127.0.0.1:${setupPort}/healthz`;
}

const req = http.get(url, (r) => {
  process.exit(r.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.setTimeout(4000, () => { req.destroy(); process.exit(1); });
