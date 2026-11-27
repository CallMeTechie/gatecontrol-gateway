'use strict';

// „Videos umwandeln“ im Gateway (src/transcode/transcode.js, docs/transcode.md):
// die Auftragslogik gegen den echten Wächter umwandeln.sh – ffmpeg, ffprobe und
// vainfo sind Attrappen (tests/helpers/umwFakes.js). Dazu die Management-API.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { TranscodeService, TranscodeError, parseResult, parseCaps, parseRoots, parseTrash, SCRIPT, MAX_QUEUE } = require('../src/transcode/transcode');
const { createTranscodeRouter } = require('../src/api/routes/transcode');
const { createApiServer } = require('../src/api/server');
const { FeatureManager, CAPABILITIES } = require('../src/features/manager');
const { media, sandbox, startWatcher, waitFor } = require('./helpers/umwFakes');

function setup(t, { watcher = true, cfg = {}, svc = {} } = {}) {
  const sb = sandbox();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-umw-state-'));
  const reports = [];
  const x = { sb, stateDir, reports, clock: 0, reportResult: { ok: true, status: 200 } };
  const reporter = { post: async (p, body) => { reports.push({ path: p, body: JSON.parse(JSON.stringify(body)) }); return x.reportResult; } };
  x.make = (o = {}) => new TranscodeService({ reporter, stateDir, ctlDir: sb.ctl, pollMs: 20, tickMs: 40, reserveMb: 0, quickTimeoutMs: 5000, now: () => Date.now() + x.clock, ...svc, ...o });
  x.cfg = { enabled: true, roots: [sb.root], minFreeGb: 0, minFreePct: 0, ...cfg };
  x.svc = x.make();
  x.file = (rel, text) => {
    const f = path.join(sb.root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text === undefined ? media({ pad: 4000 }) : text);
    return f;
  };
  x.up = async () => {
    await x.svc.apply(x.cfg);
    if (watcher) { x.w = startWatcher(sb); await waitFor(() => x.svc.service() === 'managed' && x.svc.caps(), { what: 'service managed' }); }
  };
  x.job = (id) => x.svc.status().jobs.find((j) => j.id === id);
  x.until = (id, st, s = x.svc) => waitFor(() => { const j = s.status().jobs.find((v) => v.id === id); return j && j.state === st ? j : null; }, { what: `${id} ${st}` });
  t.after(async () => {
    x.svc.stop();
    sb.flag('hang', false);
    if (x.w) await x.w.stop('SIGKILL');
    sb.cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  return x;
}

const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof TranscodeError, e.stack); return [e.code, e.status]; } return null; };
const acode = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof TranscodeError, e.stack); return [e.code, e.status]; } return null; };

describe('TranscodeService: vom Auftrag bis zum Bericht', () => {
  it('legt Skript und Steuerdateien an, übergibt den Auftrag, übernimmt Fortschritt und Befund, meldet an den Server', async (t) => {
    const x = setup(t);
    await x.up();
    // was das Gateway ins Volume legt
    assert.ok(fs.readFileSync(path.join(x.sb.ctl, 'umwandeln.sh')).equals(fs.readFileSync(SCRIPT)));
    assert.equal(fs.readFileSync(path.join(x.sb.ctl, 'run'), 'utf8'), 'on\n');
    assert.equal(fs.readFileSync(path.join(x.sb.ctl, 'conf'), 'utf8'), 'TRASH_DAYS=14\nMIN_FREE_GB=0\nMIN_FREE_PCT=0\nVERIFY_DECODE=1\nRESERVE_MB=0\n');
    assert.equal(fs.statSync(path.join(x.sb.ctl, 'jobs')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(x.sb.ctl, 'state')).mode & 0o777, 0o770);
    assert.equal(fs.statSync(path.join(x.sb.ctl, 'umwandeln.sh')).mode & 0o777, 0o644);
    assert.ok(!fs.existsSync(path.join(x.sb.ctl, 'pause')));

    const src = x.file('Serie A/Folge 01.mkv');
    const before = fs.readFileSync(src, 'utf8');
    const v = x.svc.submit({ id: 'auftrag-0001', path: src });
    assert.deepEqual([v.id, v.path, v.state, v.percent, v.software, v.paused, v.result], ['auftrag-0001', src, 'queued', 0, false, false, null]);
    const done = await x.until('auftrag-0001', 'done');
    assert.equal(done.percent, 100);
    assert.equal(done.error, null);
    assert.ok(done.startedAt && done.finishedAt && done.submittedAt);
    assert.deepEqual(done.result.source, { codec: 'h264', profile: 'High 10', pixFmt: 'yuv420p10le', fieldOrder: 'progressive', container: 'matroska,webm', bits: 10, width: 1920, height: 1080, level: 42, fps: 50,
      video: 1, audio: 2, subtitles: 1, attachments: 2, pictures: 0, other: 0, chapters: 7, duration: 61.003, size: Buffer.byteLength(before) });
    assert.deepEqual([done.result.output.codec, done.result.output.profile, done.result.output.pixFmt, done.result.output.bits], ['h264', 'High', 'yuv420p', 8]);
    assert.equal(done.result.mode, 'vaapi_icq');
    assert.ok(done.result.trashPath.startsWith(path.join(x.sb.root, '.gc-papierkorb')));
    assert.equal(fs.readFileSync(done.result.trashPath, 'utf8'), before);
    assert.match(fs.readFileSync(src, 'utf8'), /^pix_fmt=yuv420p$/m);
    // die Auftragsdatei trug Qualität und „keine Software“; sie ist wieder weg
    await waitFor(() => fs.readdirSync(path.join(x.sb.ctl, 'jobs')).length === 0, { what: 'job file removed' });
    assert.match(x.sb.calls().find((c) => c.includes('-f matroska')), /-rc_mode ICQ -global_quality 23 /);

    const st = x.svc.status();
    assert.deepEqual([st.enabled, st.service, st.state], [true, 'managed', 'ready']);
    assert.deepEqual([st.caps.device, st.caps.encoders, st.caps.software, st.caps.ffmpeg, st.caps.vaH264Enc], ['ok', ['vaapi_icq', 'vaapi_qvbr'], true, '8.1.3-Fake', true]);
    assert.equal(st.caps.deviceGid, fs.statSync(path.join(x.sb.dir, 'renderD128')).gid);
    assert.deepEqual([st.roots[0].path, st.roots[0].state], [x.sb.root, 'ok']);
    assert.ok(st.roots[0].free > 0 && st.roots[0].total >= st.roots[0].free);
    assert.deepEqual(st.settings, { software: false, trashDays: 14, quality: 23, verifyDecode: true, minFreeGb: 0, minFreePct: 0 });
    assert.deepEqual(st.pause, { all: false, until: null });
    assert.deepEqual(st.trash.map((e) => [e.id, e.path, e.size]), [['auftrag-0001', src, Buffer.byteLength(before)]]);
    assert.equal(new Date(st.trash[0].expiresAt) - new Date(st.trash[0].at), 14 * 86400 * 1000);

    // Bericht an den Server: Zustand, Aufträge, Papierkorb (nur wenn er sich geändert hat)
    const last = await waitFor(() => x.reports.filter((r) => r.body.jobs.some((j) => j.state === 'done')).pop(), { what: 'report' });
    assert.equal(last.path, '/api/v1/gateway/transcode/report');
    assert.equal(last.body.jobs[0].result.mode, 'vaapi_icq');
    const withTrash = await waitFor(() => x.reports.find((r) => r.body.trash && r.body.trash.length === 1), { what: 'trash report' });
    assert.equal(withTrash.body.trash[0].id, 'auftrag-0001');
    assert.ok(x.reports.some((r) => r.body.jobs.some((j) => j.state === 'running')), 'der Start wurde gemeldet');

    const tel = x.svc.featureTelemetry();
    assert.deepEqual([tel.enabled, tel.service, tel.state, tel.device, tel.encoders, tel.software, tel.current], [true, 'managed', 'ready', 'ok', ['vaapi_icq', 'vaapi_qvbr'], false, null]);
    assert.deepEqual(tel.jobs, { queued: 0, done: 1, failed: 0 });
    assert.deepEqual(tel.trash, { count: 1, bytes: Buffer.byteLength(before) });
    assert.equal(tel.arch, process.arch);

    // quittiert → vergessen; die Warteschlange steht in /state/transcode.json
    assert.equal(JSON.parse(fs.readFileSync(path.join(x.stateDir, 'transcode.json'), 'utf8')).jobs.length, 1);
    assert.equal(x.svc.ack(['auftrag-0001', 'gibt-es-nicht']), 1);
    assert.deepEqual(x.svc.status().jobs, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(x.stateDir, 'transcode.json'), 'utf8')).jobs.length, 0);
  });

  it('ein Fehler des Wächters kommt mit Code und Protokoll-Ende an; der nächste Auftrag läuft', async (t) => {
    const x = setup(t);
    await x.up();
    x.sb.flag('encode_fails');
    const a = x.file('a.mkv');
    x.svc.submit({ id: 'fehler-0001', path: a });
    const f = await x.until('fehler-0001', 'failed');
    assert.equal(f.error, 'encode_failed');
    assert.deepEqual(f.result.log, ['Conversion failed!']);
    assert.equal(f.result.source.bits, 10);
    assert.equal(f.result.output, null);
    assert.equal(x.svc.featureTelemetry().error.code, 'encode_failed');
    x.sb.flag('encode_fails', false);
    x.svc.submit({ id: 'fehler-0002', path: a });
    await x.until('fehler-0002', 'done');
    assert.deepEqual(x.svc.featureTelemetry().jobs, { queued: 0, done: 1, failed: 1 });
  });

  it('Software nur, wenn das Gateway sie erlaubt (features.transcode.software) – der Auftrag allein reicht nicht', async (t) => {
    const x = setup(t);
    x.sb.flag('no_icq'); x.sb.flag('no_qvbr');
    await x.up();
    assert.equal(x.svc.state(), 'no_encoder');
    const a = x.file('a.mkv');
    assert.equal(x.svc.submit({ id: 'software-001', path: a, software: true }).software, false);
    assert.equal((await x.until('software-001', 'failed')).error, 'no_encoder');
    await x.svc.apply({ ...x.cfg, software: true });
    assert.equal(x.svc.state(), 'ready');
    assert.equal(x.svc.submit({ id: 'software-002', path: a, software: false }).software, false);
    assert.equal((await x.until('software-002', 'failed')).error, 'no_encoder');
    assert.equal(x.svc.submit({ id: 'software-003', path: a }).software, true);
    assert.equal((await x.until('software-003', 'done')).result.mode, 'software');
  });
});

describe('TranscodeService: Annahme von Aufträgen', () => {
  it('aus → feature_disabled; Dienst fehlt → service_missing / service_absent', async (t) => {
    const x = setup(t, { watcher: false });
    assert.deepEqual(code(() => x.svc.submit({ id: 'auftrag-0001', path: '/x/a.mkv' })), ['feature_disabled', 503]);
    assert.deepEqual(x.svc.featureTelemetry(), { enabled: false, service: 'absent' });
    await x.up();
    assert.equal(x.svc.service(), 'absent');
    assert.equal(x.svc.state(), 'service_missing');
    assert.deepEqual(code(() => x.svc.submit({ id: 'auftrag-0001', path: path.join(x.sb.root, 'a.mkv') })), ['service_absent', 409]);
    assert.deepEqual(await acode(x.svc.probe(path.join(x.sb.root, 'a.mkv'))), ['service_absent', 409]);
    const none = x.make({ ctlDir: path.join(x.sb.dir, 'kein-volume') });
    await none.apply(x.cfg);
    none.stop();
    assert.equal(none.service(), 'missing');
    assert.deepEqual(code(() => none.submit({ id: 'auftrag-0001', path: path.join(x.sb.root, 'a.mkv') })), ['service_missing', 409]);
    // ein veraltetes Lebenszeichen zählt nicht
    fs.writeFileSync(path.join(x.sb.ctl, 'state', 'umwandeln.state'), `alive ${Math.floor(Date.now() / 1000) - 120}\n`);
    assert.equal(x.svc.service(), 'absent');
    fs.writeFileSync(path.join(x.sb.ctl, 'state', 'umwandeln.state'), `alive ${Math.floor(Date.now() / 1000)}\n`);
    assert.equal(x.svc.service(), 'managed');
    assert.equal(x.svc.state(), 'no_device', 'ohne caps des Wächters gibt es kein Verfahren');
  });

  it('prüft id, Pfad und Qualität; gleiche id noch einmal ist kein Fehler; volle Schlange → queue_full', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    await x.up();
    const a = x.file('a.mkv');
    for (const [body, want] of [
      [{ id: 'kurz', path: a }, 'invalid_request'], [{ id: 'mit leer zeichen', path: a }, 'invalid_request'], [{ path: a }, 'invalid_request'], [null, 'invalid_request'],
      [{ id: 'auftrag-0001', path: a, quality: 5 }, 'invalid_request'], [{ id: 'auftrag-0001', path: a, quality: '23' }, 'invalid_request'],
      [{ id: 'auftrag-0001', path: '/etc/passwd.mkv' }, 'outside_roots'], [{ id: 'auftrag-0001', path: `${x.sb.root}/../x.mkv` }, 'bad_path'],
      [{ id: 'auftrag-0001', path: path.join(x.sb.root, 'a.mp4') }, 'unsupported_container'], [{ id: 'auftrag-0001' }, 'bad_path'],
    ]) assert.deepEqual(code(() => x.svc.submit(body)), [want, 400], JSON.stringify(body));
    assert.equal(x.svc.submit({ id: 'auftrag-0001', path: a, quality: 20 }).state, 'queued');
    assert.equal(x.svc.submit({ id: 'auftrag-0001', path: a }).id, 'auftrag-0001', 'Wiederholung');
    assert.deepEqual(code(() => x.svc.submit({ id: 'auftrag-0001', path: x.file('b.mkv') })), ['duplicate_id', 409]);
    assert.deepEqual(code(() => x.svc.submit({ id: 'auftrag-0002', path: a })), ['already_queued', 409]);
    for (let i = 1; i < MAX_QUEUE; i++) x.svc.submit({ id: `schlange-${String(i).padStart(4, '0')}`, path: path.join(x.sb.root, `voll-${i}.mkv`) });
    assert.deepEqual(code(() => x.svc.submit({ id: 'schlange-9999', path: path.join(x.sb.root, 'zu-viel.mkv') })), ['queue_full', 429]);
    await x.until('auftrag-0001', 'running');
    assert.match(fs.readFileSync(path.join(x.sb.ctl, 'jobs', 'auftrag-0001.job'), 'utf8'), /^KIND=convert\nSRC=.*\/a\.mkv\nSOFTWARE=0\nQUALITY=20\n$/);
    assert.equal(fs.readdirSync(path.join(x.sb.ctl, 'jobs')).length, 1, 'der Wächter bekommt einen Auftrag zur Zeit');
    assert.deepEqual(x.svc.featureTelemetry().jobs, { queued: MAX_QUEUE - 1, done: 0, failed: 0 });
    assert.deepEqual([x.svc.featureTelemetry().current.id, x.svc.state()], ['auftrag-0001', 'running']);
  });
});

describe('TranscodeService: abbrechen, anhalten, fortsetzen', () => {
  it('abbrechen: wartend sofort, laufend über den Wächter; Original unberührt; der nächste kommt dran', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    await x.up();
    const a = x.file('a.mkv');
    const before = fs.readFileSync(a, 'utf8');
    x.svc.submit({ id: 'abbruch-0001', path: a });
    x.svc.submit({ id: 'abbruch-0002', path: x.file('b.mkv') });
    x.svc.submit({ id: 'abbruch-0003', path: x.file('c.mkv') });
    await x.until('abbruch-0001', 'running');
    assert.equal(x.svc.cancel('abbruch-0002').state, 'cancelled');
    assert.equal(x.svc.cancel('abbruch-0001').state, 'cancelled');
    assert.equal(x.svc.cancel('abbruch-0001').state, 'cancelled', 'noch einmal: kein Fehler');
    assert.deepEqual(code(() => x.svc.cancel('gibt-es-nicht')), ['not_found', 404]);
    assert.deepEqual(code(() => x.svc.cancel('x')), ['invalid_request', 400]);
    await x.until('abbruch-0003', 'running');
    x.sb.flag('hang', false);
    await x.until('abbruch-0003', 'done');
    assert.equal(fs.readFileSync(a, 'utf8'), before);
    assert.deepEqual(x.svc.status().jobs.map((j) => j.state), ['cancelled', 'cancelled', 'done']);
    assert.deepEqual(fs.readdirSync(path.join(x.sb.root, '.gc-umwandeln')), ['.ignore']);
    assert.deepEqual(x.svc.trash().map((e) => e.id), ['abbruch-0003']);
  });

  it('abgebrochen, aber der Tausch war schon geschehen → der Auftrag gilt als fertig', async (t) => {
    const x = setup(t);
    await x.up();
    const a = x.file('a.mkv');
    x.svc.submit({ id: 'knapp-000001', path: a });
    await x.until('knapp-000001', 'done');
    // so sähe es aus, wenn „abbrechen“ zwischen Tausch und Übernahme des Ergebnisses kam
    Object.assign(x.svc.jobs.get('knapp-000001'), { state: 'cancelled', result: null });
    await x.until('knapp-000001', 'done');
    assert.equal(x.job('knapp-000001').result.resumed, true);
  });

  it('ein Auftrag anhalten/fortsetzen; alles anhalten läuft von selbst ab (ttlSec), wenn der Server es nicht erneuert', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    await x.up();
    x.svc.submit({ id: 'pause-000001', path: x.file('a.mkv') });
    await x.until('pause-000001', 'running');
    assert.deepEqual(x.svc.pause({ id: 'pause-000001' }), { all: false, until: null });
    const p = await x.until('pause-000001', 'paused');
    assert.equal(p.paused, true);
    x.svc.resume({ id: 'pause-000001' });
    assert.equal((await x.until('pause-000001', 'running')).paused, false);

    const v = x.svc.pause({ ttlSec: 20 });
    assert.equal(v.all, true);
    assert.ok(Math.abs(new Date(v.until) - Date.now() - 20_000) < 2000);
    assert.ok(fs.existsSync(path.join(x.sb.ctl, 'pause')));
    await x.until('pause-000001', 'paused');
    assert.equal(x.svc.state(), 'paused');
    x.clock = 30_000;   // 30 s später, kein neues „anhalten“ vom Server
    await x.until('pause-000001', 'running');
    assert.ok(!fs.existsSync(path.join(x.sb.ctl, 'pause')));
    assert.deepEqual(x.svc.pauseView(), { all: false, until: null });

    x.svc.pause({});
    await x.until('pause-000001', 'paused');
    assert.deepEqual(x.svc.resume({}), { all: false, until: null });
    await x.until('pause-000001', 'running');
    assert.deepEqual(code(() => x.svc.pause({ ttlSec: 5 })), ['invalid_request', 400]);
    assert.deepEqual(code(() => x.svc.pause({ ttlSec: 86401 })), ['invalid_request', 400]);
    assert.deepEqual(code(() => x.svc.pause({ id: 'gibt-es-nicht' })), ['not_found', 404]);
    x.sb.flag('hang', false);
    await x.until('pause-000001', 'done');
    assert.deepEqual(code(() => x.svc.pause({ id: 'pause-000001' })), ['not_active', 409]);
  });

  it('ein angehaltener wartender Auftrag blockiert die anderen nicht', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    await x.up();
    x.svc.submit({ id: 'reihe-000001', path: x.file('a.mkv') });
    await x.until('reihe-000001', 'running');
    x.svc.submit({ id: 'reihe-000002', path: x.file('b.mkv') });
    x.svc.submit({ id: 'reihe-000003', path: x.file('c.mkv') });
    x.svc.pause({ id: 'reihe-000002' });
    x.sb.flag('hang', false);
    await x.until('reihe-000003', 'done');
    assert.equal((await x.until('reihe-000002', 'paused')).paused, true);
    x.svc.resume({ id: 'reihe-000002' });
    await x.until('reihe-000002', 'done');
  });

  it('Funktion aus: der laufende Auftrag wird abgebrochen und wartet; wieder an: er läuft von vorn', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    await x.up();
    const a = x.file('a.mkv');
    const before = fs.readFileSync(a, 'utf8');
    x.svc.submit({ id: 'schalter-001', path: a });
    await x.until('schalter-001', 'running');
    await x.svc.apply({ ...x.cfg, enabled: false });
    assert.ok(!fs.existsSync(path.join(x.sb.ctl, 'run')));
    assert.equal(x.svc.jobs.get('schalter-001').state, 'queued');
    await waitFor(() => !fs.existsSync(path.join(x.sb.ctl, 'state', 'schalter-001')), { what: 'watcher dropped the job' });
    assert.equal(fs.readFileSync(a, 'utf8'), before);
    x.sb.flag('hang', false);
    await x.svc.apply(x.cfg);
    await x.until('schalter-001', 'done');
  });
});

describe('TranscodeService: Neustart', () => {
  it('Gateway neu gestartet: die Warteschlange kommt aus /state, der laufende Auftrag wird weiter verfolgt', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    await x.up();
    x.svc.submit({ id: 'neustart-001', path: x.file('a.mkv') });
    x.svc.submit({ id: 'neustart-002', path: x.file('b.mkv') });
    await x.until('neustart-001', 'running');
    x.svc.stop();
    const b = x.make();
    t.after(() => b.stop());
    await b.apply(x.cfg);
    assert.deepEqual(b.status().jobs.map((j) => j.id), ['neustart-001', 'neustart-002']);
    x.sb.flag('hang', false);
    await x.until('neustart-001', 'done', b);
    await x.until('neustart-002', 'done', b);
    assert.equal(x.sb.calls().filter((c) => c.includes('-f matroska')).length, 2, 'nichts doppelt umgewandelt');
  });

  it('Host neu gestartet (tmpfs leer, halbe Zwischendatei auf der Platte): der Auftrag wird neu hingelegt und läuft durch', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    await x.up();
    const a = x.file('a.mkv');
    const before = fs.readFileSync(a, 'utf8');
    x.svc.submit({ id: 'strom-000001', path: a });
    await x.until('strom-000001', 'running');
    x.svc.stop();
    await x.w.stop('SIGKILL');
    await waitFor(() => { try { process.kill(Number(fs.readFileSync(path.join(x.sb.dir, 'fake', 'started'), 'utf8')), 'SIGKILL'); } catch { /* weg */ } return true; });
    fs.rmSync(path.join(x.sb.ctl, 'jobs'), { recursive: true });
    fs.rmSync(path.join(x.sb.ctl, 'state'), { recursive: true });
    fs.rmSync(path.join(x.sb.ctl, 'umwandeln.sh'));
    fs.writeFileSync(path.join(x.sb.root, '.gc-umwandeln', 'strom-000001.part.mkv'), 'halb');
    assert.equal(fs.readFileSync(a, 'utf8'), before);
    x.sb.flag('hang', false);
    x.svc = x.make();
    await x.up();
    const d = await x.until('strom-000001', 'done');
    assert.equal(fs.readFileSync(d.result.trashPath, 'utf8'), before);
    assert.match(fs.readFileSync(a, 'utf8'), /^pix_fmt=yuv420p$/m);
  });

  it('Wurzel inzwischen entfernt: der wartende Auftrag scheitert mit outside_roots, statt den Dienst zu fragen', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    await x.up();
    x.svc.submit({ id: 'wurzel-00001', path: x.file('a.mkv') });
    await x.until('wurzel-00001', 'running');
    x.svc.submit({ id: 'wurzel-00002', path: x.file('b.mkv') });
    await x.svc.apply({ ...x.cfg, roots: ['/anderswo'] });
    x.sb.flag('hang', false);
    assert.equal((await x.until('wurzel-00002', 'failed')).error, 'outside_roots');
    assert.deepEqual(x.svc.roots(), [{ path: '/anderswo', state: 'not_mounted', free: null, total: null }]);
  });
});

describe('TranscodeService: prüfen, wiederherstellen, löschen (kurze Aufträge)', () => {
  it('probe liefert den Befund; restore holt das Original zurück; purge löscht', async (t) => {
    const x = setup(t);
    await x.up();
    const a = x.file('Filme/a.mp4', media({ codec: 'hevc', profile: 'Main 10', pixFmt: 'p010le', pad: 50 }));
    const r = await x.svc.probe(a);
    assert.equal(r.path, a);
    assert.deepEqual([r.source.codec, r.source.bits, r.source.size], ['hevc', 10, fs.statSync(a).size]);
    assert.ok(r.freeKb > 0);
    assert.deepEqual(await acode(x.svc.probe('/etc/hostname')), ['outside_roots', 400]);
    assert.deepEqual(await acode(x.svc.probe(path.join(x.sb.root, 'fehlt.mkv'))), ['not_found', 422]);
    assert.deepEqual(fs.readdirSync(path.join(x.sb.ctl, 'jobs')), [], 'kurze Aufträge räumt das Gateway selbst weg');

    const b = x.file('b.mkv');
    const c = x.file('c.mkv');
    const before = fs.readFileSync(b, 'utf8');
    x.svc.submit({ id: 'zurueck-0001', path: b });
    x.svc.submit({ id: 'zurueck-0002', path: c });
    await x.until('zurueck-0002', 'done');
    assert.deepEqual(await x.svc.restore('zurueck-0001'), { id: 'zurueck-0001', restored: b });
    assert.equal(fs.readFileSync(b, 'utf8'), before);
    assert.deepEqual(x.svc.trash().map((e) => e.id), ['zurueck-0002']);
    assert.deepEqual(await acode(x.svc.restore('zurueck-0001')), ['not_in_trash', 422]);
    assert.deepEqual(await acode(x.svc.restore('../x')), ['invalid_request', 400]);
    assert.deepEqual(await acode(x.svc.purge({})), ['invalid_request', 400]);
    assert.deepEqual(await x.svc.purge({ id: 'zurueck-0002' }), { purged: true });
    assert.deepEqual(x.svc.trash(), []);
    assert.deepEqual(await x.svc.purge({ all: true }), { purged: true });
  });

  it('antwortet der Wächter nicht, endet der Aufruf mit timeout und räumt seinen Auftrag weg', async (t) => {
    const x = setup(t, { watcher: false, svc: { quickTimeoutMs: 150 } });
    await x.up();
    fs.writeFileSync(path.join(x.sb.ctl, 'state', 'umwandeln.state'), `alive ${Math.floor(Date.now() / 1000)}\n`);
    assert.deepEqual(await acode(x.svc.probe(path.join(x.sb.root, 'a.mkv'))), ['timeout', 504]);
    assert.deepEqual(fs.readdirSync(path.join(x.sb.ctl, 'jobs')), []);
  });
});

describe('TranscodeService: was aus dem Dienst kommt, ist fremde Eingabe', () => {
  it('Links, zu große oder unlesbare Dateien in state/ werden nicht gelesen', async (t) => {
    const x = setup(t, { watcher: false });
    await x.up();
    const st = path.join(x.sb.ctl, 'state');
    const secret = path.join(x.sb.dir, 'geheim');
    fs.writeFileSync(secret, `alive ${Math.floor(Date.now() / 1000)}\nv=1\ndevice=ok\nenc=vaapi_icq\ntrash=/geheimnis\n`);
    fs.symlinkSync(secret, path.join(st, 'umwandeln.state'));
    fs.symlinkSync(secret, path.join(st, 'caps'));
    assert.equal(x.svc.service(), 'absent');
    assert.equal(x.svc.caps(), null);
    fs.rmSync(path.join(st, 'umwandeln.state'));
    fs.writeFileSync(path.join(st, 'umwandeln.state'), `alive ${Math.floor(Date.now() / 1000)}\n${'x'.repeat(200)}`);
    assert.equal(x.svc.service(), 'absent', 'zu groß');
    fs.writeFileSync(path.join(st, 'umwandeln.state'), 'alive gestern\n');
    assert.equal(x.svc.service(), 'absent');
    // state selbst durch einen Link ersetzt
    fs.rmSync(st, { recursive: true });
    const other = path.join(x.sb.dir, 'anderswo');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'umwandeln.state'), `alive ${Math.floor(Date.now() / 1000)}\n`);
    fs.symlinkSync(other, st);
    assert.equal(x.svc.service(), 'absent');
    assert.equal(x.svc._install(), false, 'state ist kein Ordner mehr → nichts wird geschrieben');
  });

  it('ein gefälschter Zustand ändert nur, was das Format erlaubt', async (t) => {
    const x = setup(t, { watcher: false });
    await x.up();
    const st = path.join(x.sb.ctl, 'state');
    fs.writeFileSync(path.join(st, 'umwandeln.state'), `alive ${Math.floor(Date.now() / 1000)}\n`);
    x.svc.submit({ id: 'fremd-000001', path: path.join(x.sb.root, 'a.mkv') });
    await waitFor(() => fs.existsSync(path.join(x.sb.ctl, 'jobs', 'fremd-000001.job')), { what: 'handed' });
    for (const bad of ['done', 'done 1 - 100 0 0 extra', 'DONE 1 - 100 0 0', 'done 1 ../x 100 0 0', 'running 1 - 1000 0 0', 'running 1 - 5 1e9 0', '']) {
      fs.writeFileSync(path.join(st, 'fremd-000001'), bad + '\n');
      await x.svc.tick();
      assert.equal(x.job('fremd-000001').state, 'queued', bad);
    }
    fs.writeFileSync(path.join(st, 'fremd-000001'), 'running 1 - 250 78.3 3.14\n');
    await x.svc.tick();
    assert.deepEqual([x.job('fremd-000001').state, x.job('fremd-000001').percent], ['running', 99]);
    fs.writeFileSync(path.join(st, 'fremd-000001.res'), 'mode=rm -rf\nsrc_codec=h264\u0007<script>\nsrc_bits=zehn\nsrc_width=1920\ntrash=/a\u001b[31m/b\nlog=eins\u0000zwei\nBÖSE=1\n' + 'log=x\n'.repeat(50));
    fs.writeFileSync(path.join(st, 'fremd-000001'), 'failed 1 encode_failed 5 0 0\n');
    await x.svc.tick();
    const j = x.job('fremd-000001');
    assert.deepEqual([j.state, j.error], ['failed', 'encode_failed']);
    assert.equal(j.result.mode, null);
    assert.deepEqual([j.result.source.codec, j.result.source.bits, j.result.source.width], ['h264 <script>', null, 1920]);
    assert.equal(j.result.trashPath, '/a [31m/b');
    assert.equal(j.result.log.length, 20);
    assert.equal(j.result.log[0], 'eins zwei');
  });

  it('parseCaps / parseRoots / parseTrash / parseResult', () => {
    assert.equal(parseCaps('device=ok\n'), null);
    assert.equal(parseCaps(null), null);
    const c = parseCaps('v=1\nat=1795759028\nffmpeg=8.1.3-Jellyfin\nuid=1034\ngroups=100 61002 937\ndevice=denied\ndevice_path=/dev/dri/renderD128\ndevice_gid=937\ndevice_mode=660\ndriver=Intel iHD driver\nva_h264_enc=0\nenc=vaapi_qvbr,unsinn,vaapi_icq\nsoftware=0\n');
    assert.deepEqual(c, { at: '2026-11-27T05:57:08.000Z', ffmpeg: '8.1.3-Jellyfin', uid: 1034, groups: [100, 61002, 937], device: 'denied', devicePath: '/dev/dri/renderD128', deviceGid: 937, deviceMode: '660',
      driver: 'Intel iHD driver', vaH264Enc: false, encoders: ['vaapi_qvbr', 'vaapi_icq'], software: false });
    assert.equal(parseCaps('v=1\ndevice=kaputt\n').device, 'absent');
    assert.deepEqual(parseRoots('ok\t1024\t2048\t/volume2/mediathek\nmissing\t0\t0\t/volume1/weg\nunsinn\t1\t1\t/x\nok\t1\t1\trelativ\nzu\twenig\n'),
      [{ path: '/volume2/mediathek', state: 'ok', free: 1048576, total: 2097152 }, { path: '/volume1/weg', state: 'missing', free: 0, total: 0 }]);
    assert.deepEqual(parseRoots(null), []);
    assert.deepEqual(parseTrash('auftrag-0001\tdone\t1795759028\t812000000\t1796968628\t/volume2/mediathek/Serie/Folge 01.mkv\nauftrag-0002\tpending\t1\t1\t1\t/x\nkurz\tdone\t1\t1\t1\t/x\nauftrag-0003\tdone\tx\t1\t1\t/x\n'),
      [{ id: 'auftrag-0001', at: '2026-11-27T05:57:08.000Z', size: 812000000, expiresAt: '2026-12-11T05:57:08.000Z', path: '/volume2/mediathek/Serie/Folge 01.mkv' }]);
    assert.deepEqual(parseResult(''), { source: null, output: null, mode: null, seconds: null, trashPath: null, restored: null, resumed: false, freeKb: null, needKb: null, log: [] });
    assert.deepEqual(parseResult('resumed=1\nseconds=384\nmode=software\nfree_kb=5\nneed_kb=9\n'), { source: null, output: null, mode: 'software', seconds: 384, trashPath: null, restored: null, resumed: true, freeKb: 5, needKb: 9, log: [] });
  });
});

describe('Management-API /api/transcode/* und Telemetrie', () => {
  const TOK = 'f'.repeat(64);
  function post(port, p, body, token = TOK) {
    return new Promise((resolve) => {
      const data = JSON.stringify(body);
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
      if (token) headers['X-Gateway-Token'] = token;
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null }));
      });
      req.end(data);
    });
  }
  async function serve(t, featureMgr, limit) {
    const app = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: TOK, routerFactories: { '/api': () => createTranscodeRouter({ featureMgr, ...(limit ? { limit } : {}) }) } });
    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.on('listening', r));
    t.after(() => s.close());
    return s.address().port;
  }

  it('alle Aufrufe gegen den echten Dienst: Status, prüfen, Auftrag, anhalten, abbrechen, quittieren, Papierkorb', async (t) => {
    const x = setup(t);
    await x.up();
    const port = await serve(t, { transcode: x.svc });
    const a = x.file('a.mkv');
    const b = x.file('b.mkv');
    assert.equal((await post(port, '/api/transcode/status', {}, null)).status, 401);
    let r = await post(port, '/api/transcode/status', {});
    assert.deepEqual([r.status, r.body.service, r.body.state, r.body.jobs, r.body.trash], [200, 'managed', 'ready', [], []]);
    r = await post(port, '/api/transcode/probe', { path: a });
    assert.deepEqual([r.status, r.body.source.bits], [200, 10]);
    assert.deepEqual(await post(port, '/api/transcode/probe', { path: '/etc/hostname' }), { status: 400, body: { error: 'outside_roots' } });
    assert.deepEqual(await post(port, '/api/transcode/submit', { id: 'x', path: a }), { status: 400, body: { error: 'invalid_request' } });
    assert.deepEqual(await post(port, '/api/transcode/submit', []), { status: 400, body: { error: 'invalid_request' } });
    x.sb.flag('hang');
    r = await post(port, '/api/transcode/submit', { id: 'api-00000001', path: a });
    assert.deepEqual([r.status, r.body.job.id, r.body.job.state], [202, 'api-00000001', 'queued']);
    await x.until('api-00000001', 'running');
    r = await post(port, '/api/transcode/pause', { id: 'api-00000001' });
    assert.deepEqual([r.status, r.body.pause.all], [200, false]);
    await x.until('api-00000001', 'paused');
    r = await post(port, '/api/transcode/pause', { ttlSec: 60 });
    assert.deepEqual([r.status, r.body.pause.all], [200, true]);
    assert.equal((await post(port, '/api/transcode/resume', {})).body.pause.all, false);
    assert.equal((await post(port, '/api/transcode/resume', { id: 'api-00000001' })).status, 200);
    await x.until('api-00000001', 'running');
    r = await post(port, '/api/transcode/cancel', { id: 'api-00000001' });
    assert.deepEqual([r.status, r.body.job.state], [200, 'cancelled']);
    assert.deepEqual(await post(port, '/api/transcode/cancel', { id: 'gibt-es-nicht' }), { status: 404, body: { error: 'not_found' } });
    x.sb.flag('hang', false);
    await post(port, '/api/transcode/submit', { id: 'api-00000002', path: b });
    await x.until('api-00000002', 'done');
    assert.deepEqual(await post(port, '/api/transcode/ack', { ids: ['api-00000001', 'api-00000002'] }), { status: 200, body: { removed: 2 } });
    assert.deepEqual(await post(port, '/api/transcode/ack', { ids: 'x' }), { status: 400, body: { error: 'invalid_request' } });
    assert.deepEqual(await post(port, '/api/transcode/restore', { id: 'api-00000002' }), { status: 200, body: { id: 'api-00000002', restored: b } });
    assert.deepEqual(await post(port, '/api/transcode/restore', { id: 'api-00000002' }), { status: 422, body: { error: 'not_in_trash' } });
    assert.deepEqual(await post(port, '/api/transcode/purge', { all: true }), { status: 200, body: { purged: true } });
    assert.deepEqual(await post(port, '/api/transcode/purge', {}), { status: 400, body: { error: 'invalid_request' } });
  });

  it('Funktion aus oder altes Gateway-Objekt: 503 feature_disabled; zu viele Abrufe: 429', async (t) => {
    const x = setup(t, { watcher: false });
    const port = await serve(t, { transcode: x.svc }, { windowMs: 60_000, limit: 12 });
    for (const p of ['status', 'probe', 'submit', 'cancel', 'pause', 'resume', 'ack', 'restore', 'purge']) {
      assert.deepEqual(await post(port, `/api/transcode/${p}`, {}), { status: 503, body: { error: 'feature_disabled' } }, p);
    }
    const p2 = await serve(t, {});
    assert.deepEqual(await post(p2, '/api/transcode/status', {}), { status: 503, body: { error: 'feature_disabled' } });
    for (let i = 0; i < 3; i++) await post(port, '/api/transcode/status', {});
    assert.deepEqual(await post(port, '/api/transcode/status', {}), { status: 429, body: { error: 'rate_limited' } });
  });

  it('Capability transcode im Heartbeat; features.transcode in der Telemetrie; der Schalter kommt aus dem Config-Pull', async (t) => {
    assert.ok(CAPABILITIES.includes('transcode'));
    const x = setup(t, { watcher: false });
    const off = { apply() {}, stop() {}, telemetry: () => null, featureTelemetry: () => ({ enabled: false }) };
    const mgr = new FeatureManager({ netwatch: off, inetq: off, presence: off, ups: off, transcode: x.svc });
    assert.deepEqual(mgr.telemetry().features.transcode, { enabled: false, service: 'absent' });
    await mgr.apply({ transcode: x.cfg });
    t.after(() => mgr.stop());
    const tel = mgr.telemetry();
    assert.ok(tel.capabilities.includes('transcode'));
    assert.deepEqual([tel.features.transcode.enabled, tel.features.transcode.state, tel.features.transcode.roots[0].state], [true, 'service_missing', 'not_mounted']);
    await mgr.apply({});
    assert.equal(mgr.telemetry().features.transcode.enabled, false);
    assert.ok(!fs.existsSync(path.join(x.sb.ctl, 'run')));
    // ohne den Dienst (älteres Gateway-Objekt in Tests): aus
    const plain = new FeatureManager({ netwatch: off, inetq: off, presence: off, ups: off });
    assert.deepEqual(plain.telemetry().features.transcode, { enabled: false });
  });
});
