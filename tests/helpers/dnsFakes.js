'use strict';

// Hilfen für die DNS-Tests: echte DoH-Gegenstelle (HTTP/2 + TLS mit
// selbstsigniertem Zertifikat) und ein „Router“ (UDP/TCP 53 auf 127.0.0.1),
// beide beantworten Anfragen aus einer Tabelle.

const http2 = require('node:http2');
const dgram = require('node:dgram');
const net = require('node:net');
const wire = require('../../src/dns/wire');
const { makeSelfSigned } = require('../../src/cache/selfsigned');

/** Antwort auf eine Anfrage aus `table`: name → { A: [ip], AAAA: [...], CNAME: target, rcode, ttl } */
function answer(queryBuf, table, { tcBig = false } = {}) {
  const q = wire.parseQuery(queryBuf);
  const e = table[q.name];
  if (!e) return wire.buildResponse(q, { rcode: wire.RCODE.NXDOMAIN });
  if (e.rcode) return wire.buildResponse(q, { rcode: e.rcode });
  const answers = [];
  let name = q.name;
  if (e.CNAME) {
    answers.push({ name, type: wire.TYPE.CNAME, ttl: e.ttl ?? 300, rdata: wire.encodeName(e.CNAME) });
    name = e.CNAME;
  }
  const target = e.CNAME ? table[e.CNAME] || {} : e;
  if (q.qtype === wire.TYPE.A) for (const ip of target.A || []) answers.push({ name, type: wire.TYPE.A, ttl: e.ttl ?? 300, rdata: wire.ipv4Rdata(ip) });
  if (q.qtype === wire.TYPE.AAAA) for (const ip of target.AAAA || []) answers.push({ name, type: wire.TYPE.AAAA, ttl: e.ttl ?? 300, rdata: Buffer.from(ip, 'hex') });
  if (q.qtype === wire.TYPE.TXT && e.TXT) {
    for (const t of e.TXT) {
      const b = Buffer.from(t);
      answers.push({ name, type: wire.TYPE.TXT, ttl: 300, rdata: Buffer.concat([Buffer.from([b.length]), b]) });
    }
  }
  const out = wire.buildResponse(q, { answers });
  if (tcBig && out.length > 512) {
    const t = Buffer.from(wire.buildResponse(q, {}));
    t.writeUInt16BE(t.readUInt16BE(2) | 0x0200, 2);
    return t;
  }
  return out;
}

async function startDoh(table, { status = 200, delayMs = 0 } = {}) {
  const tls = makeSelfSigned({ altNames: [{ dns: 'localhost' }, { ip: '127.0.0.1' }] });
  const seen = [];
  const server = http2.createSecureServer({ key: tls.key, cert: tls.cert });
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ headers, body });
      const send = () => {
        if (stream.destroyed) return;
        if (server.status !== 200) { stream.respond({ ':status': server.status }); stream.end(); return; }
        stream.respond({ ':status': 200, 'content-type': 'application/dns-message' });
        stream.end(answer(body, table));
      };
      if (delayMs) setTimeout(send, delayMs); else send();
    });
  });
  server.status = status;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server, seen, ca: tls.cert, port: server.address().port,
    url: `https://localhost:${server.address().port}/dns-query`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function startRouter(table, { port = 0 } = {}) {
  const seen = { udp: 0, tcp: 0 };
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => { seen.udp++; udp.send(answer(msg, table, { tcBig: true }), rinfo.port, rinfo.address); });
  await new Promise((r) => udp.bind(port, '127.0.0.1', r));
  const p = udp.address().port;
  const tcp = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        seen.tcp++;
        const out = answer(buf.subarray(2, 2 + buf.readUInt16BE(0)), table);
        const l = Buffer.alloc(2);
        l.writeUInt16BE(out.length, 0);
        c.end(Buffer.concat([l, out]));
      }
    });
  });
  await new Promise((r) => tcp.listen(p, '127.0.0.1', r));
  return { port: p, seen, close: () => { udp.close(); return new Promise((r) => tcp.close(() => r())); } };
}

module.exports = { startDoh, startRouter, answer };
