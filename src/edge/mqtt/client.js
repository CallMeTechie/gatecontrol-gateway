'use strict';

// Kleiner MQTT-3.1.1-Client für das interne Konto des Edge-Hosts am lokalen
// Broker (127.0.0.1:1883): CONNECT mit Benutzer/Passwort, SUBSCRIBE/
// UNSUBSCRIBE, PUBLISH QoS 0/1 (beide Richtungen), PINGREQ. Bewusst ohne
// Abhängigkeiten – mehr braucht der Edge-Host nicht.

const net = require('node:net');
const EventEmitter = require('node:events');

const MAX_PACKET = 512 * 1024;
const T = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };

function encodeLength(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function str(s) {
  const b = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(2);
  h.writeUInt16BE(b.length);
  return Buffer.concat([h, b]);
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}

function connectPacket({ clientId, username, password, keepalive }) {
  let flags = 0x02; // clean session
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const body = [str('MQTT'), Buffer.from([4, flags]), u16(keepalive), str(clientId)];
  if (username) body.push(str(username));
  if (password) body.push(str(password));
  return packet(T.CONNECT, 0, Buffer.concat(body));
}

function publishPacket(topic, payload, { qos = 0, retain = false, id = 0 }) {
  const flags = (qos << 1) | (retain ? 1 : 0);
  return packet(T.PUBLISH, flags, Buffer.concat([str(topic), qos ? u16(id) : Buffer.alloc(0), payload]));
}

/** Zerlegt einen Byte-Strom in MQTT-Pakete: { type, flags, body }. */
class Parser {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0;
      let mul = 1;
      let i = 1;
      let done = false;
      for (; i < 5 && i < this.buf.length; i++) {
        len += (this.buf[i] & 0x7f) * mul;
        mul *= 128;
        if ((this.buf[i] & 0x80) === 0) { done = true; break; }
      }
      if (!done) { if (i >= 5) throw new Error('malformed length'); break; }
      if (len > MAX_PACKET) throw new Error('packet too large');
      const start = i + 1;
      if (this.buf.length < start + len) break;
      out.push({ type: this.buf[0] >> 4, flags: this.buf[0] & 0x0f, body: this.buf.subarray(start, start + len) });
      this.buf = this.buf.subarray(start + len);
    }
    return out;
  }
}

class MqttClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 1883, clientId, username, password, keepalive = 30, connectTimeoutMs = 5000 } = {}) {
    super();
    Object.assign(this, { host, port, clientId, username, password, keepalive, connectTimeoutMs });
    this.sock = null;
    this.connected = false;
    this.nextId = 0;
    this.pending = new Map(); // packetId → { resolve, reject, timer }
    this.pingTimer = null;
    this.lastIn = 0;
  }

  id() {
    this.nextId = (this.nextId % 65535) + 1;
    return this.nextId;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      this.sock = sock;
      const parser = new Parser();
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; clearTimeout(t); reject(e); } };
      const t = setTimeout(() => { fail(new Error('mqtt connect timeout')); sock.destroy(); }, this.connectTimeoutMs);
      sock.on('connect', () => sock.write(connectPacket(this)));
      sock.on('data', (d) => {
        this.lastIn = Date.now();
        let pkts;
        try { pkts = parser.push(d); } catch (e) { sock.destroy(e); return; }
        for (const p of pkts) {
          if (p.type === T.CONNACK) {
            const rc = p.body[1];
            if (rc !== 0) { fail(Object.assign(new Error(`mqtt connack ${rc}`), { code: rc === 4 || rc === 5 ? 'auth' : 'refused' })); sock.destroy(); return; }
            settled = true;
            clearTimeout(t);
            this.connected = true;
            this.startPing();
            resolve();
            this.emit('connect');
          } else {
            this.onPacket(p);
          }
        }
      });
      sock.on('error', (e) => fail(e));
      sock.on('close', () => {
        fail(new Error('mqtt connection closed'));
        const was = this.connected;
        this.connected = false;
        clearInterval(this.pingTimer);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('mqtt connection closed')); }
        this.pending.clear();
        if (this.sock === sock) this.sock = null;
        if (was) this.emit('close');
      });
    });
  }

  startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.sock) return;
      if (Date.now() - this.lastIn > this.keepalive * 1500) { this.sock.destroy(); return; }
      this.sock.write(packet(T.PINGREQ, 0, Buffer.alloc(0)));
    }, this.keepalive * 1000 / 2);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  onPacket(p) {
    switch (p.type) {
      case T.PUBLISH: {
        const qos = (p.flags >> 1) & 3;
        const tl = p.body.readUInt16BE(0);
        const topic = p.body.toString('utf8', 2, 2 + tl);
        let off = 2 + tl;
        if (qos > 0) {
          const id = p.body.readUInt16BE(off);
          off += 2;
          if (qos === 1) this.sock.write(packet(T.PUBACK, 0, u16(id)));
          // QoS 2 wird nie abonniert (subscribe nur mit QoS ≤ 1)
        }
        this.emit('message', topic, Buffer.from(p.body.subarray(off)), { qos, retain: (p.flags & 1) === 1 });
        break;
      }
      case T.PUBACK: case T.SUBACK: case T.UNSUBACK: {
        const id = p.body.readUInt16BE(0);
        const w = this.pending.get(id);
        if (w) { this.pending.delete(id); clearTimeout(w.timer); w.resolve(p.type === T.SUBACK ? [...p.body.subarray(2)] : null); }
        break;
      }
      default:
    }
  }

  request(buildPacket, timeoutMs = 10000) {
    if (!this.connected || !this.sock) return Promise.reject(Object.assign(new Error('mqtt not connected'), { code: 'not_available' }));
    const id = this.id();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('mqtt timeout'), { code: 'timeout' })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(buildPacket(id));
    });
  }

  async subscribe(filter, qos = 0) {
    const granted = await this.request((id) => packet(T.SUBSCRIBE, 2, Buffer.concat([u16(id), str(filter), Buffer.from([Math.min(1, qos)])])));
    if (!granted || granted[0] === 0x80) throw Object.assign(new Error(`mqtt subscribe ${filter} refused`), { code: 'denied' });
    return granted[0];
  }

  unsubscribe(filter) {
    return this.request((id) => packet(T.UNSUBSCRIBE, 2, Buffer.concat([u16(id), str(filter)])));
  }

  publish(topic, payload, { qos = 0, retain = false } = {}) {
    if (qos === 1) return this.request((id) => publishPacket(topic, payload, { qos: 1, retain, id }));
    if (!this.connected || !this.sock) return Promise.reject(Object.assign(new Error('mqtt not connected'), { code: 'not_available' }));
    this.sock.write(publishPacket(topic, payload, { qos: 0, retain }));
    return Promise.resolve(null);
  }

  end() {
    clearInterval(this.pingTimer);
    if (this.sock) {
      try { this.sock.end(packet(T.DISCONNECT, 0, Buffer.alloc(0))); } catch { /* zu */ }
      const s = this.sock;
      setTimeout(() => s.destroy(), 200).unref();
    }
    this.connected = false;
  }
}

module.exports = { MqttClient, Parser, encodeLength, connectPacket, publishPacket, T };
