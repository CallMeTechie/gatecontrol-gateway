'use strict';

// Pakete der Edge-Teile (Vertrag Abschnitt 3): vom Server holen, SHA-256
// gegen den Sollzustand prüfen, Signatur selbst prüfen, Manifest prüfen,
// nur den Ordner von edge.entry + plugin.json entpacken nach
// <state>/packages/<id>/<version>/.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { LIMITS, TIMING, PACKAGES_PATH, assertId, assertVersion } = require('./constants');
const gcplugin = require('./gcplugin');
const signature = require('./signature');
const { validateEdgeManifest, ManifestError } = require('./manifest');
const { pinnedLookup } = require('./channel');

class PackageRejected extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const MANIFEST_FILE = 'plugin.json';
const READY_FILE = '.ready.json';

/**
 * Paket laden (Größe ≤ 20 MB): im Edge-Host über den Gateway-Socket
 * (`{ socketPath }`, das Gateway holt es mit seinem Token vom Server), sonst
 * direkt vom Server (Bearer apiToken – so lädt das Gateway selbst).
 */
function download({ serverUrl, apiToken, serverAddrs, socketPath }, id, version, { timeoutMs = TIMING.downloadTimeoutMs } = {}) {
  const rel = `${PACKAGES_PATH}/${encodeURIComponent(assertId(id))}/${encodeURIComponent(assertVersion(version))}`;
  let mod = http;
  let target;
  const opts = { method: 'GET', headers: { Accept: 'application/octet-stream' }, timeout: timeoutMs, agent: false };
  if (socketPath) {
    Object.assign(opts, { socketPath, path: rel });
  } else {
    target = new URL(serverUrl);
    target.pathname = target.pathname.replace(/\/+$/, '') + rel;
    if (target.protocol === 'https:') mod = https;
    opts.headers.Authorization = `Bearer ${apiToken}`;
    if (Array.isArray(serverAddrs) && serverAddrs.length) opts.lookup = pinnedLookup(() => serverAddrs);
  }
  return new Promise((resolve, reject) => {
    const cb = (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new PackageRejected(res.statusCode === 404 ? 'not_found' : 'download_failed', `package download: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > LIMITS.packageBytes) { req.destroy(new PackageRejected('too_large', 'package too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    };
    const req = target ? mod.request(target, opts, cb) : mod.request(opts, cb);
    req.on('timeout', () => req.destroy(new PackageRejected('download_failed', 'package download timed out')));
    req.on('error', (e) => reject(e instanceof PackageRejected ? e : new PackageRejected('download_failed', e.message)));
    req.end();
  });
}

/**
 * Paketinhalt prüfen (rein, ohne Dateisystem).
 * @returns {{files: Map, manifest: object, edge: object, signature: object}}
 */
function inspect(buf, { id, version, sha256, allowUnsigned, gatewayVersion, keys }) {
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  if (typeof sha256 !== 'string' || digest !== sha256.toLowerCase()) throw new PackageRejected('sha256_mismatch', 'package does not match the sha256 of the state');
  let files;
  try { files = gcplugin.decode(buf); } catch (e) { throw new PackageRejected('bad_package', e.message); }
  const sig = signature.verify(files, keys);
  if (sig.status === 'invalid') throw new PackageRejected('signature_invalid', 'the package signature does not verify — package was changed');
  if (!signature.acceptable(sig.status, allowUnsigned)) {
    throw new PackageRejected('unsigned', sig.status === 'untrusted' ? 'signed by an untrusted key and unsigned edge parts are not allowed' : 'unsigned edge parts are not allowed on this gateway');
  }
  const mf = files.get(MANIFEST_FILE);
  if (!mf) throw new PackageRejected('bad_manifest', 'plugin.json missing');
  if (mf.length > LIMITS.manifestBytes) throw new PackageRejected('bad_manifest', 'plugin.json too large');
  let manifest;
  try { manifest = JSON.parse(mf.toString('utf8')); } catch { throw new PackageRejected('bad_manifest', 'plugin.json is not JSON'); }
  if (manifest.id !== id) throw new PackageRejected('bad_manifest', 'plugin id does not match the state');
  if (manifest.version !== version) throw new PackageRejected('bad_manifest', 'plugin version does not match the state');
  let edge;
  try { edge = validateEdgeManifest(manifest, { gatewayVersion }); } catch (e) {
    if (e instanceof ManifestError) throw new PackageRejected(e.code === 'gateway_too_old' ? 'gateway_too_old' : 'bad_manifest', e.message);
    throw e;
  }
  if (!files.has(edge.entry)) throw new PackageRejected('bad_manifest', 'edge.entry is not in the package');
  return { files, manifest, edge, signature: sig };
}

class PackageStore {
  constructor({ packagesDir, logger }) {
    this.root = packagesDir;
    this.logger = logger || { info() {}, warn() {}, debug() {} };
  }

  dir(id, version) { return path.join(this.root, assertId(id), assertVersion(version)); }

  /** Bereits entpackte, geprüfte Version (oder null). */
  installed(id, version, sha256) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(this.dir(id, version), READY_FILE), 'utf8'));
      if (info && info.sha256 === String(sha256).toLowerCase() && info.edge && info.edge.entry) return { dir: this.dir(id, version), ...info };
    } catch { /* nicht vorhanden */ }
    return null;
  }

  /** Geprüftes Paket entpacken: nur der Ordner von edge.entry + plugin.json. */
  extract({ id, version, sha256 }, { files, manifest, edge, signature: sig }) {
    const dest = this.dir(id, version);
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true, mode: 0o750 });
    const prefix = edge.entryDir + '/';
    for (const [p, data] of files) {
      if (p !== MANIFEST_FILE && !p.startsWith(prefix)) continue;
      const target = path.join(tmp, p);
      if (!target.startsWith(tmp + path.sep)) throw new PackageRejected('bad_package', 'path outside the package folder');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
      fs.writeFileSync(target, data, { flag: 'wx', mode: 0o640 });
    }
    const info = { sha256: String(sha256).toLowerCase(), signature: sig.status, keyId: sig.keyId || null, edge, publisher: manifest.publisher || null, name: manifest.name || null };
    fs.writeFileSync(path.join(tmp, READY_FILE), JSON.stringify(info), { mode: 0o640 });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o750 });
    fs.renameSync(tmp, dest);
    return { dir: dest, ...info };
  }

  /** Alle Versionen eines Plugins außer `keep` löschen. */
  prune(id, keep = null) {
    const base = path.join(this.root, assertId(id));
    let names = [];
    try { names = fs.readdirSync(base); } catch { return; }
    for (const n of names) if (n !== keep) fs.rmSync(path.join(base, n), { recursive: true, force: true });
    if (!keep) fs.rmSync(base, { recursive: true, force: true });
  }

  /** Ordner von Plugins entfernen, die nicht mehr im Sollzustand stehen. */
  pruneExcept(ids) {
    let names = [];
    try { names = fs.readdirSync(this.root); } catch { return; }
    for (const n of names) if (!ids.has(n)) fs.rmSync(path.join(this.root, n), { recursive: true, force: true });
  }
}

module.exports = { download, inspect, PackageStore, PackageRejected, MANIFEST_FILE };
