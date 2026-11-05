'use strict';

// Beispiel-Edge-Teil für den Integrationstest: UDP-Echo über gc.lan.udp,
// Aufrufe, Ereignisse, gc.store, gc.config und eine Probe der Sperren.

module.exports = {
  async start(gc) {
    const port = (gc.config() && gc.config().port) || 40000;
    const sock = await gc.lan.udp.bind(port, {}, (msg, from) => {
      gc.emit('udp', { text: msg.toString('utf8'), from: from.address });
      sock.send(from.address, from.port, Buffer.concat([Buffer.from('echo:'), msg])).catch((e) => gc.log.error('send', e.message));
    });
    gc.handle('ping', (p) => ({ pong: p }));
    gc.handle('slow', () => new Promise(() => {}));
    gc.handle('fail', () => { throw Object.assign(new Error('kaputt'), { code: 'my_code' }); });
    gc.handle('crash', () => { setTimeout(() => process.exit(3), 10); return { ok: true }; });
    gc.handle('emit', (p) => { for (let i = 0; i < (p && p.n) || 0; i++) gc.emit('burst', { i }); return { sent: p.n }; });
    gc.handle('config', () => gc.config());
    gc.handle('store', async (p) => { await gc.store.set('k', p); return gc.store.get('k'); });
    gc.handle('udpTo', async (p) => {
      try { await gc.lan.udp.send(p.host, p.port, Buffer.from('x')); return { ok: true }; } catch (e) { return { code: e.code }; }
    });
    gc.handle('tcpTo', async (p) => {
      try { const s = await gc.lan.tcp.connect(p.host, p.port); s.destroy(); return { ok: true }; } catch (e) { return { code: e.code }; }
    });
    gc.handle('bindOther', async () => {
      try { await gc.lan.udp.bind(40001, {}, () => {}); return { ok: true }; } catch (e) { return { code: e.code }; }
    });
    gc.handle('probe', async () => {
      const out = {};
      const tryIt = (k, fn) => { try { fn(); out[k] = 'allowed'; } catch (e) { out[k] = e.code || e.message; } };
      tryIt('dgram', () => require('node:dgram').createSocket('udp4'));
      tryIt('net', () => require('node:net').connect(80, '127.0.0.1'));
      tryIt('child_process', () => require('node:child_process'));
      tryIt('fsRead', () => require('node:fs').readFileSync('/etc/hostname'));
      tryIt('fsWrite', () => require('node:fs').writeFileSync(require('node:path').join(__dirname, 'x.txt'), 'x'));
      tryIt('kill', () => process.kill(1, 0));
      tryIt('fetch', () => fetch('http://127.0.0.1/'));
      tryIt('env', () => { if (Object.keys(process.env).some((k) => /TOKEN|SECRET|GC_API/.test(k))) throw new Error('secret in env'); });
      return out;
    });
    gc.onConfig((c) => gc.emit('configured', c));
  },
};
