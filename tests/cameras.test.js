'use strict';

// Kameras im Heimnetz (docs/cameras.md): Config, XML, Digest, ONVIF über eine
// Test-Kamera (fremde Adressen in den Antworten!), Ereignisse → Clip,
// WS-Discovery-Antworten, fMP4, Zugänge, Mgmt-Routen und – wenn ffmpeg da ist –
// der Wächter des Dienstes kameras mit echtem ffmpeg.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const express = require('express');

const { normalizeCameras, hostAllowed, parseCidr, mayRecord } = require('../src/cameras/config');
const xml = require('../src/cameras/xml');
const camHttp = require('../src/cameras/http');
const onvif = require('../src/cameras/onvif');
const { parseMatches, scopesOf } = require('../src/cameras/discovery');
const { parsePlaylist } = require('../src/cameras/ring');
const fmp4 = require('../src/cameras/fmp4');
const { CredStore } = require('../src/cameras/creds');
const { CameraService, parseRtspUrl } = require('../src/cameras/cameras');
const { createCamerasRouter, range } = require('../src/api/routes/cameras');
const { sdpInfo } = require('../src/cameras/rtsp');
const { createFakeCamera, JPEG } = require('./helpers/fakeCamera');
const { normalizeFeatures } = require('../src/features/config');
const { CAPABILITIES } = require('../src/features/manager');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const CAM = (o = {}) => ({ id: 'c0123456789abcde', name: 'Einfahrt', host: '192.168.1.73', onvif: { port: 8000, path: '/onvif/device_service' }, record: 'motion', events: ['person', 'vehicle'], ...o });

describe('cameras: config', () => {
  it('normalizes features.cameras, drops what is not allowed', () => {
    const c = normalizeCameras({
      enabled: true, nobodyHome: true, credRev: 'abcdef0123', subnets: ['192.168.20.0/24', '8.8.8.0/24', '10.0.0.0/8'],
      cameras: [CAM(), CAM({ id: 'bad' }), CAM({ id: 'c111111111111111', host: '8.8.8.8' }), CAM({ id: 'c222222222222222', onvif: null, rtsp: { port: 554, path: '/stream1?a=b' }, record: 'away', retentionDays: 999, events: ['motion', 'x'] })],
    });
    assert.equal(c.enabled, true);
    assert.equal(c.nobodyHome, true);
    assert.deepEqual(c.subnets, ['192.168.20.0/24']);
    assert.equal(c.cameras.length, 2);
    assert.deepEqual(c.cameras[1].rtsp, { port: 554, path: '/stream1?a=b' });
    assert.equal(c.cameras[1].retentionDays, 90);
    assert.deepEqual(c.cameras[1].events, ['motion']);
    assert.equal(normalizeCameras(undefined).enabled, false);
    assert.equal(normalizeFeatures({}).cameras.enabled, false);
    assert.ok(CAPABILITIES.includes('cameras'));
  });
  it('hostAllowed: own LAN subnets or configured subnets, RFC 1918 only', () => {
    const own = [{ cidr: '192.168.1.0/24' }];
    assert.equal(hostAllowed('192.168.1.73', own), true);
    assert.equal(hostAllowed('192.168.2.5', own), false);
    assert.equal(hostAllowed('192.168.2.5', own, ['192.168.2.0/24']), true);
    assert.equal(hostAllowed('8.8.8.8', [{ cidr: '8.8.8.0/24' }]), false);
    assert.equal(hostAllowed('127.0.0.1', [{ cidr: '127.0.0.0/8' }]), false);
    assert.equal(parseCidr('192.168.1.7/24').cidr, '192.168.1.0/24');
    assert.equal(parseCidr('10.0.0.0/8'), null);
  });
  it('mayRecord: away only when nobody is at home (unknown = no)', () => {
    assert.equal(mayRecord({ record: 'away' }, true), true);
    assert.equal(mayRecord({ record: 'away' }, false), false);
    assert.equal(mayRecord({ record: 'away' }, null), false);
    assert.equal(mayRecord({ record: 'never' }, true), false);
    assert.equal(mayRecord({ record: 'motion' }, false), true);
  });
  it('parseRtspUrl keeps only rtsp with a clean path', () => {
    assert.deepEqual(parseRtspUrl('rtsp://u:p%40w@192.168.1.80:8554/live?ch=1'), { host: '192.168.1.80', port: 8554, path: '/live?ch=1', user: 'u', password: 'p@w' });
    assert.equal(parseRtspUrl('http://192.168.1.80/'), null);
    assert.equal(parseRtspUrl('rtsp://192.168.1.80/a#b'), null);
  });
});

describe('cameras: xml, digest, sdp', () => {
  it('parses SOAP with prefixes, entities, CDATA; refuses a DTD', () => {
    const r = xml.parse('<?xml version="1.0"?><s:Envelope xmlns:s="x"><s:Body><a:Uri>rtsp://x/?a=1&amp;b=2</a:Uri><t x:Name="n" Value="v"/><c><![CDATA[<raw>]]></c></s:Body></s:Envelope>');
    assert.equal(xml.textOf(r, 'Uri'), 'rtsp://x/?a=1&b=2');
    assert.equal(xml.find(r, 't').attrs.Name, 'n');
    assert.equal(xml.textOf(r, 'c'), '<raw>');
    assert.throws(() => xml.parse('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), /dtd/);
  });
  it('digest answer as in RFC 2617 (Mufasa)', () => {
    const ch = camHttp.parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    const h = camHttp.digestAuth(ch, { user: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html' });
    const cnonce = /cnonce="([^"]+)"/.exec(h)[1];
    const H = (s) => crypto.createHash('md5').update(s).digest('hex');
    const want = H(`${H('Mufasa:testrealm@host.com:Circle Of Life')}:dcd98b7102dd2f0e8b11d0f600bfb0c093:00000001:${cnonce}:auth:${H('GET:/dir/index.html')}`);
    assert.match(h, new RegExp(`response="${want}"`));
    assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
    assert.equal(camHttp.authFor('Basic realm="x"', { user: 'a', password: 'b', method: 'GET', uri: '/', allowBasic: false }), null);
  });
  it('SDP: codec and audio', () => {
    assert.deepEqual(sdpInfo('v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H265/90000\r\nm=audio 0 RTP/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC/16000\r\n'), { codec: 'h265', audio: true });
  });
});

describe('cameras: ONVIF events and discovery', () => {
  it('classify: Reolink topics, Tapo items, plain motion', () => {
    assert.deepEqual(onvif.classify('tns1:RuleEngine/MyRuleDetector/PeopleDetect', { State: 'true' }), [{ kind: 'person', active: true }]);
    assert.deepEqual(onvif.classify('tns1:RuleEngine/MyRuleDetector/DogCatDetect', { State: 'false' }), [{ kind: 'animal', active: false }]);
    assert.deepEqual(onvif.classify('tns1:RuleEngine/TPSmartEventDetector/TPSmartEvent', { IsVehicle: 'true' }), [{ kind: 'vehicle', active: true }]);
    assert.deepEqual(onvif.classify('tns1:RuleEngine/CellMotionDetector/Motion', { IsMotion: '1' }), [{ kind: 'motion', active: true }]);
    assert.deepEqual(onvif.classify('tns1:Device/Trigger/DigitalInput', { LogicalState: 'true' }), []);
    assert.equal(onvif.kindOfName('VideoSourceConfigurationToken'), null);
    assert.equal(onvif.kindOfName('Communication'), null);
  });
  it('ProbeMatches: only the answering address, scopes as names', () => {
    const pm = '<e:Envelope xmlns:e="x" xmlns:d="y"><e:Body><d:ProbeMatches><d:ProbeMatch><d:Types>dn:NetworkVideoTransmitter</d:Types>'
      + '<d:Scopes>onvif://www.onvif.org/name/Reolink%20E1 onvif://www.onvif.org/hardware/E1_Zoom</d:Scopes>'
      + '<d:XAddrs>http://10.9.9.9/onvif/device_service http://192.168.1.73:8000/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>';
    assert.deepEqual(parseMatches(Buffer.from(pm), '192.168.1.73'), [{ host: '192.168.1.73', port: 8000, path: '/onvif/device_service', name: 'Reolink E1', hardware: 'E1 Zoom', manufacturer: null }]);
    assert.equal(scopesOf('onvif://www.onvif.org/mfr/TP-Link').manufacturer, 'TP-Link');
  });
  it('the discovery socket is bound to 0.0.0.0, the LAN address only picks the interface', async () => {
    const calls = [];
    const fake = {
      on() {}, bind(o, cb) { calls.push(['bind', o.address, o.port]); cb(); }, setMulticastInterface(ip) { calls.push(['iface', ip]); },
      setMulticastTTL() {}, addMembership(g, ip) { calls.push(['join', g, ip]); }, send(b, port, g) { calls.push(['send', port, g]); }, close() {},
    };
    const { discover } = require('../src/cameras/discovery');
    await discover({ subnets: [{ cidr: '192.168.1.0/24', localIp: '192.168.1.10' }], allowed: () => true, timeoutMs: 50, socketFactory: () => fake });
    assert.deepEqual(calls.slice(0, 4), [['bind', '0.0.0.0', 0], ['iface', '192.168.1.10'], ['join', '239.255.255.250', '192.168.1.10'], ['send', 3702, '239.255.255.250']]);
  });
});

describe('cameras: probe and events against a test camera', () => {
  let cam; let port; let dir; let svc; const posted = [];
  before(async () => {
    cam = createFakeCamera({ events: [] });
    port = await cam.listen();
    dir = tmp('gc-cam-');
    fs.mkdirSync(path.join(dir, 'ctl'));
    fs.mkdirSync(path.join(dir, 'rec'));
    const creds = { sync: async () => false, get: () => ({ user: 'admin', password: 'geheim' }), clear() {} };
    svc = new CameraService({
      reporter: { post: async (p, b) => { posted.push([p, b]); return { ok: true }; } },
      ctlDir: path.join(dir, 'ctl'), recDir: path.join(dir, 'rec'), stateDir: dir, creds,
    });
    svc.allowed = (h) => h === '127.0.0.1';
    await svc.apply({ enabled: true, cameras: [] });
  });
  after(async () => { svc.stop(); await cam.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('probe: device, profiles, stream and snapshot (host stays the camera address), test picture via digest', async () => {
    const r = await svc.probe({ host: '127.0.0.1', onvifPort: port, user: 'admin', password: 'geheim' });
    assert.equal(r.ok, true);
    assert.equal(r.info.manufacturer, 'Reolink');
    assert.equal(r.profiles.length, 2);
    assert.deepEqual(r.rtsp, { port: 554, path: '/h264Preview_01_main' });
    assert.deepEqual(r.events.kinds, ['person', 'vehicle', 'animal', 'motion']);
    assert.equal(Buffer.from(r.snapshot.data, 'base64').equals(JPEG), true);
    assert.equal(JSON.stringify(r).includes('geheim'), false);
  });
  it('probe: wrong password → auth_failed, foreign address → not_allowed', async () => {
    await assert.rejects(svc.probe({ host: '127.0.0.1', onvifPort: port, user: 'admin', password: 'falsch' }), (e) => e.code === 'auth_failed' && e.status === 401);
    await assert.rejects(svc.probe({ host: '192.168.99.1', user: 'a', password: 'b' }), (e) => e.code === 'not_allowed');
    await assert.rejects(svc.probe({ rtspUrl: 'rtsp://8.8.8.8/x' }), (e) => e.code === 'not_allowed');
  });
  it('a person event over PullPoint is reported (start, end)', async () => {
    svc.allowed = () => true; // die Test-Kamera liegt auf 127.0.0.1
    await svc.apply({ enabled: true, nobodyHome: null, cameras: [{ id: 'c0123456789abcde', name: 'Einfahrt', host: '192.168.1.73', onvif: { port, path: '/onvif/device_service' }, record: 'motion', events: ['person'] }] });
    const rt = svc.cams.get('c0123456789abcde');
    rt.cam.host = '127.0.0.1'; // nur RFC 1918 kommt durch den Config-Pull – die Test-Kamera hört auf 127.0.0.1
    await svc.resolve(rt);
    assert.equal(rt.state, 'ok');
    assert.equal(rt.info.events.path, '/onvif/events');
    cam.push({ topic: 'tns1:RuleEngine/MyRuleDetector/PeopleDetect', items: { State: 'true' } });
    await svc.tick();
    for (let i = 0; i < 40 && !rt.event; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(rt.event, 'event started');
    assert.equal(rt.event.kind, 'person');
    svc.onMessage(rt, { topic: 'tns1:RuleEngine/MyRuleDetector/PeopleDetect', items: { State: 'false' } });
    rt.event.endAt = Date.now() - 1;
    svc.recordStep();
    assert.equal(rt.event, null);
    await svc._flush();
    const evs = posted.filter(([p]) => p === '/api/v1/gateway/cameras/events').flatMap(([, b]) => b.events);
    assert.deepEqual(evs.map((e) => e.phase), ['start', 'end']);
    assert.equal(evs[0].kind, 'person');
    assert.ok(cam.state.subscribed >= 1);
    svc._stopEvents(rt);
  });
  it('record away + somebody at home: no events at all', () => {
    const rt = svc.cams.get('c0123456789abcde');
    rt.cam = { ...rt.cam, record: 'away' };
    svc.cfg.nobodyHome = false;
    assert.equal(svc.wantEvents(rt), false);
    svc.onMessage(rt, { topic: 'x/PeopleDetect', items: { State: 'true' } });
    assert.equal(rt.event, null);
  });
  it('snapshot: from the ONVIF snapshot address; unknown camera → 404', async () => {
    const s = await svc.snapshot('c0123456789abcde');
    assert.equal(s.data.equals(JPEG), true);
    await assert.rejects(svc.snapshot('c9999999999999999'), (e) => e.status === 404);
  });
});

describe('cameras: access data', () => {
  it('kept encrypted (0600) and read again with the same token only', async () => {
    const dir = tmp('gc-cred-');
    const data = { rev: 'aaaaaaaa11', cameras: { c0123456789abcde: { user: 'admin', password: 'geheim' }, bad: { user: 'x' } } };
    const a = new CredStore({ apiToken: 't1', stateDir: dir, fetcher: async () => data });
    assert.equal(await a.sync('aaaaaaaa11'), true);
    assert.equal(await a.sync('aaaaaaaa11'), false);
    const file = path.join(dir, 'cameras-cred.bin');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file).includes(Buffer.from('geheim')), false);
    assert.deepEqual(new CredStore({ apiToken: 't1', stateDir: dir, fetcher: async () => ({}) }).get('c0123456789abcde'), { user: 'admin', password: 'geheim' });
    assert.equal(new CredStore({ apiToken: 't2', stateDir: dir, fetcher: async () => ({}) }).get('c0123456789abcde'), null);
    a.clear();
    assert.equal(fs.existsSync(file), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cameras: playlist, range', () => {
  it('parses the HLS ring', () => {
    const p = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000,\n#EXT-X-PROGRAM-DATE-TIME:2026-11-06T21:56:57.098+0000\ns7.m4s\n#EXTINF:1.5,\n../x.m4s\n#EXTINF:2,\ns9.m4s\n');
    assert.deepEqual(p.segments.map((s) => [s.seq, s.name]), [[7, 's7.m4s'], [9, 's9.m4s']]);
    assert.equal(p.segments[0].at, Date.parse('2026-11-06T21:56:57.098Z'));
  });
  it('range header', () => {
    assert.deepEqual(range('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(range('bytes=-10', 100), { start: 90, end: 99 });
    assert.equal(range('bytes=200-', 100), false);
    assert.equal(range(undefined, 100), null);
  });
});

describe('cameras: mgmt rate limit', () => {
  it('answers 429 once the limit is used up', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createCamerasRouter({ featureMgr: { cameras: { cfg: { enabled: true }, live: () => ({ ready: false }) } }, limit: { windowMs: 60_000, limit: 2 } }));
    const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const u = `http://127.0.0.1:${srv.address().port}/api/cameras/live`;
    const post = () => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"c0123456789abcde"}' }).then((r) => r.status);
    assert.deepEqual([await post(), await post(), await post()], [200, 200, 429]);
    srv.close();
  });
});

describe('cameras: ring, clips and the kameras watcher (real ffmpeg)', { skip: !HAS_FFMPEG && 'ffmpeg not installed' }, () => {
  let dir; let child; let svc; let app; let srv; let base;
  const id = 'c0123456789abcde';
  before(async () => {
    dir = tmp('gc-ring-');
    const ctl = path.join(dir, 'ctl');
    fs.mkdirSync(path.join(ctl, 'run'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'rec'));
    const src = path.join(dir, 'src.mp4');
    assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10', '-t', '20', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', src]).status, 0);
    svc = new CameraService({ ctlDir: ctl, recDir: path.join(dir, 'rec'), creds: { sync: async () => false, get: () => null, clear() {} } });
    svc.allowed = () => true;
    await svc.apply({ enabled: true, cameras: [{ id, name: 'Test', host: '192.168.1.5', rtsp: { port: 554, path: '/x' }, record: 'motion', events: ['motion'] }] });
    svc.stop();
    assert.ok(fs.existsSync(path.join(ctl, 'kameras.sh')), 'the gateway installs the watcher');
    fs.writeFileSync(path.join(ctl, 'run', `${id}.env`), `URL=file:${src}\nAUDIO=0\n`, { mode: 0o600 });
    child = spawn('sh', [path.join(ctl, 'kameras.sh')], { env: { ...process.env, GC_CAM_DIR: ctl, GC_CAM_TMP: dir, GC_CAM_ALLOW_FILE: '1' }, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      const pl = svc.ring(id).playlist();
      if (pl && pl.segments.length >= 4 && fs.existsSync(path.join(ctl, 'media', id, 'snap.jpg'))) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    app = express();
    app.use(express.json());
    app.use('/api', createCamerasRouter({ featureMgr: { cameras: svc } }));
    await new Promise((r) => { srv = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${srv.address().port}/api`;
  });
  after(() => { if (child) child.kill('SIGTERM'); if (srv) srv.close(); svc.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('the watcher runs ffmpeg: ring, snapshot, alive', () => {
    assert.equal(svc.service(), 'managed');
    assert.equal(svc.ringState(id), 'running');
    const pl = svc.ring(id).playlist();
    assert.ok(pl.segments.length >= 4);
  });
  it('a clip from the ring: pre-roll, timestamps from 0, duration in mehd', () => {
    const rt = svc.cams.get(id);
    rt.state = 'ok';
    svc._startEvent(rt, Date.now(), ['motion']);
    assert.ok(rt.event.rec, 'clip started');
    const evId = rt.event.id;
    rt.event.endAt = Date.now() - 1;
    svc.recordStep();
    const f = svc.eventFile(evId, 'clip');
    assert.ok(f && f.size > 1000);
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,start_time', '-of', 'json', f.path], { encoding: 'utf8' });
    const fmt = JSON.parse(p.stdout).format;
    assert.equal(Number(fmt.start_time), 0);
    assert.ok(Number(fmt.duration) >= 4, `duration ${fmt.duration}`);
  });
  it('mgmt: playlist, init, live.mp4 starts with ftyp', async () => {
    const pl = await fetch(`${base}/cameras/${id}/live/index.m3u8`);
    assert.equal(pl.status, 200);
    assert.match(await pl.text(), /#EXT-X-MAP:URI="init.mp4"/);
    const init = await fetch(`${base}/cameras/${id}/live/init.mp4`);
    assert.equal(Buffer.from(await init.arrayBuffer()).toString('latin1', 4, 8), 'ftyp');
    assert.equal((await fetch(`${base}/cameras/${id}/live/..%2Fx`)).status, 400);
    const ctrl = new AbortController();
    const r = await fetch(`${base}/cameras/${id}/live.mp4?s=10`, { signal: ctrl.signal });
    const reader = r.body.getReader();
    const { value } = await reader.read();
    ctrl.abort();
    assert.equal(Buffer.from(value).toString('latin1', 4, 8), 'ftyp');
  });
  it('the init segment gives the browser codec string', () => {
    const info = fmp4.initInfo(svc.ring(id).read('init.mp4'));
    assert.match(fmp4.codecsString(info), /^avc1\.[0-9a-f]{6}$/);
  });
  it('the watcher stops ffmpeg and drops the ring when the job goes', async () => {
    fs.rmSync(path.join(dir, 'ctl', 'run', `${id}.env`));
    for (let i = 0; i < 20 && fs.existsSync(path.join(dir, 'ctl', 'media', id)); i++) await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(dir, 'ctl', 'media', id)), false);
  });
});
