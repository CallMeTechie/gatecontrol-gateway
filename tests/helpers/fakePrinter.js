'use strict';

// Ein Drucker mit Scanner zum Testen (IPP auf /ipp/print, eSCL unter /eSCL):
// antwortet auf Get-Printer-Attributes, Print-Job, Get-Job-Attributes und
// die eSCL-Aufrufe; merkt sich gedruckte Dokumente und Scan-Aufträge.

const http = require('node:http');
const https = require('node:https');
const ipp = require('../../src/print/ipp');

const { TAG, GROUP, OP } = ipp;

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.63</pwg:Version><pwg:MakeAndModel>HP OfficeJet 8020</pwg:MakeAndModel>
  <scan:Platen><scan:PlatenInputCaps>
    <scan:MinWidth>8</scan:MinWidth><scan:MaxWidth>2550</scan:MaxWidth><scan:MinHeight>8</scan:MinHeight><scan:MaxHeight>3508</scan:MaxHeight>
    <scan:SettingProfiles><scan:SettingProfile>
      <scan:ColorModes><scan:ColorMode>BlackAndWhite1</scan:ColorMode><scan:ColorMode>Grayscale8</scan:ColorMode><scan:ColorMode>RGB24</scan:ColorMode></scan:ColorModes>
      <scan:DocumentFormats><pwg:DocumentFormat>application/pdf</pwg:DocumentFormat><pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt></scan:DocumentFormats>
      <scan:SupportedResolutions><scan:DiscreteResolutions>
        <scan:DiscreteResolution><scan:XResolution>75</scan:XResolution><scan:YResolution>75</scan:YResolution></scan:DiscreteResolution>
        <scan:DiscreteResolution><scan:XResolution>200</scan:XResolution><scan:YResolution>200</scan:YResolution></scan:DiscreteResolution>
        <scan:DiscreteResolution><scan:XResolution>300</scan:XResolution><scan:YResolution>300</scan:YResolution></scan:DiscreteResolution>
        <scan:DiscreteResolution><scan:XResolution>600</scan:XResolution><scan:YResolution>600</scan:YResolution></scan:DiscreteResolution>
      </scan:DiscreteResolutions></scan:SupportedResolutions>
    </scan:SettingProfile></scan:SettingProfiles>
  </scan:PlatenInputCaps></scan:Platen>
  <scan:Adf><scan:AdfSimplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>4200</scan:MaxHeight></scan:AdfSimplexInputCaps>
    <scan:AdfDuplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth></scan:AdfDuplexInputCaps></scan:Adf>
</scan:ScannerCapabilities>`;

const STATUS_XML = (state) => `<?xml version="1.0"?><scan:ScannerStatus xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm"><pwg:Version>2.63</pwg:Version><pwg:State>${state}</pwg:State><scan:AdfState>ScannerAdfLoaded</scan:AdfState></scan:ScannerStatus>`;

function printerAttrs(o) {
  return [
    [TAG.enum, 'printer-state', o.state || 3],
    [TAG.keyword, 'printer-state-reasons', o.reasons || ['none']],
    [TAG.boolean, 'printer-is-accepting-jobs', o.accepting !== false],
    [TAG.text, 'printer-make-and-model', 'HP OfficeJet 8020 series'],
    [TAG.name, 'printer-name', 'HP_OfficeJet_8020'],
    [TAG.text, 'printer-location', 'Wohnzimmer'],
    [TAG.uri, 'printer-uuid', 'urn:uuid:f0d8a1b2-0000-1000-8000-00aabbccddee'],
    [TAG.boolean, 'color-supported', true],
    [TAG.keyword, 'sides-supported', ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge']],
    [TAG.keyword, 'print-color-mode-supported', ['auto', 'color', 'monochrome']],
    [TAG.mimeMediaType, 'document-format-supported', o.formats || ['application/octet-stream', 'application/pdf', 'image/jpeg', 'image/urf', 'image/pwg-raster']],
    [TAG.text, 'marker-names', ['Black', 'Cyan', 'Magenta', 'Yellow']],
    [TAG.name, 'marker-colors', ['#000000', '#00FFFF', '#FF00FF', '#FFFF00']],
    [TAG.integer, 'marker-levels', o.levels || [70, 55, 8, 40]],
    [TAG.keyword, 'marker-types', ['ink-cartridge', 'ink-cartridge', 'ink-cartridge', 'ink-cartridge']],
    [TAG.integer, 'marker-low-levels', [10, 10, 10, 10]],
  ];
}

const rangeOf = (lo, hi) => { const b = Buffer.alloc(8); b.writeInt32BE(lo, 0); b.writeInt32BE(hi, 4); return b; };

/** start({ printer: {…}, pages: n, scanBusy: k }) → { url, port, state, close } */
async function startFakePrinter(opts = {}) {
  const state = {
    printed: [], ippOps: [], scanJobs: [], deleted: [], opts: { ...opts },
    jobStates: new Map(), nextJobId: 100, pagesLeft: new Map(), busyLeft: new Map(),
  };
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url;
      if (req.method === 'POST' && url === '/ipp/print') {
        if (state.opts.down) { req.socket.destroy(); return; }
        const m = ipp.decodeResponse(body); // gleicher Kopf: version, operation-id, request-id
        const op = m.status;
        state.ippOps.push(op);
        const opAttrs = ipp.attrsOf(m, GROUP.operation);
        const jobAttrs = ipp.attrsOf(m, GROUP.job);
        const base = [[TAG.charset, 'attributes-charset', 'utf-8'], [TAG.naturalLanguage, 'attributes-natural-language', 'en']];
        let msg;
        if (op === OP.GET_PRINTER_ATTRIBUTES) {
          const attrs = printerAttrs(state.opts.printer || {});
          msg = Buffer.concat([ipp.encodeMessage(0, m.requestId, [[GROUP.operation, base], [GROUP.printer, attrs]]).subarray(0, -1),
            // copies-supported als rangeOfInteger (Rohwert)
            Buffer.from([TAG.rangeOfInteger, 0, 16]), Buffer.from('copies-supported'), Buffer.from([0, 8]), rangeOf(1, 99), Buffer.from([GROUP.end])]);
        } else if (op === OP.PRINT_JOB) {
          const status = state.opts.printStatus || 0;
          if (status === 0) {
            const id = state.nextJobId++;
            state.printed.push({ id, format: opAttrs['document-format'][0], name: opAttrs['job-name'][0], user: opAttrs['requesting-user-name'][0], copies: (jobAttrs.copies || [1])[0], sides: (jobAttrs.sides || [null])[0], color: (jobAttrs['print-color-mode'] || [null])[0], data: m.data });
            state.jobStates.set(id, state.opts.finalState || 9);
            msg = ipp.encodeMessage(0, m.requestId, [[GROUP.operation, base], [GROUP.job, [[TAG.integer, 'job-id', id], [TAG.enum, 'job-state', 3]]]]);
          } else msg = ipp.encodeMessage(status, m.requestId, [[GROUP.operation, base]]);
        } else if (op === OP.GET_JOB_ATTRIBUTES) {
          const id = opAttrs['job-id'][0];
          msg = ipp.encodeMessage(0, m.requestId, [[GROUP.operation, base], [GROUP.job, [[TAG.enum, 'job-state', state.jobStates.get(id) || 9], [TAG.keyword, 'job-state-reasons', ['job-completed-successfully']]]]]);
        } else msg = ipp.encodeMessage(0x0501, m.requestId, [[GROUP.operation, base]]);
        res.writeHead(200, { 'content-type': 'application/ipp' });
        res.end(msg);
        return;
      }
      if (url === '/eSCL/ScannerCapabilities' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(CAPS); return; }
      if (url === '/eSCL/ScannerStatus' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(STATUS_XML('Idle')); return; }
      if (url === '/eSCL/ScanJobs' && req.method === 'POST') {
        const id = 'job' + (state.scanJobs.length + 1);
        state.scanJobs.push({ id, settings: body.toString('utf8') });
        const feeder = /<pwg:InputSource>Feeder</.test(body.toString('utf8'));
        state.pagesLeft.set(id, feeder ? (state.opts.feederPages || 3) : 1);
        state.busyLeft.set(id, state.opts.scanBusy || 0);
        res.writeHead(201, { location: `http://${req.headers.host}/eSCL/ScanJobs/${id}` });
        res.end();
        return;
      }
      const nd = /^\/eSCL\/ScanJobs\/(job\d+)\/NextDocument$/.exec(url);
      if (nd && req.method === 'GET') {
        const id = nd[1];
        if (state.busyLeft.get(id) > 0) { state.busyLeft.set(id, state.busyLeft.get(id) - 1); res.writeHead(503); res.end(); return; }
        const left = state.pagesLeft.get(id) || 0;
        if (left <= 0) { res.writeHead(404); res.end(); return; }
        state.pagesLeft.set(id, left - 1);
        const page = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`page-${id}-${left}`), Buffer.from([0xff, 0xd9])]);
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(page);
        return;
      }
      const dj = /^\/eSCL\/ScanJobs\/(job\d+)$/.exec(url);
      if (dj && req.method === 'DELETE') { state.deleted.push(dj[1]); res.writeHead(200); res.end(); return; }
      res.writeHead(404); res.end();
    });
  };
  // opts.tls { cert, key }: IPP/eSCL über TLS (ipps/https) mit selbst signiertem Zertifikat
  const server = opts.tls ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** mDNS-Antwort eines Geräts mit Drucker (_ipp) und Scanner (_uscan) */
function mdnsPacket({ ip = '192.168.1.57', port = 631, esclPort = 80, uuid = 'F0D8A1B2-0000-1000-8000-00AABBCCDDEE', name = 'HP OfficeJet 8020 [A1B2C3]', tls = false } = {}) {
  const txt = (o) => Object.entries(o).map(([k, v]) => Buffer.from(`${k}=${v}`));
  const p = {
    answers: [
      { type: 'PTR', name: '_ipp._tcp.local', data: `${name}._ipp._tcp.local` },
      { type: 'PTR', name: '_uscan._tcp.local', data: `${name}._uscan._tcp.local` },
    ],
    additionals: [
      { type: 'SRV', name: `${name}._ipp._tcp.local`, data: { port, target: 'HP-OJ.local' } },
      { type: 'TXT', name: `${name}._ipp._tcp.local`, data: txt({ txtvers: 1, rp: 'ipp/print', ty: 'HP OfficeJet 8020 series', note: 'Wohnzimmer', UUID: uuid, Color: 'T', Duplex: 'T', pdl: 'application/pdf,image/jpeg,image/urf' }) },
      { type: 'SRV', name: `${name}._uscan._tcp.local`, data: { port: esclPort, target: 'HP-OJ.local' } },
      { type: 'TXT', name: `${name}._uscan._tcp.local`, data: txt({ txtvers: 1, rs: 'eSCL', ty: 'HP OfficeJet 8020 series', UUID: uuid, is: 'platen,adf' }) },
      { type: 'A', name: 'HP-OJ.local', data: ip },
    ],
  };
  if (tls) {
    // nur die TLS-Dienste (_ipps/_uscans) ankündigen
    const sw = (x) => String(x).replace('._ipp._tcp', '._ipps._tcp').replace('._uscan._tcp', '._uscans._tcp').replace(/^_ipp\._tcp/, '_ipps._tcp').replace(/^_uscan\._tcp/, '_uscans._tcp');
    for (const r of [...p.answers, ...p.additionals]) { r.name = sw(r.name); if (r.type === 'PTR') r.data = sw(r.data); }
  }
  return p;
}

// ─── HP OfficeJet Pro 8720, wie er im LAN wirklich antwortet ────────────
// Auf die PTR-Frage kommt nur der PTR; SRV und TXT erst auf die Nachfrage,
// die A-Adresse in einem eigenen Paket – mit Großbuchstaben im Rechnernamen
// (SRV nennt „hp5a3b2c.local“, A „HP5A3B2C.local“) und zusätzlich der
// Wi-Fi-Direct-Adresse des Druckers, dazu ein AAAA.

const HP = Object.freeze({
  name: 'HP OfficeJet Pro 8720 [5A3B2C]',
  host: 'HP5A3B2C.local',
  uuid: '1c852a4d-b800-1f08-abcd-ec8eb55a3b2c',
  model: 'HP OfficeJet Pro 8720',
});

const txtList = (o) => Object.entries(o).map(([k, v]) => Buffer.from(`${k}=${v}`));

/** Die Antwort auf eine Frage (PTR, SRV, TXT, A) wie der HP 8720 → Paket oder null. */
function hpAnswer(q, { ip = '192.168.1.57', direct = '192.168.223.1' } = {}) {
  const inst = (t) => `${HP.name}._${t}._tcp.local`;
  const lname = String(q.name).toLowerCase();
  const types = ['ipp', 'ipps', 'uscan'];
  if (q.type === 'PTR') {
    const t = types.find((x) => lname === `_${x}._tcp.local`);
    return t ? { answers: [{ type: 'PTR', name: `_${t}._tcp.local`, ttl: 4500, data: inst(t) }] } : null;
  }
  const t = types.find((x) => lname === inst(x).toLowerCase());
  if (t && q.type === 'SRV') return { answers: [{ type: 'SRV', name: inst(t), ttl: 120, data: { port: t === 'ipp' ? 631 : t === 'ipps' ? 443 : 80, target: HP.host.toLowerCase(), priority: 0, weight: 0 } }] };
  if (t && q.type === 'TXT') {
    const base = { txtvers: 1, ty: HP.model, product: '(HP OfficeJet Pro 8720)', UUID: HP.uuid, note: '' };
    const data = t === 'uscan' ? { ...base, rs: 'eSCL', is: 'platen,adf' } : { ...base, rp: 'ipp/print', Color: 'T', Duplex: 'T', pdl: 'application/pdf,image/jpeg,image/urf,image/pwg-raster' };
    return { answers: [{ type: 'TXT', name: inst(t).replace('._tcp.local', '._TCP.local'), ttl: 4500, data: txtList(data) }] };
  }
  if (q.type === 'A' && lname === HP.host.toLowerCase()) {
    return { answers: [{ type: 'A', name: HP.host, ttl: 120, data: direct }, { type: 'A', name: HP.host, ttl: 120, data: ip }], additionals: [{ type: 'AAAA', name: HP.host, ttl: 120, data: 'fe80::ee8e:b5ff:fe5a:3b2c' }] };
  }
  return null;
}

/** Die Antworten eines HP 8720 auf eine Suche mit Nachfrage – in getrennten Paketen. */
function hpPackets(opts = {}) {
  const out = [];
  for (const t of ['ipp', 'ipps', 'uscan']) out.push(hpAnswer({ name: `_${t}._tcp.local`, type: 'PTR' }, opts));
  for (const t of ['ipp', 'ipps', 'uscan']) {
    out.push(hpAnswer({ name: `${HP.name}._${t}._tcp.local`, type: 'SRV' }, opts));
    out.push(hpAnswer({ name: `${HP.name}._${t}._tcp.local`, type: 'TXT' }, opts));
  }
  out.push(hpAnswer({ name: HP.host, type: 'A' }, opts));
  return out;
}

/**
 * Ein multicast-dns-Ersatz für browse({ factory }): beantwortet Fragen wie
 * der HP 8720 (hpAnswer), merkt sich jede Frage und jede Socket-Einstellung.
 * fail: { mdns?: 'EADDRINUSE' } – dieser Socket meldet den Fehler gleich.
 */
function fakeMdnsFactory({ answer = hpAnswer, fail = {}, opts = {} } = {}) {
  const EventEmitter = require('node:events');
  const log = { sockets: [], queries: [] };
  const factory = (o) => {
    const m = new EventEmitter();
    const way = o.port === 0 ? 'legacy' : 'mdns';
    log.sockets.push({ way, ...o });
    m.destroy = () => { m.destroyed = true; };
    m.query = (q, rinfo) => {
      if (m.destroyed) throw new Error('destroyed');
      for (const question of q.questions) log.queries.push({ way, ...question, to: rinfo });
      for (const question of q.questions) {
        const p = answer(question, opts);
        if (p) setImmediate(() => { if (!m.destroyed) m.emit('response', JSON.parse(JSON.stringify(p), (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data) : v)), { address: opts.ip || '192.168.1.57', port: 5353 }); });
      }
    };
    if (fail[way]) setImmediate(() => m.emit('error', Object.assign(new Error(fail[way]), { code: fail[way] })));
    return m;
  };
  return { factory, log };
}

/**
 * Ein echter mDNS-Responder (UDP, multicast-dns) auf `port`, der wie der HP
 * 8720 antwortet: auf Fragen von Port `port` per Multicast an die Gruppe
 * (wie im LAN üblich), auf Fragen von einem anderen Port direkt an diesen
 * („Legacy Unicast“, RFC 6762 §6.7). multicast: false / legacy: false schaltet
 * einen der Wege ab.
 */
function startFakeMdnsResponder({ ifaceIp, port, multicast = true, legacy = true, ip = '192.168.1.57' }) {
  const mdns = require('multicast-dns')({ interface: ifaceIp, bind: '0.0.0.0', port, multicast: true, reuseAddr: true });
  const seen = [];
  mdns.on('query', (q, rinfo) => {
    const fromPort = rinfo.port === port;
    if ((fromPort && !multicast) || (!fromPort && !legacy)) return;
    for (const question of q.questions || []) {
      seen.push({ ...question, legacy: !fromPort });
      const p = hpAnswer(question, { ip });
      if (!p) continue;
      if (fromPort) mdns.respond(p, { port, address: '224.0.0.251' });
      else mdns.respond({ ...p, id: q.id, questions: [question] }, { port: rinfo.port, address: rinfo.address });
    }
  });
  return new Promise((resolve, reject) => {
    mdns.once('ready', () => resolve({ seen, close: () => new Promise((r) => mdns.destroy(r)) }));
    mdns.once('error', reject);
  });
}

module.exports = { startFakePrinter, mdnsPacket, CAPS, HP, hpAnswer, hpPackets, fakeMdnsFactory, startFakeMdnsResponder };
