'use strict';

// Hilfen für die Edge-Tests: Pakete im .gcplugin-Format bauen und signieren.
// Schlüssel werden zur Laufzeit erzeugt (keine Schlüssel im Repo).

const crypto = require('node:crypto');
const gcplugin = require('../../src/edge/gcplugin');
const signature = require('../../src/edge/signature');

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  return { privateKey, publicKeyB64: raw };
}

const EDGE_SOURCE = `module.exports = { start(gc) { gc.handle('ping', (p) => ({ pong: p })); } };\n`;

/**
 * @param {object} o
 * @param {'trusted'|'untrusted'|'none'|'invalid'} [o.sign]
 * @param {object} [o.trusted] keyPair() des vertrauenswürdigen Herausgebers
 */
function makePackage({ id = 'demo-edge', version = '1.0.0', edge, extraFiles = {}, sign = 'trusted', trusted, manifest = {} } = {}) {
  const m = {
    id, version, name: 'Demo', publisher: 'Test',
    edge: edge || { entry: 'edge/index.js', minGateway: '1.0.0', memoryMb: 32, capabilities: { udp: { ports: [40000], multicast: [] } } },
    ...manifest,
  };
  let files = new Map([
    ['plugin.json', Buffer.from(JSON.stringify(m))],
    ['edge/index.js', Buffer.from(EDGE_SOURCE)],
    ['server/index.js', Buffer.from('module.exports = {};\n')],
  ]);
  for (const [k, v] of Object.entries(extraFiles)) files.set(k, Buffer.isBuffer(v) ? v : Buffer.from(v));
  if (sign === 'trusted' || sign === 'invalid') files = signature.sign(files, trusted.privateKey).files;
  if (sign === 'untrusted') files = signature.sign(files, keyPair().privateKey).files;
  if (sign === 'invalid') files.set('edge/index.js', Buffer.from(EDGE_SOURCE + '// changed after signing\n'));
  const buf = gcplugin.encode(files);
  return { buf, sha256: crypto.createHash('sha256').update(buf).digest('hex'), manifest: m };
}

module.exports = { keyPair, makePackage, EDGE_SOURCE };
