#!/usr/bin/env node
'use strict';

// Vergleicht die vertrauenswürdigen Herausgeber-Schlüssel im Gateway-Image
// (src/edge/trusted-keys.txt) mit BUILTIN_PUBLIC_KEYS des Servers
// (gatecontrol src/services/plugins/constants.js).
//
//   node scripts/check-edge-trusted-keys.js <pfad-zum-server-repo | pfad-zu-constants.js>
//   GH_TOKEN=… node scripts/check-edge-trusted-keys.js --github   (liest constants.js vom Branch master)
//
// Exit 0 = gleich, 1 = Abweichung, 2 = Fehler.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

function extractServerKeys(source) {
  const m = /BUILTIN_PUBLIC_KEYS\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/.exec(String(source));
  if (!m) throw new Error('BUILTIN_PUBLIC_KEYS not found');
  const keys = [];
  for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) if (B64_32.test(q[1])) keys.push(q[1]);
  return keys;
}

function compare(serverKeys, gatewayKeys) {
  const s = new Set(serverKeys);
  const g = new Set(gatewayKeys);
  return { missing: [...s].filter((k) => !g.has(k)), extra: [...g].filter((k) => !s.has(k)) };
}

function fetchGithub() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const url = 'https://api.github.com/repos/CallMeTechie/gatecontrol/contents/src/services/plugins/constants.js?ref=master';
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'gc-edge-keycheck', Accept: 'application/vnd.github.raw', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`GitHub: HTTP ${res.statusCode}`))));
    }).on('error', reject);
  });
}

async function main(argv) {
  const { parseKeyFile, KEYS_FILE } = require('../src/edge/signature');
  const arg = argv[2];
  if (!arg) { console.error('usage: check-edge-trusted-keys.js <server-repo|constants.js> | --github'); return 2; }
  let source;
  if (arg === '--github') source = await fetchGithub();
  else {
    const file = fs.statSync(arg).isDirectory() ? path.join(arg, 'src/services/plugins/constants.js') : arg;
    source = fs.readFileSync(file, 'utf8');
  }
  const r = compare(extractServerKeys(source), parseKeyFile(fs.readFileSync(KEYS_FILE, 'utf8')));
  if (!r.missing.length && !r.extra.length) { console.log('ok: trusted keys match the server'); return 0; }
  if (r.missing.length) console.log('missing in src/edge/trusted-keys.txt:\n  ' + r.missing.join('\n  '));
  if (r.extra.length) console.log('not trusted by the server (remove?):\n  ' + r.extra.join('\n  '));
  return 1;
}

if (require.main === module) {
  main(process.argv).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(2); });
}

module.exports = { extractServerKeys, compare };
