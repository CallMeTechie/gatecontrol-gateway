# Gateway LAN Discovery — Phase 1 (Telemetry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gateway companion report its physical-LAN subnets and the discovery service-category catalogue in its heartbeat telemetry — **data only**, so the server can later render subnet/category checkboxes. This phase does **not** expose the `lan_discovery` capability flag (that comes in Phase 2), so a Phase-1-only gateway will not yet offer discovery.

**Architecture:** A small category-catalogue module and a LAN-interface enumerator under `src/discovery/`, wired into the existing `collectTelemetry()` in `src/health/telemetry.js`. The physical-LAN interface filter becomes a single shared function (`isPhysicalLan`) reused by both the new enumerator and the existing `wol.js` (removing a copy-paste filter that would otherwise drift). No new npm dependencies, no network calls, no new endpoints.

**Tech Stack:** Node ≥ 20, `node:os`, built-in `node --test` runner, pino logging. Repo: `gatecontrol-gateway`.

**Spec:** `gatecontrol/docs/superpowers/specs/2026-05-27-gateway-lan-discovery-design.md` (§4.4 categories, §6.2 telemetry, §9.1 per-port classification, §11 Phase 1).

---

## File Structure

- **Create** `src/discovery/categories.js` — the static service-category catalogue (keys, labels, ports, mDNS types, SSDP patterns). Phase 1 uses only `catalogue()` (keys+labels) for telemetry; Phase 2 reuses `CATEGORIES`. HTTP-vs-L4 is decided **per port** in Phase 2 (spec §9.1), so no per-category route class is stored. Single source of truth shared by gateway scan + server UI.
- **Create** `src/discovery/lanInterfaces.js` — enumerate physical-LAN IPv4 subnets as `{ iface, cidr, primary }`, excluding loopback / WireGuard (`gatecontrol0` **and** generic `wg*`) / Docker / VPN interfaces; skip `/32` host-routes. Owns the canonical `isPhysicalLan(name)` filter and the IPv4 helpers (`ipInCidr` etc.) that Phase 2's interface-guard will reuse. Pure functions, `ifaces` injectable for tests.
- **Modify** `src/wol.js` — replace its inline interface-exclusion filter (lines 40-43) with the shared `isPhysicalLan`, and drop the now-unused local `WG_INTERFACE` const. Removes the duplicate filter so WoL and discovery can't drift.
- **Modify** `src/health/telemetry.js` — add `lan_subnets` + `lan_discovery_categories` to `collectTelemetry()`; compute the default-gateway IP once and pass it in for primary-subnet detection.
- **Create** `tests/discovery_categories.test.js`, `tests/discovery_lanInterfaces.test.js`, `tests/telemetry_lan_discovery.test.js`.

---

## Task 1: Service-category catalogue

**Files:**
- Create: `src/discovery/categories.js`
- Test: `tests/discovery_categories.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, catalogue } = require('../src/discovery/categories');

test('catalogue() returns key+label only for every category', () => {
  const cat = catalogue();
  assert.equal(cat.length, CATEGORIES.length);
  for (const c of cat) {
    assert.deepEqual(Object.keys(c).sort(), ['key', 'label']);
    assert.equal(typeof c.key, 'string');
    assert.equal(typeof c.label, 'string');
  }
  assert.deepEqual(cat.map(c => c.key),
    ['web', 'media', 'remote_access', 'file_sharing', 'printers', 'databases', 'iot']);
});

test('CATEGORIES carry ports/mdns/ssdp for Phase 2', () => {
  const web = CATEGORIES.find(c => c.key === 'web');
  assert.ok(web.ports.includes(443) && web.ports.includes(80));
  assert.ok(web.mdns.includes('_http._tcp'));
  const iot = CATEGORIES.find(c => c.key === 'iot');
  assert.ok(iot.ports.includes(1883));
  // HTTP-vs-L4 is decided per-port in Phase 2 (spec §9.1) — no per-category routeClass.
  for (const c of CATEGORIES) assert.equal(c.routeClass, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/discovery_categories.test.js`
Expected: FAIL with `Cannot find module '../src/discovery/categories'`.

- [ ] **Step 3: Write the implementation**

```js
'use strict';

// Service-category catalogue for LAN discovery — the single source of truth
// shared by the gateway scan engine (Phase 2: ports/mdns/ssdp) and the server
// UI (keys+labels via telemetry). Each category bundles the signals across all
// three discovery sources. HTTP-vs-L4 is decided PER PORT in Phase 2 (spec §9.1),
// not per category — e.g. a printer's 631/IPP is HTTP while 9100/515 are L4 — so
// no per-category route class is stored here.
const CATEGORIES = [
  { key: 'web',           label: 'Web',              ports: [80, 443, 8080, 8443, 8000, 8081, 3000, 5000], mdns: ['_http._tcp', '_https._tcp'], ssdp: [] },
  { key: 'media',         label: 'Media',            ports: [32400, 8096, 8200], mdns: ['_googlecast._tcp', '_airplay._tcp'], ssdp: ['MediaServer', 'MediaRenderer'] },
  { key: 'remote_access', label: 'Remote access',    ports: [22, 3389, 5900], mdns: ['_ssh._tcp', '_rfb._tcp'], ssdp: [] },
  { key: 'file_sharing',  label: 'File sharing',     ports: [445, 139, 548, 2049, 21], mdns: ['_smb._tcp', '_afpovertcp._tcp'], ssdp: [] },
  { key: 'printers',      label: 'Printers',         ports: [9100, 631, 515], mdns: ['_ipp._tcp', '_pdl-datastream._tcp'], ssdp: ['Printer'] },
  { key: 'databases',     label: 'Databases',        ports: [5432, 3306, 6379, 27017], mdns: [], ssdp: [] },
  { key: 'iot',           label: 'IoT / Smart home', ports: [1883, 5683, 8123], mdns: ['_hap._tcp', '_matter._tcp', '_hue._tcp'], ssdp: ['Belkin', 'WeMo'] },
];

// Keys + labels only — what the server UI needs to render checkboxes, without
// leaking the full port lists into telemetry.
function catalogue() {
  return CATEGORIES.map(c => ({ key: c.key, label: c.label }));
}

module.exports = { CATEGORIES, catalogue };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/discovery_categories.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/discovery/categories.js tests/discovery_categories.test.js
git commit -m "feat(discovery): add LAN service-category catalogue"
```

---

## Task 2: LAN-interface / subnet enumeration

**Files:**
- Create: `src/discovery/lanInterfaces.js`
- Test: `tests/discovery_lanInterfaces.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lanSubnets, netmaskToPrefix, networkAddress, ipInCidr, isPhysicalLan } =
  require('../src/discovery/lanInterfaces');

const FAKE = {
  lo:           [{ address: '127.0.0.1',   netmask: '255.0.0.0',     family: 'IPv4', internal: true }],
  eth0:         [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  gatecontrol0: [{ address: '10.8.0.79',    netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  wg0:          [{ address: '10.9.0.2',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  docker0:      [{ address: '172.17.0.1',   netmask: '255.255.0.0',   family: 'IPv4', internal: false }],
};

test('helpers compute prefix / network / membership', () => {
  assert.equal(netmaskToPrefix('255.255.255.0'), 24);
  assert.equal(netmaskToPrefix('255.255.0.0'), 16);
  assert.equal(netmaskToPrefix('255.255.255.128'), 25);
  assert.equal(networkAddress('192.168.1.50', '255.255.255.0'), '192.168.1.0');
  assert.equal(ipInCidr('192.168.1.1', '192.168.1.0', 24), true);
  assert.equal(ipInCidr('192.168.2.1', '192.168.1.0', 24), false);
  assert.equal(ipInCidr('10.0.0.255', '10.0.0.0', 24), true);
});

test('isPhysicalLan excludes loopback / WG (gatecontrol0 + wg*) / docker / VPN', () => {
  assert.equal(isPhysicalLan('eth0'), true);
  assert.equal(isPhysicalLan('ens18'), true);
  assert.equal(isPhysicalLan('lo'), false);
  assert.equal(isPhysicalLan('gatecontrol0'), false);
  assert.equal(isPhysicalLan('wg0'), false);      // generic WireGuard
  assert.equal(isPhysicalLan('docker0'), false);
  assert.equal(isPhysicalLan('tailscale0'), false);
});

test('lanSubnets returns only physical LAN subnets, marks default-route subnet primary', () => {
  const subs = lanSubnets('192.168.1.1', FAKE);
  assert.deepEqual(subs, [{ iface: 'eth0', cidr: '192.168.1.0/24', primary: true }]);
});

test('lanSubnets marks the subnet containing the default gw as primary (non-first)', () => {
  const two = {
    eth0: [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    eth1: [{ address: '10.0.0.5',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  const subs = lanSubnets('10.0.0.1', two); // gw lives in eth1's subnet
  assert.equal(subs.filter(s => s.primary).length, 1);
  assert.equal(subs.find(s => s.cidr === '10.0.0.0/24').primary, true);
  assert.equal(subs.find(s => s.cidr === '192.168.1.0/24').primary, false);
});

test('lanSubnets: deterministic fallback to first when no gw match, exactly one primary', () => {
  const two = {
    eth0: [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    eth1: [{ address: '10.0.0.5',     netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  };
  const subs = lanSubnets(null, two); // no default gw → fall back to first
  assert.equal(subs.filter(s => s.primary).length, 1);
  assert.equal(subs[0].primary, true);
});

test('lanSubnets dedups same subnet and skips /32 host routes', () => {
  const ifaces = {
    eth0: [
      { address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false },
      { address: '192.168.1.51', netmask: '255.255.255.0', family: 'IPv4', internal: false }, // same /24 → dedup
    ],
    ens18: [{ address: '54.36.233.20', netmask: '255.255.255.255', family: 'IPv4', internal: false }], // /32 → skipped
  };
  const subs = lanSubnets('192.168.1.1', ifaces);
  assert.deepEqual(subs, [{ iface: 'eth0', cidr: '192.168.1.0/24', primary: true }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/discovery_lanInterfaces.test.js`
Expected: FAIL with `Cannot find module '../src/discovery/lanInterfaces'`.

- [ ] **Step 3: Write the implementation**

```js
'use strict';

const os = require('node:os');

const WG_INTERFACE = 'gatecontrol0';

// Canonical physical-LAN interface filter — the ONE copy (wol.js imports this).
// Excludes loopback, WireGuard (the GateControl tunnel `gatecontrol0` AND any
// generic `wg*`), Docker/bridge, and other VPN overlays.
function isPhysicalLan(name) {
  if (name === 'lo' || name.startsWith('wg') || name.startsWith(WG_INTERFACE)) return false;
  if (name.startsWith('docker') || name.startsWith('br-')) return false;
  if (name.startsWith('veth') || name.startsWith('tailscale')) return false;
  if (name.startsWith('zt') || name.startsWith('nebula')) return false; // ZeroTier, Nebula
  return true;
}

function netmaskToPrefix(netmask) {
  return netmask.split('.').map(Number).reduce(
    (bits, o) => bits + (((o >>> 0).toString(2).match(/1/g) || []).length), 0);
}

function _ipToInt(ip) {
  return ip.split('.').reduce((a, o) => ((a << 8) + (Number(o) & 255)) >>> 0, 0);
}

function networkAddress(ip, netmask) {
  const ipP = ip.split('.').map(Number);
  const mP = netmask.split('.').map(Number);
  return ipP.map((o, i) => o & mP[i]).join('.');
}

function ipInCidr(ip, network, prefix) {
  if (prefix <= 0) return true;
  const mask = prefix >= 32 ? 0xffffffff : (~(0xffffffff >>> prefix)) >>> 0;
  return ((_ipToInt(ip) & mask) >>> 0) === ((_ipToInt(network) & mask) >>> 0);
}

/**
 * Enumerate physical-LAN IPv4 subnets as { iface, cidr, primary }.
 * `defaultGwIp` (from telemetry.defaultGatewayIp) selects the primary subnet —
 * the one whose network contains the host default route. Exactly one entry is
 * flagged primary when at least one subnet exists (deterministic fallback: the
 * first). `/32` host-routes and `/0` are skipped (not scannable LANs), so a
 * VPS-style host with only a public `/32` yields an empty list. `ifaces` is
 * injectable for tests.
 */
function lanSubnets(defaultGwIp, ifaces = os.networkInterfaces()) {
  const entries = [];
  const seen = new Set();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!isPhysicalLan(name)) continue;
    for (const addr of (addrs || [])) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!addr.netmask || !addr.address) continue;          // defensive: malformed entry
      const prefix = netmaskToPrefix(addr.netmask);
      if (prefix <= 0 || prefix >= 32) continue;             // /0 and /32 aren't scannable LAN subnets
      const network = networkAddress(addr.address, addr.netmask);
      const cidr = `${network}/${prefix}`;
      if (seen.has(cidr)) continue;
      seen.add(cidr);
      entries.push({ iface: name, network, prefix, cidr });
    }
  }
  let primaryIdx = -1;
  if (defaultGwIp) {
    primaryIdx = entries.findIndex(e => ipInCidr(defaultGwIp, e.network, e.prefix));
  }
  if (primaryIdx === -1 && entries.length > 0) primaryIdx = 0; // deterministic fallback
  return entries.map((e, i) => ({ iface: e.iface, cidr: e.cidr, primary: i === primaryIdx }));
}

module.exports = { lanSubnets, isPhysicalLan, netmaskToPrefix, networkAddress, ipInCidr };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/discovery_lanInterfaces.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/discovery/lanInterfaces.js tests/discovery_lanInterfaces.test.js
git commit -m "feat(discovery): enumerate physical-LAN subnets with primary detection"
```

---

## Task 3: Share the physical-LAN filter with `wol.js` (de-duplicate)

`wol.js` currently has its own copy of the interface-exclusion filter (lines 40-43) that misses generic `wg*` interfaces. Point it at the canonical `isPhysicalLan` so WoL and discovery agree and the `wg*` fix applies to both. (WoL magic packets are L2 broadcasts that can't traverse a WireGuard tunnel anyway, so excluding `wg*` from WoL is correct.)

**Files:**
- Modify: `src/wol.js` (import near line 6; remove `WG_INTERFACE` const at line 8; replace filter at lines 40-43)
- Test: existing `tests/wol.test.js` (regression) — no new test file; `isPhysicalLan('wg0')` is already asserted in Task 2.

- [ ] **Step 1: Establish the baseline (existing wol tests green)**

Run: `node --test --test-force-exit tests/wol.test.js`
Expected: PASS (baseline before refactor).

- [ ] **Step 2: Add the import**

In `src/wol.js`, after `const logger = require('./logger');` (line 6), add:

```js
const { isPhysicalLan } = require('./discovery/lanInterfaces');
```

- [ ] **Step 3: Remove the now-unused local const**

Delete this line (line 8) — `isPhysicalLan` now owns the WG name knowledge, and leaving an unused const fails lint:

```js
const WG_INTERFACE = 'gatecontrol0';
```

- [ ] **Step 4: Replace the inline filter with the shared function**

In `sendMagicPacket`, replace these four lines:

```js
    if (name === 'lo' || name.startsWith(WG_INTERFACE)) continue;
    if (name.startsWith('docker') || name.startsWith('br-')) continue;
    if (name.startsWith('veth') || name.startsWith('tailscale')) continue;
    if (name.startsWith('zt') || name.startsWith('nebula')) continue; // ZeroTier, Nebula
```

with:

```js
    if (!isPhysicalLan(name)) continue;
```

- [ ] **Step 5: Run wol tests + lint to verify no regression**

Run: `node --test --test-force-exit tests/wol.test.js`
Expected: PASS (unchanged).
Run: `npx eslint src/wol.js`
Expected: 0 errors (no unused-var for the removed const).

- [ ] **Step 6: Commit**

```bash
git add src/wol.js
git commit -m "refactor(wol): use shared isPhysicalLan filter (also excludes wg*)"
```

---

## Task 4: Wire LAN data into telemetry

**Files:**
- Modify: `src/health/telemetry.js` (imports after line 13; `collectTelemetry()` body, lines ~105-138)
- Test: `tests/telemetry_lan_discovery.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('collectTelemetry exposes lan_subnets + category catalogue (data only)', () => {
  delete require.cache[require.resolve('../src/health/telemetry')];
  const { collectTelemetry } = require('../src/health/telemetry');
  const t = collectTelemetry();

  // lan_subnets: array of { iface, cidr, primary } (host-dependent contents → shape only)
  assert.ok(Array.isArray(t.lan_subnets));
  for (const s of t.lan_subnets) {
    assert.deepEqual(Object.keys(s).sort(), ['cidr', 'iface', 'primary']);
    assert.match(s.cidr, /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/);
  }
  // at most one primary (could be 0 on a host with no scannable LAN subnet)
  assert.ok(t.lan_subnets.filter(s => s.primary).length <= 1);

  // category catalogue: keys+labels
  assert.ok(Array.isArray(t.lan_discovery_categories));
  assert.deepEqual(t.lan_discovery_categories.map(c => c.key),
    ['web', 'media', 'remote_access', 'file_sharing', 'printers', 'databases', 'iot']);

  // Phase 1 must NOT advertise the capability flag (that is Phase 2)
  assert.equal(t.lan_discovery, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/telemetry_lan_discovery.test.js`
Expected: FAIL — `t.lan_subnets` is `undefined` (assert on `Array.isArray` fails).

- [ ] **Step 3: Add the imports**

In `src/health/telemetry.js`, after the existing `const logger = require('../logger');` line (line 13), add:

```js
const { lanSubnets } = require('../discovery/lanInterfaces');
const { catalogue } = require('../discovery/categories');
```

- [ ] **Step 4: Compute the default-gateway IP once and add the LAN-discovery fields**

In `collectTelemetry()`, replace this block:

```js
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const _lp = _readLastPull();
  return {
```

with:

```js
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const _lp = _readLastPull();
  const _gwIp = defaultGatewayIp();
  return {
```

Then replace the line:

```js
    default_gateway_ip: defaultGatewayIp(),
```

with:

```js
    default_gateway_ip: _gwIp,

    // LAN discovery — data only (Phase 1). The `lan_discovery` capability flag
    // is intentionally NOT set here; it is added in Phase 2 once /api/lan-scan
    // exists, so a Phase-1-only gateway won't surface a dead discovery button.
    lan_subnets: lanSubnets(_gwIp),
    lan_discovery_categories: catalogue(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --test-force-exit tests/telemetry_lan_discovery.test.js`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/health/telemetry.js tests/telemetry_lan_discovery.test.js
git commit -m "feat(telemetry): report lan_subnets + discovery category catalogue"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites PASS (the 3 new files + the unchanged `wol.test.js` regression; pre-existing tests intact).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 0 errors. (A `security/detect-object-injection` *warning* in `lanInterfaces.js` — array-index access in `netmaskToPrefix`/`networkAddress`, the same warning class already emitted by `wol.js` today — does not fail the lint. Do not "fix" it.)

> **Environment caveat for the executor:** this sandbox may have eslint 9 globally installed, which cannot read `.eslintrc.json` and makes a bare `eslint` error locally. The repo pins eslint **8.57.1** in `package-lock.json` and CI runs `npm ci` first. Run lint via `npm run lint` (which resolves the pinned local eslint), **not** a global `eslint`. Do not change the plan based on a local eslint-9 failure.

- [ ] **Step 3: Confirm telemetry shape end-to-end**

Run: `node -e "console.log(JSON.stringify(require('./src/health/telemetry').collectTelemetry().lan_discovery_categories))"`
Expected: a JSON array of `{key,label}` objects starting with `{"key":"web","label":"Web"}`.

- [ ] **Step 4: Push (releases Phase 1 via CI)**

> Per project convention CI auto-bumps the version on push (`feat:` → minor) and publishes to GHCR — **no manual version bump**. CI also enforces a coverage gate (≥70%) and runs a mutation-test job; the three new test files cover the new modules, so the gate should hold. Pushing here ships Phase 1. It is data-only (no capability flag → the server won't offer discovery), so it is safe to deploy ahead of Phase 2/3.

```bash
git push
```

- [ ] **Step 5: Deploy intent**

> Per project convention (`feedback_cicd_deploy_flow`: pull image after build → deploy promptly). Phase 1 is data-only and harmless, so deploying the new gateway image promptly is fine — but **not required** until Phase 2 lands. Operator's call: deploy now to verify telemetry on the real fleet, or hold the deploy until Phase 2 to ship the discovery capability in one go. State the choice when executing.

---

## Notes for the executor

- **No new dependencies** — everything uses `node:os` / built-ins. Do not add `multicast-dns`/SSDP libs here; those belong to Phase 2.
- **No manual version bump**, **no `Co-Authored-By` trailer** in commits (project conventions).
- `lan_subnets` contents are host-dependent (and may legitimately be **empty** on a VPS-style host with only a `/32` and a `wg*` tunnel — both are excluded by design); tests assert **shape**, not exact values, so they pass in CI containers.
- Phase 2 will `require('./categories').CATEGORIES` and `require('./lanInterfaces').{ lanSubnets, ipInCidr, isPhysicalLan }` — keep these exports stable. The Phase-2 interface-guard must reuse `isPhysicalLan`/`ipInCidr` (do not re-implement).
- HTTP-vs-L4 route classification is **per-port** in Phase 2 (spec §9.1), not per-category — `printers` is the mixed case (631/IPP → HTTP, 9100/515 → L4).
