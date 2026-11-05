'use strict';

// Signaturprüfung der Plugin-Pakete – dasselbe Format wie der Server
// (gatecontrol src/services/plugins/signature.js, docs/plugins.md "Signature"):
//
//   Datei `signature` = { "v": 1, "alg": "Ed25519", "publicKey": "<base64 raw 32>", "sig": "<base64 64>" }
//   signiert über "GCPLUGIN-MANIFEST-V1\n" + je Datei (Pfade in Byte-Reihenfolge,
//   ohne `signature`): "<sha256 hex> <pfad>\n"
//
// Ergebnis: none | trusted | untrusted | invalid. Vertrauenswürdige Schlüssel
// liegen als Datei im Image (trusted-keys.txt, Kopie von BUILTIN_PUBLIC_KEYS
// des Servers; scripts/check-edge-trusted-keys.js erkennt Abweichungen) plus
// optional GC_EDGE_PUBKEYS (JSON-Liste, wie GC_PLUGIN_PUBKEYS am Server).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SIGNATURE_FILE = 'signature';
const HEADER = 'GCPLUGIN-MANIFEST-V1\n';
const B64_32 = /^[A-Za-z0-9+/]{43}=$/;
const KEYS_FILE = path.join(__dirname, 'trusted-keys.txt');

function canonicalManifest(files) {
  const paths = [...files.keys()].filter((p) => p !== SIGNATURE_FILE).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let out = HEADER;
  for (const p of paths) out += crypto.createHash('sha256').update(files.get(p)).digest('hex') + ' ' + p + '\n';
  return Buffer.from(out, 'utf8');
}

function publicKeyFromRaw(b64) {
  if (typeof b64 !== 'string' || !B64_32.test(b64)) throw new Error('invalid public key');
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32) throw new Error('invalid public key');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** Schlüssel aus dem Text der Schlüsseldatei: eine base64-Zeile je Schlüssel, # = Kommentar. */
function parseKeyFile(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const s = line.replace(/#.*$/, '').trim();
    if (!s) continue;
    if (!B64_32.test(s)) throw new Error('invalid key line in trusted-keys.txt');
    out.push(s);
  }
  return out;
}

let fileKeys = null;
function builtinKeys() {
  if (!fileKeys) fileKeys = Object.freeze(parseKeyFile(fs.readFileSync(KEYS_FILE, 'utf8')));
  return fileKeys;
}

function trustedKeys(env = process.env) {
  const out = [...builtinKeys()];
  const extra = env.GC_EDGE_PUBKEYS;
  if (extra && extra.trim()) {
    try {
      const list = JSON.parse(extra);
      if (Array.isArray(list)) for (const k of list) if (typeof k === 'string' && B64_32.test(k.trim())) out.push(k.trim());
    } catch { /* unlesbar = nichts zusätzlich vertrauen */ }
  }
  return [...new Set(out)];
}

function keyId(b64) {
  return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16);
}

/**
 * @param {Map<string,Buffer>} files
 * @param {string[]} [keys] vertrauenswürdige Schlüssel (Standard: trustedKeys())
 */
function verify(files, keys = trustedKeys()) {
  const sf = files.get(SIGNATURE_FILE);
  if (!sf) return { status: 'none' };
  let doc;
  try { doc = JSON.parse(sf.toString('utf8')); } catch { return { status: 'invalid' }; }
  if (!doc || doc.v !== 1 || doc.alg !== 'Ed25519' || typeof doc.sig !== 'string' || typeof doc.publicKey !== 'string') return { status: 'invalid' };
  let key;
  try { key = publicKeyFromRaw(doc.publicKey); } catch { return { status: 'invalid' }; }
  const sig = Buffer.from(doc.sig, 'base64');
  let ok = false;
  try { ok = sig.length === 64 && crypto.verify(null, canonicalManifest(files), key, sig); } catch { ok = false; }
  if (!ok) return { status: 'invalid' };
  return { status: keys.includes(doc.publicKey) ? 'trusted' : 'untrusted', publicKey: doc.publicKey, keyId: keyId(doc.publicKey) };
}

/**
 * Darf ein Paket mit diesem Prüfergebnis laufen? invalid → nie; none/untrusted
 * → nur mit allowUnsigned (Schalter je Gateway am Server, mit Warnung).
 */
function acceptable(status, allowUnsigned) {
  if (status === 'trusted') return true;
  if (status === 'invalid') return false;
  return allowUnsigned === true && (status === 'none' || status === 'untrusted');
}

/** Signieren – nur für Tests und eigene Werkzeuge (der Server signiert beim Paketbau). */
function sign(files, privateKey) {
  const pub = crypto.createPublicKey(privateKey);
  const raw = Buffer.from(pub.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const sig = crypto.sign(null, canonicalManifest(files), privateKey);
  const out = new Map(files);
  out.set(SIGNATURE_FILE, Buffer.from(JSON.stringify({ v: 1, alg: 'Ed25519', publicKey: raw, sig: sig.toString('base64') }), 'utf8'));
  return { files: out, publicKey: raw };
}

module.exports = { SIGNATURE_FILE, KEYS_FILE, canonicalManifest, verify, acceptable, trustedKeys, parseKeyFile, publicKeyFromRaw, keyId, sign };
