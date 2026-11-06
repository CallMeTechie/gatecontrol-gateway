'use strict';

// Gemeinsames für die Edge-Integrationstests: ein Fake-Server mit
// WebSocket-Endpunkt (gc-edge.v1) und Paket-Download, Beispielpakete des
// Echo-Edge-Teils und die Gateway-Seite (EdgeBridge) auf einem Unix-Socket.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');
const gcplugin = require('../../src/edge/gcplugin');
const signature = require('../../src/edge/signature');

const TOKEN = 'gc_gw_test_token';

function buildPackage({ key, sign = true, version = '1.0.0', caps, port }) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fixtures/edge/echo-plugin.js'), 'utf8')
    .replace('|| 40000', `|| ${port}`).replace('bind(40001', `bind(${port + 1}`);
  const manifest = { id: 'echo', version, name: 'Echo', edge: { entry: 'edge/index.js', memoryMb: 32, capabilities: caps || { udp: { ports: [port], multicast: [] } } } };
  let files = new Map([['plugin.json', Buffer.from(JSON.stringify(manifest))], ['edge/index.js', Buffer.from(src)], ['server/index.js', Buffer.from('x')]]);
  if (sign) files = signature.sign(files, key.privateKey).files;
  const buf = gcplugin.encode(files);
  return { buf, sha256: crypto.createHash('sha256').update(buf).digest('hex'), version };
}

class FakeServer {
  constructor() {
    this.msgs = [];
    this.waiters = [];
    this.ws = null;
    this.packages = new Map(); // version → Buffer
    this.auth = [];             // Authorization-Header der Verbindungen und Downloads
    this.httpHits = 0;
  }

  async listen() {
    this.http = http.createServer((req, res) => {
      this.auth.push(req.headers.authorization || null);
      const m = /^\/api\/v1\/gateway\/edge\/packages\/echo\/([^/]+)$/.exec(req.url);
      if (m && req.headers.authorization === `Bearer ${TOKEN}` && this.packages.has(m[1])) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(this.packages.get(m[1]));
        return;
      }
      if (req.url === '/lan-device') { this.httpHits++; res.end('hello from the lan'); return; }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocket.Server({ noServer: true, handleProtocols: () => 'gc-edge.v1' });
    this.http.on('upgrade', (req, sock, head) => {
      this.auth.push(req.headers.authorization || null);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
      this.wss.handleUpgrade(req, sock, head, (ws) => {
        this.ws = ws;
        ws.on('message', (d) => { const msg = JSON.parse(d); this.msgs.push(msg); this.check(); });
      });
    });
    await new Promise((r) => this.http.listen(0, '127.0.0.1', r));
    this.port = this.http.address().port;
    return this.port;
  }

  get url() { return `http://127.0.0.1:${this.port}`; }

  send(m) { this.ws.send(JSON.stringify(m)); }

  check() {
    for (const w of [...this.waiters]) {
      const hit = this.msgs.find(w.pred);
      if (hit) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(hit); }
    }
  }

  wait(pred, ms = 8000, what = 'message') {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, t: setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms) };
      this.waiters.push(w);
      this.check();
    });
  }

  clear() { this.msgs = []; }

  close() { try { this.ws && this.ws.terminate(); } catch { /* zu */ } this.http.close(); }
}

/** Gateway-Seite: EdgeBridge auf runDir/gw.sock, „LAN“ = 127.0.0.0/8. */
function makeBridge({ runDir, server, mqtt = null, extraServerAddrs = [] }) {
  const { EdgeBridge } = require('../../src/edge/bridge');
  const { makeLanGuard } = require('../../src/edge/lanGuard');
  return new EdgeBridge({
    runDir,
    upstream: () => ({ serverUrl: server.url, apiToken: TOKEN, serverAddrs: [] }),
    guard: makeLanGuard({ getSubnets: () => ['127.0.0.0/8'], tunnelIp: '127.9.9.9', serverAddrs: () => extraServerAddrs }),
    mqtt,
  });
}

module.exports = { TOKEN, buildPackage, FakeServer, makeBridge };
