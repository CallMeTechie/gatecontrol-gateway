# Gateway LAN Discovery — Phase 2 (Discovery Engine + /api/lan-scan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the gateway companion the ability to scan its own LAN on demand — passive mDNS + SSDP always, an opt-in active TCP-connect sweep — via a new async `POST /api/lan-scan` endpoint that streams batched results back to the server, and advertise the capability with `lan_discovery: true` in telemetry.

**Architecture:** A discovery engine under `src/discovery/` composed of small, independently-tested units: a pure **category resolver** (selection → effective ports + passive-filter predicate), three **sources** (`tcpSweep`, `ssdp`, `mdns` — each exporting pure parsers/mappers + a thin socket wrapper), a **scan engine** that orchestrates+merges+filters+batches (sources injectable), a **results client** (Bearer POST to the server), and a long-lived **scan manager** (one scan at a time → 409, re-validates requested subnets against the gateway's OWN interfaces, runs the engine async with a hard timeout). A new auth-gated route kicks it off. No new container capabilities (`NET_RAW` not needed — TCP-connect sweep + `/proc/net/arp`).

**Tech Stack:** Node ≥ 20, `node:net`/`node:dgram`/`node:dns`, `axios` (existing), `multicast-dns` (new dep, mDNS only), `zod` (existing), built-in `node --test`. Repo: `gatecontrol-gateway`.

**Spec:** `gatecontrol/docs/superpowers/specs/2026-05-27-gateway-lan-discovery-design.md` (§4.1–4.6, §5.1, §6.2, §11 Phase 2). Builds on Phase 1 (`src/discovery/categories.js` → `CATEGORIES`; `src/discovery/lanInterfaces.js` → `lanSubnets`, `ipInCidr`, `isPhysicalLan`; telemetry already reports `lan_subnets` + `lan_discovery_categories`).

**Reviewer context (carry from Phase-1 reviews):** the sandbox's global eslint is 9.x and errors on `.eslintrc.json` — run `npm run lint` (pinned 8.57.1 via package-lock), and do NOT treat a local eslint-9 config-load error as a code defect. CI runs `npm ci` then lint + tests + coverage (≥70%) + a mutation job. No manual version bump, no `Co-Authored-By` trailer.

---

## File Structure

- **Create** `src/discovery/categoryFilter.js` — pure: `resolveCategories(mode, keys)` → `{ ports, mdnsTypes, ssdpPatterns, activeKeys }`; `passivePasses(hit, resolved)` (uncategorised always kept). Reuses Phase-1 `CATEGORIES`.
- **Create** `src/discovery/tcpSweep.js` — `hostsInSubnet(cidr)`, `probePort(ip, port, timeoutMs)`, `sweep({subnetCidr, ports, concurrency, timeoutMs, jitterMs, probeFn})`, `parseArp(content)`. The active source (no `NET_RAW`).
- **Create** `src/discovery/ssdp.js` — pure `parseSsdpResponse(text)`, `locationHostPort(url)`; thin `discoverSsdp({ifaceIp, timeoutMs})`.
- **Create** `src/discovery/mdns.js` — pure `mapMdnsResponse(packet)`; thin `discoverMdns({ifaceIp, timeoutMs})`. Adds `multicast-dns` dependency.
- **Create** `src/discovery/scanEngine.js` — `runScan({subnets, activeScan, categoryMode, categories, config, sources, arpReader, onBatch})`: orchestrate sources, merge by IP, category-filter passive hits, MAC-enrich, batch.
- **Create** `src/discovery/discoveryClient.js` — `makeDiscoveryClient(config)` → `sendBatch({requestId, devices, done})` (Bearer POST to `/api/v1/gateway/discovery`).
- **Create** `src/discovery/scanManager.js` — `ScanManager` class: `validateSubnets(requested, gwIp)`, `canStart()`, `start(params)` (async lifecycle + hard timeout + final `done`).
- **Create** `src/api/routes/lanScan.js` — `createLanScanRouter({ scanMgr, defaultGatewayIp })` → `POST /lan-scan`.
- **Modify** `src/config.js` — add `GC_DISCOVERY_MAX_PREFIX`/`_TIMEOUT_MS`/`_CONCURRENCY` (zod + returned config keys).
- **Modify** `src/bootstrap.js` — instantiate the client + sources + scan manager, mount the route.
- **Modify** `src/health/telemetry.js` — add `lan_discovery: true`.
- **Tests** alongside in `tests/`.

---

## Task 1: Discovery config env vars

**Files:** Modify `src/config.js` (schema lines 6-26; returned object lines 49-70). Test: `tests/config_discovery.test.js`

- [ ] **Step 1: Write the failing test** — create `tests/config_discovery.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');

// Minimal valid env (mirrors src/config.js ConfigSchema required fields).
const BASE = [
  'GC_SERVER_URL=https://srv.example.com',
  'GC_API_TOKEN=gc_gw_' + 'a'.repeat(64),
  'GC_GATEWAY_TOKEN=' + 'b'.repeat(64),
  'GC_TUNNEL_IP=10.8.0.9',
  'WG_PRIVATE_KEY=x', 'WG_PUBLIC_KEY=x', 'WG_ENDPOINT=host:51820',
  'WG_SERVER_PUBLIC_KEY=x', 'WG_ADDRESS=10.8.0.9/32',
];
function writeEnv(extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const p = path.join(dir, 'gateway.env');
  fs.writeFileSync(p, BASE.concat(extra).join('\n') + '\n');
  return p;
}

test('discovery config defaults', () => {
  const c = loadConfig(writeEnv());
  assert.equal(c.discoveryMaxPrefix, 22);
  assert.equal(c.discoveryTimeoutMs, 45000);
  assert.equal(c.discoveryConcurrency, 128);
});

test('discovery config overrides + bounds', () => {
  const c = loadConfig(writeEnv([
    'GC_DISCOVERY_MAX_PREFIX=24', 'GC_DISCOVERY_TIMEOUT_MS=30000', 'GC_DISCOVERY_CONCURRENCY=64',
  ]));
  assert.equal(c.discoveryMaxPrefix, 24);
  assert.equal(c.discoveryTimeoutMs, 30000);
  assert.equal(c.discoveryConcurrency, 64);
  assert.throws(() => loadConfig(writeEnv(['GC_DISCOVERY_MAX_PREFIX=40']))); // zod max(32) → 40 rejected
});
```

- [ ] **Step 2: Run → fail** — `node --test --test-force-exit tests/config_discovery.test.js` (defaults are `undefined`).

- [ ] **Step 3: Implement** — in `src/config.js`, add to `ConfigSchema` (after the `GC_LAN_PROBE_TARGET` line):
```js
  GC_DISCOVERY_MAX_PREFIX: z.coerce.number().int().min(8).max(32).default(22),
  GC_DISCOVERY_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300000).default(45000),
  GC_DISCOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(1024).default(128),
```
and add to the returned object (after the `lanProbeTarget` line):
```js
    discoveryMaxPrefix: parsed.GC_DISCOVERY_MAX_PREFIX,
    discoveryTimeoutMs: parsed.GC_DISCOVERY_TIMEOUT_MS,
    discoveryConcurrency: parsed.GC_DISCOVERY_CONCURRENCY,
```

- [ ] **Step 4: Run → pass** (2 tests). **Step 5: Commit** — `git add src/config.js tests/config_discovery.test.js && git commit -m "feat(config): add GC_DISCOVERY_* env vars"`

---

## Task 2: Category resolver (pure)

**Files:** Create `src/discovery/categoryFilter.js`; Test `tests/discovery_categoryFilter.test.js`

- [ ] **Step 1: Write the failing test**:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCategories, passivePasses } = require('../src/discovery/categoryFilter');

test('include mode: only selected categories contribute ports', () => {
  const r = resolveCategories('include', ['web']);
  assert.ok(r.ports.includes(80) && r.ports.includes(443));
  assert.ok(!r.ports.includes(1883)); // iot not selected
  assert.deepEqual(r.activeKeys, ['web']);
});

test('exclude mode: all categories except selected', () => {
  const r = resolveCategories('exclude', ['iot']);
  assert.ok(!r.ports.includes(1883)); // iot excluded
  assert.ok(r.ports.includes(80));    // web still in
  assert.ok(!r.activeKeys.includes('iot'));
});

test('passive hit in an inactive category is dropped; active kept; uncategorised always kept', () => {
  const inc = resolveCategories('include', ['web']);
  assert.equal(passivePasses({ mdnsType: '_hap._tcp' }, inc), false);      // iot, not active
  assert.equal(passivePasses({ mdnsType: '_http._tcp' }, inc), true);      // web, active
  assert.equal(passivePasses({ mdnsType: '_unknown._tcp' }, inc), true);   // uncategorised → kept
  const exc = resolveCategories('exclude', ['iot']);
  assert.equal(passivePasses({ mdnsType: '_hap._tcp' }, exc), false);      // iot excluded
  assert.equal(passivePasses({ ssdpServer: 'Linux/3 UPnP/1.0 WeMo/1' }, exc), false); // WeMo→iot excluded
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — create `src/discovery/categoryFilter.js`:

```js
'use strict';

const { CATEGORIES } = require('./categories');

// Resolve a per-scan category selection into the concrete signals the engine
// needs. `mode` is 'include' (scan only selected) or 'exclude' (scan all but
// selected). An empty/garbage selection in include mode → nothing active.
function resolveCategories(mode, selectedKeys) {
  const sel = new Set(Array.isArray(selectedKeys) ? selectedKeys : []);
  const active = CATEGORIES.filter(c => (mode === 'exclude' ? !sel.has(c.key) : sel.has(c.key)));
  const ports = new Set();
  const mdnsTypes = new Set();
  const ssdpPatterns = [];
  for (const c of active) {
    for (const p of c.ports) ports.add(p);
    for (const m of c.mdns) mdnsTypes.add(m);
    for (const s of c.ssdp) ssdpPatterns.push(s);
  }
  return {
    ports: [...ports].sort((a, b) => a - b),
    mdnsTypes,
    ssdpPatterns,
    activeKeys: active.map(c => c.key),
  };
}

// A passive hit (mDNS service type and/or SSDP SERVER string) passes the filter
// if it matches at least one ACTIVE category — or if it matches NO known
// category at all (uncategorised hits are voluntarily advertised and always
// surfaced; spec §4.4).
function passivePasses(hit, resolved) {
  const mdnsType = hit && hit.mdnsType;
  const ssdpServer = hit && hit.ssdpServer;
  const matched = CATEGORIES.filter(c =>
    (mdnsType && c.mdns.includes(mdnsType)) ||
    (ssdpServer && c.ssdp.some(p => ssdpServer.includes(p))));
  if (matched.length === 0) return true;
  return matched.some(c => resolved.activeKeys.includes(c.key));
}

module.exports = { resolveCategories, passivePasses };
```

- [ ] **Step 4: Run → pass** (3 tests). **Step 5: Commit** — `git add src/discovery/categoryFilter.js tests/discovery_categoryFilter.test.js && git commit -m "feat(discovery): category resolver (include/exclude + passive filter)"`

---

## Task 3: TCP-connect sweep + ARP parse

**Files:** Create `src/discovery/tcpSweep.js`; Test `tests/discovery_tcpSweep.test.js`

- [ ] **Step 1: Write the failing test**:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { hostsInSubnet, probePort, sweep, parseArp } = require('../src/discovery/tcpSweep');

test('hostsInSubnet enumerates usable hosts (excludes network + broadcast)', () => {
  const h = hostsInSubnet('192.168.1.0/24');
  assert.equal(h.length, 254);
  assert.equal(h[0], '192.168.1.1');
  assert.equal(h[h.length - 1], '192.168.1.254');
  assert.equal(hostsInSubnet('10.0.0.0/30').length, 2); // .1 .2
});

test('probePort: open vs closed', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;
  assert.equal(await probePort('127.0.0.1', port, 500), true);
  srv.close();
  assert.equal(await probePort('127.0.0.1', 1, 300), false); // almost certainly closed
});

test('sweep uses injected probeFn, bounded, returns open host:port', async () => {
  const open = new Set(['192.168.1.5:80', '192.168.1.9:443']);
  let inflightMax = 0, inflight = 0;
  const probeFn = async (ip, port) => {
    inflight++; inflightMax = Math.max(inflightMax, inflight);
    await new Promise(r => setTimeout(r, 1));
    inflight--;
    return open.has(`${ip}:${port}`);
  };
  const res = await sweep({ subnetCidr: '192.168.1.0/24', ports: [80, 443], concurrency: 8, timeoutMs: 200, jitterMs: 0, probeFn });
  const keys = res.map(r => `${r.ip}:${r.port}`).sort();
  assert.deepEqual(keys, ['192.168.1.5:80', '192.168.1.9:443']);
  assert.ok(inflightMax <= 8);
});

test('parseArp maps ip→mac, ignores incomplete entries', () => {
  const content = [
    'IP address       HW type     Flags       HW address            Mask     Device',
    '192.168.1.10     0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0',
    '192.168.1.11     0x1         0x0         00:00:00:00:00:00     *        eth0',
  ].join('\n');
  const m = parseArp(content);
  assert.equal(m.get('192.168.1.10'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(m.has('192.168.1.11'), false); // flag 0x0 = incomplete
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — create `src/discovery/tcpSweep.js`:

```js
'use strict';

const net = require('node:net');

function _ipToInt(ip) {
  return ip.split('.').reduce((a, o) => ((a << 8) + (Number(o) & 255)) >>> 0, 0);
}
function _intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// Usable host IPs in an IPv4 CIDR, excluding network and broadcast addresses.
function hostsInSubnet(cidr) {
  const [network, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const base = _ipToInt(network) >>> 0;
  const count = 2 ** (32 - prefix);
  const out = [];
  for (let i = 1; i < count - 1; i++) out.push(_intToIp((base + i) >>> 0));
  return out;
}

// Bounded TCP connect probe. Resolves true if the port accepts, false otherwise
// (closed/filtered/timeout). Never rejects. Mirrors src/health/selfCheck.js.
function probePort(host, port, timeoutMs = 400) {
  return new Promise(resolve => {
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

// Bounded-concurrency map over (host × port). `probeFn` is injectable for tests.
async function sweep({ subnetCidr, ports, concurrency = 128, timeoutMs = 400, jitterMs = 5, probeFn = probePort }) {
  const hosts = hostsInSubnet(subnetCidr);
  const jobs = [];
  for (const ip of hosts) for (const port of ports) jobs.push({ ip, port });
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const { ip, port } = jobs[idx++];
      if (jitterMs) await new Promise(r => setTimeout(r, Math.random() * jitterMs));
      if (await probeFn(ip, port, timeoutMs)) results.push({ ip, port });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, worker));
  return results;
}

// Parse /proc/net/arp → Map(ip → mac). Only entries with the ATF_COM (0x2) flag
// set are complete/resolved; skip 0x0 (incomplete) and the header line.
function parseArp(content) {
  const map = new Map();
  for (const line of content.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [ip, , flags, mac] = cols;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    if ((parseInt(flags, 16) & 0x2) === 0) continue;
    if (mac === '00:00:00:00:00:00') continue;
    map.set(ip, mac.toLowerCase());
  }
  return map;
}

module.exports = { hostsInSubnet, probePort, sweep, parseArp };
```

- [ ] **Step 4: Run → pass** (4 tests). **Step 5: Commit** — `git add src/discovery/tcpSweep.js tests/discovery_tcpSweep.test.js && git commit -m "feat(discovery): TCP-connect sweep + /proc/net/arp parser"`

---

## Task 4: SSDP source (pure parser + thin socket)

**Files:** Create `src/discovery/ssdp.js`; Test `tests/discovery_ssdp.test.js`

- [ ] **Step 1: Write the failing test**:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSsdpResponse, locationHostPort } = require('../src/discovery/ssdp');

test('parseSsdpResponse extracts LOCATION/ST/SERVER (case-insensitive headers)', () => {
  const raw = [
    'HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=1800',
    'LOCATION: http://192.168.1.10:8200/rootDesc.xml',
    'ST: urn:schemas-upnp-org:device:MediaServer:1',
    'Server: Linux/3 UPnP/1.0 MiniDLNA/1.2', '', '',
  ].join('\r\n');
  const r = parseSsdpResponse(raw);
  assert.equal(r.location, 'http://192.168.1.10:8200/rootDesc.xml');
  assert.equal(r.st, 'urn:schemas-upnp-org:device:MediaServer:1');
  assert.equal(r.server, 'Linux/3 UPnP/1.0 MiniDLNA/1.2');
});

test('locationHostPort parses host:port without fetching', () => {
  assert.deepEqual(locationHostPort('http://192.168.1.10:8200/x.xml'), { host: '192.168.1.10', port: 8200 });
  assert.deepEqual(locationHostPort('https://192.168.1.20/desc'), { host: '192.168.1.20', port: 443 });
  assert.equal(locationHostPort('not a url'), null);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — create `src/discovery/ssdp.js`:

```js
'use strict';

const dgram = require('node:dgram');
const logger = require('../logger');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function _header(raw, name) {
  const re = new RegExp('^' + name + ':\\s*(.+)$', 'im');
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

// Parse a raw SSDP/HTTPU response into { location, st, server }.
function parseSsdpResponse(raw) {
  return { location: _header(raw, 'LOCATION'), st: _header(raw, 'ST'), server: _header(raw, 'SERVER') };
}

// Extract { host, port } from a LOCATION URL. We DO NOT fetch the URL (SSRF).
function locationHostPort(url) {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return { host: u.hostname, port };
  } catch { return null; }
}

// Send an M-SEARCH on the given LAN interface and collect responses for a window.
// Bound to a specific interface IP so multicast leaves the LAN, not wg0/docker.
// Returns [{ host, port, st, server }]. Thin wrapper — covered by smoke, not unit.
function discoverSsdp({ ifaceIp, timeoutMs = 4000, mx = 2 }) {
  return new Promise(resolve => {
    const out = [];
    if (!ifaceIp) return resolve(out); // never bind multicast to 0.0.0.0/wg0 (spec §4.2)
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ssdp:all\r\n\r\n`);
    sock.on('error', (err) => { logger.debug({ err: err.message }, 'ssdp socket error'); try { sock.close(); } catch {} resolve(out); });
    sock.on('message', (buf) => {
      const r = parseSsdpResponse(buf.toString());
      const hp = r.location ? locationHostPort(r.location) : null;
      if (hp) out.push({ host: hp.host, port: hp.port, st: r.st, server: r.server });
    });
    sock.bind(0, ifaceIp, () => {
      try { sock.setMulticastInterface(ifaceIp); } catch {}
      sock.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(out); }, timeoutMs);
  });
}

module.exports = { parseSsdpResponse, locationHostPort, discoverSsdp };
```

- [ ] **Step 4: Run → pass** (2 tests). **Step 5: Commit** — `git add src/discovery/ssdp.js tests/discovery_ssdp.test.js && git commit -m "feat(discovery): SSDP M-SEARCH source (no LOCATION fetch)"`

---

## Task 5: mDNS source (add dep + pure mapper + thin socket)

**Files:** Modify `package.json` (add dep); Create `src/discovery/mdns.js`; Test `tests/discovery_mdns.test.js`

- [ ] **Step 1: Add the dependency**
Run: `npm install multicast-dns@^7.2.5`
Expected: `package.json` gains `"multicast-dns": "^7.2.5"` under dependencies and `package-lock.json` updates. (If the sandbox lacks network, report BLOCKED — this task needs registry access.)
Then run `npm audit` and confirm the updated `package-lock.json` is staged with `package.json` (supply-chain hygiene — see project memory `project_supply_chain_hardening_2026_05`).

- [ ] **Step 2: Write the failing test** — create `tests/discovery_mdns.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapMdnsResponse } = require('../src/discovery/mdns');

test('mapMdnsResponse builds service records from PTR/SRV/A/TXT answers', () => {
  const packet = {
    answers: [
      { type: 'PTR', name: '_http._tcp.local', data: 'nas._http._tcp.local' },
      { type: 'SRV', name: 'nas._http._tcp.local', data: { port: 5000, target: 'nas.local' } },
      { type: 'A', name: 'nas.local', data: '192.168.1.20' },
    ],
    additionals: [],
  };
  const recs = mapMdnsResponse(packet);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], { ip: '192.168.1.20', host: 'nas.local', port: 5000, mdnsType: '_http._tcp' });
});

test('mapMdnsResponse skips records without a resolvable A address', () => {
  const recs = mapMdnsResponse({ answers: [{ type: 'PTR', name: '_x._tcp.local', data: 'y._x._tcp.local' }], additionals: [] });
  assert.deepEqual(recs, []);
});
```

- [ ] **Step 3: Run → fail.**

- [ ] **Step 4: Implement** — create `src/discovery/mdns.js`:

```js
'use strict';

const logger = require('../logger');

// Pure: fold a multicast-dns response packet into service records.
// Correlates SRV (port + target host) with A (target → IP) and derives the
// service type from the SRV record name (e.g. `nas._http._tcp.local` → `_http._tcp`).
function mapMdnsResponse(packet) {
  const recs = packet && Array.isArray(packet.answers) ? packet.answers.slice() : [];
  const extra = packet && Array.isArray(packet.additionals) ? packet.additionals : [];
  const all = recs.concat(extra);
  const aByName = new Map();
  for (const r of all) if (r.type === 'A' && typeof r.data === 'string') aByName.set(r.name, r.data);
  const out = [];
  for (const r of all) {
    if (r.type !== 'SRV' || !r.data) continue;
    const ip = aByName.get(r.data.target);
    if (!ip) continue;
    const m = r.name.match(/(_[^.]+\._(?:tcp|udp))\.local$/);
    out.push({ ip, host: r.data.target, port: r.data.port, mdnsType: m ? m[1] : null });
  }
  return out;
}

// Thin socket wrapper bound to the LAN interface — covered by smoke, not unit.
function discoverMdns({ ifaceIp, timeoutMs = 4000 }) {
  return new Promise(resolve => {
    let mdns;
    const out = [];
    if (!ifaceIp) return resolve(out); // never bind multicast to a null/all interface (spec §4.2)
    try {
      mdns = require('multicast-dns')({ interface: ifaceIp, multicast: true });
    } catch (err) { logger.debug({ err: err.message }, 'mdns init failed'); return resolve(out); }
    mdns.on('response', (packet) => { for (const r of mapMdnsResponse(packet)) out.push(r); });
    mdns.on('error', (err) => logger.debug({ err: err.message }, 'mdns error'));
    mdns.query({ questions: [{ name: '_services._dns-sd._udp.local', type: 'PTR' }] });
    setTimeout(() => { try { mdns.destroy(); } catch {} resolve(out); }, timeoutMs);
  });
}

module.exports = { mapMdnsResponse, discoverMdns };
```

- [ ] **Step 5: Run → pass** (2 tests). **Step 6: Commit** — `git add package.json package-lock.json src/discovery/mdns.js tests/discovery_mdns.test.js && git commit -m "feat(discovery): mDNS source via multicast-dns"`

---

## Task 6: Scan engine (orchestrate + merge + filter + batch)

**Files:** Create `src/discovery/scanEngine.js`; Test `tests/discovery_scanEngine.test.js`

- [ ] **Step 1: Write the failing test**:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScan, localIpForSubnet } = require('../src/discovery/scanEngine');

test('localIpForSubnet picks the local IPv4 inside the subnet (multicast binds to LAN, not wg0)', () => {
  const ifaces = {
    eth0: [{ address: '192.168.1.7', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    wg0:  [{ address: '10.8.0.2',    netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  assert.equal(localIpForSubnet('192.168.1.0/24', ifaces), '192.168.1.7');
  assert.equal(localIpForSubnet('172.16.0.0/24', ifaces), null);
});

function fakeSources({ mdns = [], ssdp = [], sweep = [] }) {
  return {
    discoverMdns: async () => mdns,
    discoverSsdp: async () => ssdp,
    sweep: async () => sweep,
  };
}

test('merges sources by IP, tags ports with source, dedupes, includes uncategorised passive', async () => {
  const batches = [];
  const sources = fakeSources({
    mdns: [{ ip: '192.168.1.20', host: 'nas.local', port: 5000, mdnsType: '_http._tcp' }],
    ssdp: [{ host: '192.168.1.20', port: 8200, st: 'MediaServer', server: 'MiniDLNA' }],
    sweep: [{ ip: '192.168.1.20', port: 80 }, { ip: '192.168.1.30', port: 22 }],
  });
  const devices = await runScan({
    subnets: ['192.168.1.0/24'], activeScan: true, categoryMode: 'include',
    categories: ['web', 'media', 'remote_access'], config: { discoveryConcurrency: 8, discoveryTimeoutMs: 1000 },
    sources, arpReader: () => new Map([['192.168.1.20', 'aa:bb:cc:dd:ee:ff']]),
    onBatch: (devs, done) => batches.push({ n: devs.length, done }),
  });
  const nas = devices.find(d => d.ip === '192.168.1.20');
  assert.equal(nas.hostname, 'nas.local');
  assert.equal(nas.mac, 'aa:bb:cc:dd:ee:ff');
  assert.deepEqual(nas.ports.map(p => p.port).sort((a, b) => a - b), [80, 5000, 8200]);
  assert.ok(devices.find(d => d.ip === '192.168.1.30')); // sweep-only host
  assert.ok(batches.some(b => b.done === true));         // a terminal batch was emitted
});

test('active_scan=false skips the sweep source', async () => {
  let swept = false;
  const sources = { discoverMdns: async () => [], discoverSsdp: async () => [], sweep: async () => { swept = true; return []; } };
  await runScan({ subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'include', categories: ['web'],
    config: { discoveryConcurrency: 8, discoveryTimeoutMs: 1000 }, sources, arpReader: () => new Map(), onBatch: () => {} });
  assert.equal(swept, false);
});

test('excluded-category passive hit is filtered out', async () => {
  const sources = fakeSources({ ssdp: [{ host: '192.168.1.40', port: 49153, st: 'x', server: 'WeMo/1' }] });
  const devices = await runScan({ subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'exclude',
    categories: ['iot'], config: { discoveryConcurrency: 8, discoveryTimeoutMs: 1000 }, sources, arpReader: () => new Map(), onBatch: () => {} });
  assert.equal(devices.find(d => d.ip === '192.168.1.40'), undefined); // WeMo→iot excluded
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — create `src/discovery/scanEngine.js`:

```js
'use strict';

const os = require('node:os');
const { resolveCategories, passivePasses } = require('./categoryFilter');
const { ipInCidr } = require('./lanInterfaces');

// The gateway's own IPv4 address inside `cidr`. Multicast (mDNS/SSDP) MUST bind
// to this interface IP, never wg0/docker (spec §4.1/§4.2). Returns null if none.
function localIpForSubnet(cidr, ifaces = os.networkInterfaces()) {
  const [network, prefixStr] = String(cidr).split('/');
  const prefix = Number(prefixStr);
  for (const addrs of Object.values(ifaces || {})) {
    for (const a of (addrs || [])) {
      if (a.family === 'IPv4' && !a.internal && ipInCidr(a.address, network, prefix)) return a.address;
    }
  }
  return null;
}

function _add(map, ip) {
  if (!map.has(ip)) map.set(ip, { ip, hostname: null, mac: null, ports: [], sources: new Set() });
  return map.get(ip);
}
function _addPort(dev, port, source, hint) {
  if (!dev.ports.some(p => p.port === port && p.source === source)) {
    dev.ports.push({ port, source, service_hint: hint || null });
  }
  dev.sources.add(source);
}

// Orchestrate the (injectable) sources across the given subnets, merge into
// per-IP device records, filter passive hits by category, MAC-enrich, and emit
// a terminal batch. `sources` = { discoverMdns, discoverSsdp, sweep }.
// Phase 2 emits a SINGLE terminal batch (done:true); time-based intermediate
// batching (spec §4.5 "every ~2 s") is deferred — the onBatch/sendBatch plumbing
// already supports adding it later without an interface change.
async function runScan({ subnets, activeScan, categoryMode, categories, config, sources, arpReader, onBatch }) {
  const resolved = resolveCategories(categoryMode, categories);
  const byIp = new Map();

  for (const subnet of subnets) {
    const ifaceIp = localIpForSubnet(subnet);
    const [mdnsHits, ssdpHits] = await Promise.all([
      sources.discoverMdns({ ifaceIp, timeoutMs: config.discoveryTimeoutMs }),
      sources.discoverSsdp({ ifaceIp, timeoutMs: config.discoveryTimeoutMs }),
    ]);
    for (const h of mdnsHits) {
      if (!passivePasses({ mdnsType: h.mdnsType }, resolved)) continue;
      const d = _add(byIp, h.ip); if (h.host) d.hostname = d.hostname || h.host;
      if (h.port) _addPort(d, h.port, 'mdns', h.mdnsType);
    }
    for (const h of ssdpHits) {
      if (!passivePasses({ ssdpServer: h.server }, resolved)) continue;
      // SSDP gives an IP (not a hostname) — only contribute the open port.
      const d = _add(byIp, h.host);
      if (h.port) _addPort(d, h.port, 'ssdp', h.st || h.server);
    }
    if (activeScan && resolved.ports.length) {
      // 400 = PER-PROBE timeout; the OVERALL scan window is enforced by ScanManager (Promise.race on discoveryTimeoutMs).
      const open = await sources.sweep({ subnetCidr: subnet, ports: resolved.ports, concurrency: config.discoveryConcurrency, timeoutMs: 400 });
      for (const o of open) _addPort(_add(byIp, o.ip), o.port, 'tcp', null);
    }
  }

  const arp = (typeof arpReader === 'function') ? arpReader() : new Map();
  const devices = [...byIp.values()].map(d => ({
    ip: d.ip, hostname: d.hostname, mac: arp.get(d.ip) || null, ports: d.ports, sources: [...d.sources],
  }));
  if (typeof onBatch === 'function') onBatch(devices, true);
  return devices;
}

module.exports = { runScan, localIpForSubnet };
```

- [ ] **Step 4: Run → pass** (4 tests). **Step 5: Commit** — `git add src/discovery/scanEngine.js tests/discovery_scanEngine.test.js && git commit -m "feat(discovery): scan engine — orchestrate/merge/filter/batch"`

---

## Task 7: Discovery results client (Bearer POST to server)

**Files:** Create `src/discovery/discoveryClient.js`; Test `tests/discovery_client.test.js`

- [ ] **Step 1: Write the failing test**:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeDiscoveryClient } = require('../src/discovery/discoveryClient');

test('sendBatch POSTs to /api/v1/gateway/discovery with Bearer auth', async () => {
  let received = null;
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { received = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }; res.end('{}'); });
  }).listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;
  const client = makeDiscoveryClient({ serverUrl: `http://127.0.0.1:${port}`, apiToken: 'gc_gw_' + 'a'.repeat(64) });
  await client.sendBatch({ requestId: 'r1', devices: [{ ip: '192.168.1.5', ports: [] }], done: true });
  assert.equal(received.url, '/api/v1/gateway/discovery');
  assert.equal(received.auth, 'Bearer gc_gw_' + 'a'.repeat(64));
  assert.equal(received.body.request_id, 'r1');
  assert.equal(received.body.done, true);
  assert.equal(received.body.devices.length, 1);
  srv.close();
});

test('sendBatch swallows transport errors (never throws)', async () => {
  const client = makeDiscoveryClient({ serverUrl: 'http://127.0.0.1:1', apiToken: 'gc_gw_' + 'a'.repeat(64) });
  await client.sendBatch({ requestId: 'r2', devices: [], done: true }); // must resolve, not reject
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — create `src/discovery/discoveryClient.js`:

```js
'use strict';

const axios = require('axios');
const http = require('node:http');
const https = require('node:https');
const logger = require('../logger');

const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

// Mirrors src/heartbeat.js: Bearer POST to the server, tolerant of failures.
function makeDiscoveryClient({ serverUrl, apiToken }) {
  async function sendBatch({ requestId, devices, done }) {
    try {
      await axios.post(`${serverUrl}/api/v1/gateway/discovery`,
        { request_id: requestId, devices, done },
        { headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
          timeout: 10_000, httpAgent, httpsAgent });
    } catch (err) {
      logger.warn({ err: err.message, status: err.response?.status }, 'discovery batch post failed');
    }
  }
  return { sendBatch };
}

module.exports = { makeDiscoveryClient };
```

- [ ] **Step 4: Run → pass** (2 tests). **Step 5: Commit** — `git add src/discovery/discoveryClient.js tests/discovery_client.test.js && git commit -m "feat(discovery): results-callback client (Bearer POST)"`

---

## Task 8: Scan manager (in-flight mutex + subnet validation + lifecycle)

**Files:** Create `src/discovery/scanManager.js`; Test `tests/discovery_scanManager.test.js`

- [ ] **Step 1: Write the failing test**:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ScanManager } = require('../src/discovery/scanManager');

const cfg = { discoveryMaxPrefix: 22, discoveryTimeoutMs: 1000, discoveryConcurrency: 8 };
// gateway "owns" 192.168.1.0/24 only
const lanSubnetsFn = () => [{ iface: 'eth0', cidr: '192.168.1.0/24', primary: true }];

test('validateSubnets keeps only the gateway-owned subnets, drops foreign', () => {
  const m = new ScanManager({ config: cfg, lanSubnetsFn, runScan: async () => [], discoveryClient: { sendBatch: async () => {} } });
  assert.deepEqual(m.validateSubnets(['192.168.1.0/24', '10.0.0.0/24'], '192.168.1.1'), ['192.168.1.0/24']);
  assert.deepEqual(m.validateSubnets(['10.0.0.0/24'], '192.168.1.1'), []);
});

test('validateSubnets rejects subnets larger than the configured cap', () => {
  const m = new ScanManager({ config: { ...cfg, discoveryMaxPrefix: 24 },
    lanSubnetsFn: () => [{ iface: 'eth0', cidr: '192.168.0.0/16', primary: true }],
    runScan: async () => [], discoveryClient: { sendBatch: async () => {} } });
  assert.deepEqual(m.validateSubnets(['192.168.0.0/16'], '192.168.1.1'), []); // /16 < /24 cap → rejected
});

test('canStart is false while a scan is in flight, true after it finishes', async () => {
  let release;
  const runScan = async ({ onBatch }) => { await new Promise(r => (release = r)); onBatch([], true); return []; };
  const m = new ScanManager({ config: cfg, lanSubnetsFn, runScan, discoveryClient: { sendBatch: async () => {} } });
  assert.equal(m.canStart(), true);
  const p = m.start({ requestId: 'r1', subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'include', categories: ['web'] });
  assert.equal(m.canStart(), false);
  release(); await p;
  assert.equal(m.canStart(), true);
});

test('start streams batches to the client and always sends a terminal done', async () => {
  const sent = [];
  const runScan = async ({ onBatch }) => { onBatch([{ ip: '192.168.1.5', ports: [] }], false); onBatch([{ ip: '192.168.1.5', ports: [] }], true); return []; };
  const m = new ScanManager({ config: cfg, lanSubnetsFn, runScan, discoveryClient: { sendBatch: async (b) => sent.push(b) } });
  await m.start({ requestId: 'r9', subnets: ['192.168.1.0/24'], activeScan: false, categoryMode: 'include', categories: ['web'] });
  assert.ok(sent.some(b => b.done === true && b.requestId === 'r9'));
  assert.equal(m.canStart(), true);
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — create `src/discovery/scanManager.js`:

```js
'use strict';

const fs = require('node:fs');
const logger = require('../logger');
const { lanSubnets } = require('./lanInterfaces');
const { parseArp } = require('./tcpSweep');

// Long-lived: enforces one scan at a time, re-validates requested subnets
// against the gateway's OWN physical-LAN interfaces (defense in depth), and runs
// the engine async, streaming batches to the server and guaranteeing a terminal
// `done` even on timeout/error.
class ScanManager {
  constructor({ config, discoveryClient, runScan, sources, lanSubnetsFn, arpReader }) {
    this.config = config;
    this.client = discoveryClient;
    this.runScan = runScan;
    this.sources = sources;
    this.lanSubnetsFn = lanSubnetsFn || lanSubnets; // injectable for tests
    this.arpReader = arpReader || (() => {
      try { return parseArp(fs.readFileSync('/proc/net/arp', 'utf8')); } catch { return new Map(); }
    });
    this.active = null; // null | { requestId, startedAt }
  }

  canStart() { return this.active === null; }

  // Keep only requested CIDRs that exactly match an owned physical-LAN subnet
  // AND are no larger than the configured cap (prefix >= discoveryMaxPrefix).
  validateSubnets(requested, gwIp) {
    const owned = new Set(this.lanSubnetsFn(gwIp).map(s => s.cidr));
    const cap = this.config.discoveryMaxPrefix;
    return (Array.isArray(requested) ? requested : []).filter(cidr => {
      if (!owned.has(cidr)) return false;
      const prefix = Number(String(cidr).split('/')[1]);
      return Number.isInteger(prefix) && prefix >= cap;
    });
  }

  async start({ requestId, subnets, activeScan, categoryMode, categories }) {
    if (this.active) throw new Error('scan_in_progress');
    this.active = { requestId, startedAt: Date.now() };
    const send = (devices, done) => this.client.sendBatch({ requestId, devices, done });
    let timer = null;
    try {
      await Promise.race([
        this.runScan({ subnets, activeScan, categoryMode, categories, config: this.config, sources: this.sources, arpReader: this.arpReader, onBatch: send }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('scan_timeout')), this.config.discoveryTimeoutMs + 15_000); }),
      ]);
    } catch (err) {
      logger.warn({ err: err.message, requestId }, 'scan failed/timed out');
      await send([], true); // guarantee a terminal batch so the server/UI never hangs
    } finally {
      if (timer) clearTimeout(timer);
      this.active = null;
    }
  }
}

module.exports = { ScanManager };
```

- [ ] **Step 4: Run → pass** (4 tests). **Step 5: Commit** — `git add src/discovery/scanManager.js tests/discovery_scanManager.test.js && git commit -m "feat(discovery): scan manager (mutex + subnet validation + lifecycle)"`

---

## Task 9: `POST /api/lan-scan` route

**Files:** Create `src/api/routes/lanScan.js`; Test `tests/api_lan_scan.test.js`

- [ ] **Step 1: Write the failing test** (mirrors `tests/api_wol.test.js`):

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAuthMiddleware } = require('../src/api/middleware/auth');
const { createLanScanRouter } = require('../src/api/routes/lanScan');

const TOK = 't'.repeat(64);
async function serverWith(scanMgr) {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthMiddleware({ expectedToken: TOK }),
    createLanScanRouter({ scanMgr, defaultGatewayIp: () => '192.168.1.1' }));
  const s = app.listen(0, '127.0.0.1');
  await new Promise(r => s.on('listening', r));
  return s;
}
function post(port, body) {
  return new Promise(resolve => {
    const p = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/lan-scan', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p), 'X-Gateway-Token': TOK } },
      r => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.end(p);
  });
}

describe('POST /api/lan-scan', () => {
  const okMgr = (over = {}) => ({ canStart: () => true, validateSubnets: () => ['192.168.1.0/24'], start: async () => {}, ...over });

  it('202 with subnets_scanned on a valid request', async () => {
    let started = null;
    const s = await serverWith(okMgr({ start: async (p) => { started = p; } }));
    const r = await post(s.address().port, { request_id: 'r1', subnets: ['192.168.1.0/24'], category_mode: 'include', categories: ['web'], active_scan: true });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { accepted: true, request_id: 'r1', subnets_scanned: ['192.168.1.0/24'] });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(started.requestId, 'r1'); assert.equal(started.activeScan, true);
    s.close();
  });

  it('409 when a scan is already in flight', async () => {
    const s = await serverWith(okMgr({ canStart: () => false }));
    const r = await post(s.address().port, { request_id: 'r1', subnets: ['192.168.1.0/24'] });
    assert.equal(r.status, 409); s.close();
  });

  it('400 on missing request_id / subnets', async () => {
    const s = await serverWith(okMgr());
    assert.equal((await post(s.address().port, { subnets: ['192.168.1.0/24'] })).status, 400);
    assert.equal((await post(s.address().port, { request_id: 'r1' })).status, 400);
    s.close();
  });

  it('403 when no requested subnet is gateway-owned', async () => {
    const s = await serverWith(okMgr({ validateSubnets: () => [] }));
    const r = await post(s.address().port, { request_id: 'r1', subnets: ['10.0.0.0/24'] });
    assert.equal(r.status, 403); s.close();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** — create `src/api/routes/lanScan.js`:

```js
'use strict';

const express = require('express');
const logger = require('../../logger');

// POST /api/lan-scan — async: validate, accept (202), then run the scan in the
// background (results stream back to the server via the scan manager).
function createLanScanRouter({ scanMgr, defaultGatewayIp }) {
  const router = express.Router();
  router.post('/lan-scan', (req, res) => {
    const { request_id, subnets, category_mode, categories, active_scan } = req.body || {};
    // NB: req.body.timeout_ms is advisory and intentionally NOT read — the gateway
    // enforces its own GC_DISCOVERY_TIMEOUT_MS (spec §4.5) via the ScanManager.
    if (typeof request_id !== 'string' || !request_id) return res.status(400).json({ error: 'request_id_required' });
    if (!Array.isArray(subnets) || subnets.length === 0) return res.status(400).json({ error: 'subnets_required' });
    if (!scanMgr.canStart()) return res.status(409).json({ error: 'scan_in_progress' });

    const allowed = scanMgr.validateSubnets(subnets, defaultGatewayIp());
    if (allowed.length === 0) return res.status(403).json({ error: 'no_valid_subnets' });

    res.status(202).json({ accepted: true, request_id, subnets_scanned: allowed });
    scanMgr.start({
      requestId: request_id, subnets: allowed, activeScan: active_scan === true,
      categoryMode: category_mode === 'exclude' ? 'exclude' : 'include',
      categories: Array.isArray(categories) ? categories : [],
    }).catch(err => logger.warn({ err: err.message, request_id }, 'lan-scan start failed'));
  });
  return router;
}

module.exports = { createLanScanRouter };
```

- [ ] **Step 4: Run → pass** (4 tests). **Step 5: Commit** — `git add src/api/routes/lanScan.js tests/api_lan_scan.test.js && git commit -m "feat(api): POST /api/lan-scan endpoint"`

---

## Task 10: Bootstrap wiring + telemetry capability flag

**Files:** Modify `src/bootstrap.js` (state creation ~lines 35-38; `/api` router factory ~lines 91-113); Modify `src/health/telemetry.js`. Test: update the existing `tests/telemetry_lan_discovery.test.js`.

- [ ] **Step 1: Flip the existing capability assertion (this becomes the failing test).** Phase 1's `tests/telemetry_lan_discovery.test.js` asserts the flag is ABSENT; Phase 2 sets it. Change that one line — replace:
```js
  // Phase 1 must NOT advertise the capability flag (that is Phase 2)
  assert.equal(t.lan_discovery, undefined);
```
with:
```js
  // Phase 2: the capability flag is now set (the /api/lan-scan endpoint exists).
  assert.equal(t.lan_discovery, true);
```
Do NOT add a separate capability test file — this assertion IS the red→green test for the flag, and leaving the old `undefined` assertion would break the suite.

- [ ] **Step 2: Run → fail** — `node --test --test-force-exit tests/telemetry_lan_discovery.test.js` (telemetry doesn't set the flag yet).

- [ ] **Step 3: Add the capability flag** — in `src/health/telemetry.js` `collectTelemetry()`, change the Phase-1 block:
```js
    // LAN discovery — data only (Phase 1). The `lan_discovery` capability flag
    // is intentionally NOT set here; it is added in Phase 2 once /api/lan-scan
    // exists, so a Phase-1-only gateway won't surface a dead discovery button.
    lan_subnets: lanSubnets(_gwIp),
    lan_discovery_categories: catalogue(),
```
to:
```js
    // LAN discovery (Phase 2: capability flag now set — /api/lan-scan exists).
    lan_discovery: true,
    lan_subnets: lanSubnets(_gwIp),
    lan_discovery_categories: catalogue(),
```

- [ ] **Step 4: Run → pass** (1 test).

- [ ] **Step 5: Wire the scan stack into bootstrap.** In `src/bootstrap.js`, add the requires at the top alongside the other discovery/service requires:
```js
const { makeDiscoveryClient } = require('./discovery/discoveryClient');
const { discoverMdns } = require('./discovery/mdns');
const { discoverSsdp } = require('./discovery/ssdp');
const { sweep } = require('./discovery/tcpSweep');
const { runScan } = require('./discovery/scanEngine');
const { ScanManager } = require('./discovery/scanManager');
const { createLanScanRouter } = require('./api/routes/lanScan');
```

- [ ] **Step 5a: Export `defaultGatewayIp` from telemetry** — the route needs it. In `src/health/telemetry.js`, `defaultGatewayIp` is already a top-level function (line ~63) but only `collectTelemetry` is exported. Change the export to:
```js
module.exports = { collectTelemetry, defaultGatewayIp };
```
Then update bootstrap's existing top-level require (it currently destructures only `collectTelemetry`) to bring the new export in alongside it — `const { collectTelemetry, defaultGatewayIp } = require('./health/telemetry');` — so the route is wired with the destructured name, not an inline `require` inside the factory.

- [ ] **Step 5b: Instantiate the scan stack** — after the in-memory state is created (after `const tcpMgr = ...`):
```js
  const discoveryClient = makeDiscoveryClient({ serverUrl: config.serverUrl, apiToken: config.apiToken });
  const scanMgr = new ScanManager({
    config, discoveryClient, runScan,
    sources: { discoverMdns, discoverSsdp, sweep },
  });
```
> `ScanManager` already defaults `arpReader` to a `/proc/net/arp` reader (Task 8) — no extra MAC-enrichment wiring is needed here.

- [ ] **Step 5c: Mount the route** inside the existing `/api` merge-router factory (alongside `createWolRouter` etc.), passing the now-exported helper:
```js
    mergeRouter.use(createLanScanRouter({ scanMgr, defaultGatewayIp }));
```

- [ ] **Step 6: Verify wiring** — `node --check src/bootstrap.js` and run the full suite `npm test` (expect green; bootstrap is also exercised by `tests/smoke.test.js` / `tests/integration/full-flow.test.js`). If smoke/integration assert on the exact shape of the `/api` mounted routes or bootstrap return value, update them minimally to include the new route/None-breaking additions.

- [ ] **Step 7: Commit** — `git add src/bootstrap.js src/health/telemetry.js tests/telemetry_lan_discovery.test.js && git commit -m "feat(gateway): wire lan-scan stack + advertise lan_discovery capability"`

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite** — `npm test` → all suites pass (Phase-1 tests + the ~10 new test files + smoke/integration). Paste the totals.
- [ ] **Step 2: Lint** — `npm run lint` → 0 errors. (Object-injection *warnings* in the new IPv4/array code are pre-existing precedent; do not fail on them. If a global eslint-9 config-load error appears, that's the known env artifact — rely on `npm run lint` resolving the pinned 8.57.1, as in Phase 1.)
- [ ] **Step 3: Sanity** — `node -e "console.log(require('./src/health/telemetry').collectTelemetry().lan_discovery)"` → `true`. `node -e "const {hostsInSubnet}=require('./src/discovery/tcpSweep'); console.log(hostsInSubnet('192.168.1.0/24').length)"` → `254`.
- [ ] **Step 4: Push the branch + open PR** — this is a separate feature branch off `main` (after Phase 1 merges). Do NOT merge to main (CI cuts the release on merge). Push and open a PR titled "feat: LAN discovery Phase 2 — gateway discovery engine + /api/lan-scan", body summarising the engine + endpoint + the new `multicast-dns` dependency + the capability flag, with the spec/plan links. Omit any Claude-attribution footer (project norm). Then hand off to the user for review/merge.

---

## Notes for the executor

- **Branch base:** start Phase 2 from `main` **after Phase 1 (PR #10) is merged** — Phase 2 depends on `categories.js` + `lanInterfaces.js` + the Phase-1 telemetry block existing on `main`. If Phase 1 isn't merged yet, branch from the Phase-1 branch (currently `feat/lan-discovery-phase1-telemetry`) and note the dependency in the PR. (The Phase-2 plan doc itself is already committed on local `main` as `25f35a4`.)
- **New dependency:** `multicast-dns` (mDNS only). SSDP is hand-rolled (no dep). If registry access is unavailable at execution time, Task 5 is BLOCKED — surface it rather than hand-rolling mDNS ad hoc.
- **No `NET_RAW`:** the active source is a TCP-connect sweep; MACs come from `/proc/net/arp`. Container capabilities are unchanged from Phase 1 — do NOT add `NET_RAW` to docker-compose.
- **Capability flag ordering:** `lan_discovery: true` (Task 10) is what makes the server show the discovery UI. It MUST ship together with the `/api/lan-scan` endpoint (same release) — never set it without the endpoint, or the server surfaces a 404 button (the whole reason it was deferred from Phase 1).
- **Socket modules are smoke-covered, not unit-tested:** `discoverMdns`/`discoverSsdp` (live multicast) and the full `sweep` against a real subnet aren't deterministically unit-testable; their PURE parts (`mapMdnsResponse`, `parseSsdpResponse`, `locationHostPort`, `hostsInSubnet`, `parseArp`, `probePort` against localhost, the merge/filter logic) are. This mirrors how `wol.test.js` tests `buildMagicPacket` not the live broadcast.
- **No manual version bump, no `Co-Authored-By`.**
- Out of scope (later): true raw-socket ARP (`NET_RAW`) is a ROADMAP backlog add-on; persistent inventory belongs to a future feature; the server side (ingest/cache/SSE/API/UI) is **Phase 3**.
