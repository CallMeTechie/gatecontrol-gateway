'use strict';

// Wächter des Dienstes „umwandeln“ (src/transcode/umwandeln.sh, docs/transcode.md §5):
// das echte Skript mit Attrappen für ffmpeg, ffprobe und vainfo (tests/helpers/umwFakes.js).
// Geprüft wird, was am Ende auf der Platte liegt: Original, neue Datei, Papierkorb.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WATCHER, media, sandbox, startWatcher, waitFor } = require('./helpers/umwFakes');

const CONF = 'TRASH_DAYS=14\nRESERVE_MB=0\nMIN_FREE_GB=0\nMIN_FREE_PCT=0\nVERIFY_DECODE=1\n';
const DAY = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function setup(t, { conf = CONF, start = true, ...opts } = {}) {
  const sb = sandbox(opts);
  if (conf) fs.writeFileSync(path.join(sb.ctl, 'conf'), conf);
  fs.writeFileSync(path.join(sb.ctl, 'run'), 'on\n');
  const x = { sb, w: null };
  x.start = (o) => { x.w = startWatcher(sb, o); return x.w; };
  x.job = (id, lines) => fs.writeFileSync(path.join(sb.ctl, 'jobs', `${id}.job`), lines.join('\n') + '\n');
  x.convert = (id, src, extra = []) => x.job(id, ['KIND=convert', `SRC=${src}`, ...extra]);
  x.unjob = (id) => fs.rmSync(path.join(sb.ctl, 'jobs', `${id}.job`), { force: true });
  x.state = (id) => {
    let s;
    try { s = fs.readFileSync(path.join(sb.ctl, 'state', id), 'utf8'); } catch { return null; }
    const f = s.trim().split(' ');
    return f.length === 6 ? { state: f[0], code: f[2], percent: Number(f[3]), fps: Number(f[4]), speed: Number(f[5]) } : null;
  };
  x.res = (id) => {
    const out = {};
    let s = '';
    try { s = fs.readFileSync(path.join(sb.ctl, 'state', `${id}.res`), 'utf8'); } catch { return out; }
    for (const l of s.split('\n')) {
      const i = l.indexOf('=');
      if (i > 0) { const k = l.slice(0, i); out[k] = k === 'log' ? [...(out.log || []), l.slice(i + 1)] : l.slice(i + 1); }
    }
    return out;
  };
  x.end = (id, o) => waitFor(() => { const s = x.state(id); return s && (s.state === 'done' || s.state === 'failed') ? s : null; }, { what: `end of ${id}`, ...o });
  x.is = (id, st, o) => waitFor(() => { const s = x.state(id); return s && s.state === st ? s : null; }, { what: `${id} ${st}`, ...o });
  x.alive = () => waitFor(() => fs.existsSync(path.join(sb.ctl, 'state', 'caps')) && fs.existsSync(path.join(sb.ctl, 'state', 'trash')), { what: 'watcher up' });
  x.file = (rel, text) => {
    const f = path.join(sb.root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text === undefined ? media({ pad: 4000 }) : text);
    return f;
  };
  x.encodes = () => sb.calls().filter((c) => c.includes('-f matroska'));
  x.tree = () => execFileSync('find', [sb.root, '-mindepth', '1'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((p) => path.relative(sb.root, p)).sort();
  x.children = () => {
    // die ffmpeg-Prozesse des Wächters (sein eigenes `sleep` zählt nicht): [pid, Zustand]
    try {
      return execFileSync('ps', ['-o', 'pid=,stat=,comm=', '--ppid', String(x.w.child.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
        .map((l) => l.trim().split(/\s+/)).filter((f) => f[2] === 'ffmpeg');
    } catch { return []; }
  };
  t.after(async () => {
    sb.flag('hang', false);
    if (x.w) await x.w.stop('SIGKILL');
    for (const [pid] of x.children()) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* weg */ } }
    sb.cleanup();
  });
  if (start) x.start();
  return x;
}

const info = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const writeInfo = (file, o) => fs.writeFileSync(file, Object.entries({ v: 1, ...o }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

describe('umwandeln.sh: ein Video umwandeln', () => {
  it('10 Bit → H.264 8 Bit per VAAPI (ICQ 23); Original als harter Link im Papierkorb, neue Datei unter dem alten Namen', async (t) => {
    const x = setup(t);
    const src = x.file('Serie A/Staffel 1/Folge 01 [10bit].mkv');
    const before = fs.readFileSync(src, 'utf8');
    const ino = fs.statSync(src).ino;
    fs.chmodSync(src, 0o664);
    x.convert('job00001', src);
    const s = await x.end('job00001');
    assert.deepEqual([s.state, s.code, s.percent], ['done', '-', 100]);

    const r = x.res('job00001');
    assert.equal(r.mode, 'vaapi_icq');
    assert.deepEqual([r.src_codec, r.src_profile, r.src_pix_fmt, r.src_bits, r.src_width, r.src_height, r.src_fps], ['h264', 'High 10', 'yuv420p10le', '10', '1920', '1080', '50.000']);
    assert.deepEqual([r.new_codec, r.new_profile, r.new_pix_fmt, r.new_bits], ['h264', 'High', 'yuv420p', '8']);
    assert.deepEqual([r.src_audio, r.src_subtitles, r.src_attachments, r.src_chapters, r.src_duration], ['2', '1', '2', '7', '61.003']);
    const trash = path.join(x.sb.root, '.gc-papierkorb', DAY(), 'Serie A/Staffel 1/Folge 01 [10bit].mkv');
    assert.equal(r.trash, trash);

    // am alten Ort: die neue Datei (8 Bit), Rechte wie das Original
    assert.match(fs.readFileSync(src, 'utf8'), /^pix_fmt=yuv420p$/m);
    assert.equal(fs.statSync(src).mode & 0o777, 0o664);
    // im Papierkorb: das Original, unverändert, dieselbe Datei (harter Link, keine Kopie)
    assert.equal(fs.readFileSync(trash, 'utf8'), before);
    assert.equal(fs.statSync(trash).ino, ino);
    const i = info(trash + '.gc-info');
    assert.deepEqual([i.id, i.state, i.src, i.size], ['job00001', 'done', src, String(Buffer.byteLength(before))]);
    assert.ok(Math.abs(Number(i.at) - Date.now() / 1000) < 60);
    // Jellyfin liest die Arbeitsordner nicht ein; keine Zwischendatei bleibt
    assert.deepEqual(x.tree(), ['.gc-papierkorb', '.gc-papierkorb/.ignore', `.gc-papierkorb/${DAY()}`, `.gc-papierkorb/${DAY()}/Serie A`, `.gc-papierkorb/${DAY()}/Serie A/Staffel 1`,
      `.gc-papierkorb/${DAY()}/Serie A/Staffel 1/Folge 01 [10bit].mkv`, `.gc-papierkorb/${DAY()}/Serie A/Staffel 1/Folge 01 [10bit].mkv.gc-info`,
      '.gc-umwandeln', '.gc-umwandeln/.ignore', 'Serie A', 'Serie A/Staffel 1', 'Serie A/Staffel 1/Folge 01 [10bit].mkv']);

    // die erprobten Aufrufe aus dem Spike
    const [enc] = x.encodes();
    for (const part of ['-init_hw_device vaapi=va:', '-filter_hw_device va', '-threads 3', `-i file:${src}`,
      '-map 0:V:0 -map 0:a? -map 0:s? -map 0:t? -map_chapters 0 -map_metadata 0 -c copy',
      '-c:v:0 h264_vaapi -vf format=nv12,hwupload -profile:v high -level 4.2 -bf 2 -g 100 -rc_mode ICQ -global_quality 23',
      `-max_muxing_queue_size 4096 -f matroska file:${path.join(x.sb.root, '.gc-umwandeln', 'job00001.part.mkv')}`]) {
      assert.ok(enc.includes(part), `${part}\n${enc}`);
    }
    assert.ok(!/-b:v|maxrate|libx264/.test(enc), enc);
    const verify = x.sb.calls().find((c) => c.includes('-xerror'));
    assert.match(verify, /-hwaccel vaapi -hwaccel_device \S+ -hwaccel_output_format vaapi -i file:\S+job00001\.part\.mkv -map 0:v:0 -f null -$/);
    // Papierkorb-Liste für das Gateway
    const list = fs.readFileSync(path.join(x.sb.ctl, 'state', 'trash'), 'utf8').trim().split('\t');
    assert.deepEqual([list[0], list[1], list[5]], ['job00001', 'done', src]);
    assert.equal(Number(list[4]) - Number(list[2]), 14 * 86400);
  });

  it('Fortschritt: läuft mit Prozent, B/s und Tempo; danach „verifying“', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    const src = x.file('a.mkv', media({ duration: '100.000000', pad: 100 }));
    x.convert('job00002', src);
    const s = await waitFor(() => { const v = x.state('job00002'); return v && v.state === 'running' && v.percent >= 20 ? v : null; }, { what: 'progress' });
    assert.ok(s.percent <= 98);
    assert.deepEqual([s.fps, s.speed], [78.3, 3.14]);
    x.sb.flag('hang', false);
    assert.equal((await x.end('job00002')).state, 'done');
  });

  it('Qualität und Bildgröße: QUALITY wird begrenzt, über 1080p kein festes Level, GOP = 2 s', async (t) => {
    const x = setup(t);
    const src = x.file('uhd.mkv', media({ width: 3840, height: 2160, fps: '24000/1001' }));
    x.convert('job00003', src, ['QUALITY=99']);
    assert.equal((await x.end('job00003')).state, 'done');
    const [enc] = x.encodes();
    assert.match(enc, /-profile:v high -bf 2 -g 48 -rc_mode ICQ -global_quality 32 /);
    assert.ok(!enc.includes('-level'));
  });

  it('Titelbild im MKV zählt nicht als Videospur; nur die echte Videospur wird umgewandelt', async (t) => {
    const x = setup(t);
    const src = x.file('cover.mkv', media({ pictures: 1 }));
    x.convert('job00004', src);
    const s = await x.end('job00004');
    // die Attrappe behält das Titelbild, das echte ffmpeg lässt es mit -map 0:V:0 weg – beides ist eine Videospur
    assert.equal(s.state, 'done');
    assert.deepEqual([x.res('job00004').src_video, x.res('job00004').src_pictures], ['1', '1']);
  });
});

describe('umwandeln.sh: Verfahren (ICQ → QVBR → Software nur mit Erlaubnis)', () => {
  it('lehnt der Treiber ICQ ab, wird QVBR genommen', async (t) => {
    const x = setup(t, { start: false });
    x.sb.flag('no_icq');
    x.start();
    const src = x.file('a.mkv');
    x.convert('job00010', src);
    assert.equal((await x.end('job00010')).state, 'done');
    assert.equal(x.res('job00010').mode, 'vaapi_qvbr');
    assert.match(x.encodes()[0], /-rc_mode QVBR -global_quality 23 -b:v 8M -maxrate 14M -bufsize 16M /);
    assert.match(fs.readFileSync(path.join(x.sb.ctl, 'state', 'caps'), 'utf8'), /^enc=vaapi_qvbr$/m);
  });

  it('ohne Hardware-Verfahren und ohne Erlaubnis: no_encoder, nichts angefasst', async (t) => {
    const x = setup(t, { start: false });
    x.sb.flag('no_icq'); x.sb.flag('no_qvbr');
    x.start();
    const src = x.file('a.mkv');
    const before = fs.readFileSync(src, 'utf8');
    x.convert('job00011', src);
    assert.deepEqual((await x.end('job00011')).code, 'no_encoder');
    assert.equal(fs.readFileSync(src, 'utf8'), before);
    assert.deepEqual(x.encodes(), []);
    assert.ok(!fs.existsSync(path.join(x.sb.root, '.gc-papierkorb')));
  });

  it('Software (libx264) nur mit SOFTWARE=1 im Auftrag', async (t) => {
    const x = setup(t, { device: 'absent' });
    const a = x.file('a.mkv');
    const b = x.file('b.mkv');
    x.convert('job00012', a);
    assert.deepEqual((await x.end('job00012')).code, 'no_device');
    x.unjob('job00012');
    x.convert('job00013', b, ['SOFTWARE=1']);
    assert.equal((await x.end('job00013')).state, 'done');
    assert.equal(x.res('job00013').mode, 'software');
    const [enc] = x.encodes();
    assert.match(enc, /-c:v:0 libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -profile:v high -level 4\.2 -bf 2 -g 100 -max_muxing_queue_size/);
    assert.ok(!/vaapi|hwupload/.test(enc), enc);
    assert.ok(!x.sb.calls().find((c) => c.includes('-xerror')).includes('hwaccel'));
    const caps = fs.readFileSync(path.join(x.sb.ctl, 'state', 'caps'), 'utf8');
    assert.match(caps, /^device=absent$/m);
    assert.match(caps, /^enc=$/m);
    assert.match(caps, /^software=1$/m);
  });

  it('Fähigkeiten: Gerät, Gruppe des Geräts, Treiber, geprüfte Verfahren, eigene Gruppen', async (t) => {
    const x = setup(t);
    await x.alive();
    const caps = Object.fromEntries(fs.readFileSync(path.join(x.sb.ctl, 'state', 'caps'), 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.equal(caps.v, '1');
    assert.equal(caps.ffmpeg, '8.1.3-Fake');
    assert.equal(caps.device, 'ok');
    assert.equal(caps.device_gid, String(fs.statSync(path.join(x.sb.dir, 'renderD128')).gid));
    assert.equal(caps.device_mode, '644');
    assert.equal(caps.driver, 'Intel iHD driver for Intel(R) Gen Graphics - 26.3.5 (1b5e662)');
    assert.equal(caps.va_h264_enc, '1');
    assert.equal(caps.enc, 'vaapi_icq,vaapi_qvbr');
    assert.equal(caps.uid, String(process.getuid()));
    assert.ok(caps.groups.split(' ').includes(String(process.getgid())));
    const roots = fs.readFileSync(path.join(x.sb.ctl, 'state', 'roots'), 'utf8').trim().split('\t');
    assert.deepEqual([roots[0], roots[3]], ['ok', x.sb.root]);
    assert.ok(Number(roots[1]) > 0 && Number(roots[2]) >= Number(roots[1]));
  });
});

describe('umwandeln.sh: Pfadprüfung – kein Ausbruch aus den Medienordnern', () => {
  it('außerhalb, „..“, symbolische Links, Arbeitsordner, falsche Endung, kein Ordner als Datei', async (t) => {
    const x = setup(t, { roots: ['medien', 'filme'] });
    const out = path.join(x.sb.dir, 'geheim');
    fs.mkdirSync(out);
    const secret = path.join(out, 'x.mkv');
    fs.writeFileSync(secret, media());
    const before = fs.readFileSync(secret, 'utf8');
    const ok = x.file('ok/a.mkv');
    fs.symlinkSync(secret, path.join(x.sb.root, 'link.mkv'));                 // Datei-Link nach außen
    fs.symlinkSync(out, path.join(x.sb.root, 'ordnerlink'));                  // Ordner-Link nach außen
    fs.symlinkSync(ok, path.join(x.sb.root, 'innen.mkv'));                    // Link auf eine Datei in der Wurzel
    fs.mkdirSync(path.join(x.sb.root, 'ordner.mkv'));
    x.file('.gc-papierkorb/2026-01-01/alt.mkv');
    x.file('.gc-umwandeln/fremd.mkv');
    x.file('film.mp4');
    x.file('ohne-endung');
    const cases = {
      pfad0001: [secret, 'outside_roots'],
      pfad0002: [`${x.sb.root}/../geheim/x.mkv`, 'bad_path'],
      pfad0003: [`${x.sb.root}/ok/../../geheim/x.mkv`, 'bad_path'],
      pfad0004: [path.join(x.sb.root, 'link.mkv'), 'symlink'],
      pfad0005: [path.join(x.sb.root, 'ordnerlink', 'x.mkv'), 'symlink'],
      pfad0006: [path.join(x.sb.root, 'innen.mkv'), 'symlink'],
      pfad0007: [path.join(x.sb.root, 'ordner.mkv'), 'not_a_file'],
      pfad0008: [path.join(x.sb.root, '.gc-papierkorb/2026-01-01/alt.mkv'), 'bad_path'],
      pfad0009: [path.join(x.sb.root, '.gc-umwandeln/fremd.mkv'), 'bad_path'],
      pfad0010: [path.join(x.sb.root, 'film.mp4'), 'unsupported_container'],
      pfad0011: [path.join(x.sb.root, 'ohne-endung'), 'unsupported_container'],
      pfad0012: [path.join(x.sb.root, 'fehlt.mkv'), 'not_found'],
      pfad0013: ['medien/ok/a.mkv', 'bad_path'],
      pfad0014: [`${x.sb.root}//ok/a.mkv`, 'bad_path'],
      pfad0015: [`${x.sb.root}/./ok/a.mkv`, 'bad_path'],
      pfad0016: [x.sb.root + 'x/a.mkv', 'outside_roots'],
      pfad0017: ['', 'bad_path'],
      pfad0018: [`${x.sb.root}/ok/a.mkv\u0007`, 'bad_path'],
    };
    for (const [id, [p]] of Object.entries(cases)) x.convert(id, p);
    for (const [id, [p, code]] of Object.entries(cases)) {
      const s = await x.end(id);
      assert.deepEqual([s.state, s.code], ['failed', code], `${id} ${p}`);
    }
    assert.deepEqual(x.encodes(), [], 'für keinen dieser Pfade läuft ffmpeg');
    assert.equal(fs.readFileSync(secret, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(out), ['x.mkv']);
    // die zweite Wurzel gilt genauso
    const f2 = path.join(x.sb.roots[1], 'b.mkv');
    fs.writeFileSync(f2, media());
    x.convert('pfad0020', f2);
    assert.equal((await x.end('pfad0020')).state, 'done');
    assert.ok(fs.existsSync(path.join(x.sb.roots[1], '.gc-papierkorb', DAY(), 'b.mkv')));
  });

  it('eine Wurzel, die selbst ein Link ist oder fehlt, gilt nicht', async (t) => {
    const x = setup(t, { start: false });
    const real = x.file('a.mkv');
    const link = path.join(x.sb.dir, 'wurzellink');
    fs.symlinkSync(x.sb.root, link);
    x.start({ extraEnv: { GC_UMW_ROOTS: `${link}:${path.join(x.sb.dir, 'fehlt')}` } });
    x.convert('pfad0030', path.join(link, 'a.mkv'));
    x.convert('pfad0031', path.join(x.sb.dir, 'fehlt', 'a.mkv'));
    x.convert('pfad0032', real);
    assert.equal((await x.end('pfad0030')).code, 'root_missing');
    assert.equal((await x.end('pfad0031')).code, 'root_missing');
    assert.equal((await x.end('pfad0032')).code, 'outside_roots');
    const roots = fs.readFileSync(path.join(x.sb.ctl, 'state', 'roots'), 'utf8');
    assert.match(roots, /^missing\t0\t0\t.*wurzellink$/m);
  });

  it('probe: Befund für die Liste – auch MP4; außerhalb der Wurzeln nicht', async (t) => {
    const x = setup(t);
    const f = x.file('Filme/Film (2021).mp4', media({ codec: 'hevc', profile: 'Main 10', pixFmt: 'p010le', pictures: 1, audio: 1, subtitles: 0, attachments: 0, chapters: 0, container: 'mov,mp4,m4a,3gp,3g2,mj2', pad: 10 }));
    x.job('probe001', ['KIND=probe', `SRC=${f}`]);
    x.job('probe002', ['KIND=probe', 'SRC=/etc/hostname']);
    x.job('probe003', ['KIND=probe', `SRC=${x.file('notiz.txt', 'hallo')}`]);
    x.job('probe004', ['KIND=probe', `SRC=${x.file('kaputt.mkv', 'kein video')}`]);
    assert.equal((await x.end('probe001')).state, 'done');
    const r = x.res('probe001');
    assert.deepEqual([r.src_codec, r.src_profile, r.src_pix_fmt, r.src_bits, r.src_video, r.src_pictures, r.src_audio, r.src_container],
      ['hevc', 'Main 10', 'p010le', '10', '1', '1', '1', 'mov,mp4,m4a,3gp,3g2,mj2']);
    assert.equal(r.src_size, String(fs.statSync(f).size));
    assert.ok(Number(r.free_kb) > 0);
    assert.equal((await x.end('probe002')).code, 'outside_roots');
    assert.equal((await x.end('probe003')).code, 'unsupported_type');
    assert.equal((await x.end('probe004')).code, 'probe_failed');
    assert.deepEqual(x.encodes(), []);
  });
});

describe('umwandeln.sh: Prüfung vor dem Tausch – bei jedem Zweifel bleibt das Original', () => {
  const bad = {
    'noch 10 Bit': [media({ profile: 'High 10', pixFmt: 'yuv420p10le' }), 'verify_bits'],
    'anderer Codec': [media({ codec: 'hevc', profile: 'Main', pixFmt: 'yuv420p' }), 'verify_codec'],
    'Dauer weicht 0,7 s ab': [media({ profile: 'High', pixFmt: 'yuv420p', duration: '61.703000' }), 'verify_duration'],
    'eine Tonspur fehlt': [media({ profile: 'High', pixFmt: 'yuv420p', audio: 1 }), 'verify_streams'],
    'ein Untertitel fehlt': [media({ profile: 'High', pixFmt: 'yuv420p', subtitles: 0 }), 'verify_streams'],
    'eine Schrift (Anhang) fehlt': [media({ profile: 'High', pixFmt: 'yuv420p', attachments: 1 }), 'verify_streams'],
    'Kapitel fehlen': [media({ profile: 'High', pixFmt: 'yuv420p', chapters: 0 }), 'verify_chapters'],
    'andere Auflösung': [media({ profile: 'High', pixFmt: 'yuv420p', width: 1280, height: 720 }), 'verify_size'],
    'unlesbar': ['abgeschnitten', 'verify_probe'],
    'viel zu klein': [media({ profile: 'High', pixFmt: 'yuv420p' }), 'verify_small', media({ pad: 200_000 })],
  };
  it('ffprobe-Vergleich: ' + Object.keys(bad).join(', '), async (t) => {
    const x = setup(t);
    let n = 0;
    for (const [name, [out, code, srcText]] of Object.entries(bad)) {
      const id = `pruef${String(++n).padStart(4, '0')}`;
      const src = x.file(`v/${id}.mkv`, srcText);
      const before = fs.readFileSync(src, 'utf8');
      fs.writeFileSync(path.join(x.sb.dir, 'fake', 'out'), out);
      x.convert(id, src);
      const s = await x.end(id);
      assert.deepEqual([s.state, s.code], ['failed', code], name);
      assert.equal(fs.readFileSync(src, 'utf8'), before, `${name}: Original unverändert`);
      x.unjob(id);
    }
    assert.ok(!fs.existsSync(path.join(x.sb.root, '.gc-papierkorb')), 'nichts im Papierkorb');
    assert.deepEqual(fs.readdirSync(path.join(x.sb.root, '.gc-umwandeln')), ['.ignore'], 'keine Zwischendatei');
  });

  it('Dauer bis 0,6 s Abweichung gilt; der Probelauf (einmal dekodieren) entscheidet zuletzt', async (t) => {
    const x = setup(t);
    const a = x.file('a.mkv');
    fs.writeFileSync(path.join(x.sb.dir, 'fake', 'out'), media({ profile: 'High', pixFmt: 'yuv420p', duration: '61.500000' }));
    x.convert('pruef100', a);
    assert.equal((await x.end('pruef100')).state, 'done');
    x.sb.flag('decode_fails');
    const b = x.file('b.mkv');
    const before = fs.readFileSync(b, 'utf8');
    x.convert('pruef101', b);
    const s = await x.end('pruef101');
    assert.deepEqual([s.state, s.code], ['failed', 'verify_decode']);
    assert.deepEqual(x.res('pruef101').log, ['Error while decoding stream #0:0']);
    assert.equal(fs.readFileSync(b, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(x.sb.root, '.gc-umwandeln', 'pruef101.part.mkv')));
  });

  it('VERIFY_DECODE=0 lässt nur den Probelauf weg, nicht den ffprobe-Vergleich', async (t) => {
    const x = setup(t, { conf: CONF.replace('VERIFY_DECODE=1', 'VERIFY_DECODE=0') });
    x.sb.flag('decode_fails');
    x.convert('pruef200', x.file('a.mkv'));
    assert.equal((await x.end('pruef200')).state, 'done');
    assert.ok(!x.sb.calls().some((c) => c.includes('-xerror')));
    fs.writeFileSync(path.join(x.sb.dir, 'fake', 'out'), media());
    x.convert('pruef201', x.file('b.mkv'));
    assert.equal((await x.end('pruef201')).code, 'verify_bits');
  });

  it('ffmpeg scheitert: encode_failed mit dem Ende des Protokolls, Original bleibt', async (t) => {
    const x = setup(t);
    x.sb.flag('encode_fails');
    const src = x.file('a.mkv');
    const before = fs.readFileSync(src, 'utf8');
    x.convert('fehler01', src);
    const s = await x.end('fehler01');
    assert.deepEqual([s.state, s.code], ['failed', 'encode_failed']);
    const r = x.res('fehler01');
    assert.deepEqual(r.log, ['Conversion failed!']);
    assert.equal(r.mode, 'vaapi_icq');
    assert.equal(r.src_bits, '10');
    assert.equal(fs.readFileSync(src, 'utf8'), before);
  });

  it('zu wenig Platz: no_space, bevor ffmpeg startet', async (t) => {
    const x = setup(t, { conf: CONF.replace('MIN_FREE_GB=0', 'MIN_FREE_GB=99999') });
    x.convert('platz001', x.file('a.mkv'));
    assert.equal((await x.end('platz001')).code, 'no_space');
    assert.ok(Number(x.res('platz001').free_kb) > 0);
    assert.deepEqual(x.encodes(), []);
  });

  it('ändert sich die Quelle während des Umwandelns, wird nicht getauscht', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    const src = x.file('a.mkv');
    x.convert('quelle01', src);
    await x.is('quelle01', 'running');
    fs.appendFileSync(src, 'neu');
    const changed = fs.readFileSync(src, 'utf8');
    x.sb.flag('hang', false);
    assert.equal((await x.end('quelle01')).code, 'source_changed');
    assert.equal(fs.readFileSync(src, 'utf8'), changed);
    assert.ok(!fs.existsSync(path.join(x.sb.root, '.gc-papierkorb', DAY())));
  });
});

describe('umwandeln.sh: abbrechen, anhalten, Neustart', () => {
  it('Auftragsdatei weg → ffmpeg beendet, Zwischendatei und Zustand entfernt, Original unberührt', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    const src = x.file('a.mkv');
    const before = fs.readFileSync(src, 'utf8');
    x.convert('abbruch1', src);
    const part = path.join(x.sb.root, '.gc-umwandeln', 'abbruch1.part.mkv');
    await waitFor(() => fs.existsSync(path.join(x.sb.dir, 'fake', 'started')), { what: 'ffmpeg running' });
    assert.equal(x.children().length, 1);
    x.unjob('abbruch1');
    await waitFor(() => x.state('abbruch1') === null && x.children().length === 0, { what: 'cancelled' });
    assert.ok(!fs.existsSync(part));
    assert.ok(!fs.existsSync(path.join(x.sb.ctl, 'state', 'abbruch1.res')));
    assert.equal(fs.readFileSync(src, 'utf8'), before);
    // der nächste Auftrag läuft danach normal
    x.sb.flag('hang', false);
    x.convert('abbruch2', src);
    assert.equal((await x.end('abbruch2')).state, 'done');
  });

  it('anhalten (alles oder ein Auftrag) hält ffmpeg wirklich an (SIGSTOP), fortsetzen lässt es weiterlaufen', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    x.convert('pause001', x.file('a.mkv'));
    await x.is('pause001', 'running');
    for (const file of ['pause', 'jobs/pause001.pause']) {
      fs.writeFileSync(path.join(x.sb.ctl, file), 'on\n');
      await x.is('pause001', 'paused');
      await waitFor(() => x.children().some(([, st]) => st.startsWith('T')), { what: 'ffmpeg stopped' });
      fs.rmSync(path.join(x.sb.ctl, file));
      await x.is('pause001', 'running');
      assert.ok(x.children().every(([, st]) => !st.startsWith('T')));
    }
    x.sb.flag('hang', false);
    assert.equal((await x.end('pause001')).state, 'done');
  });

  it('angehalten wird kein neuer Auftrag begonnen; ein zweiter wartet, bis der erste fertig ist', async (t) => {
    const x = setup(t);
    fs.writeFileSync(path.join(x.sb.ctl, 'pause'), 'on\n');
    const a = x.file('a.mkv');
    const b = x.file('b.mkv');
    x.convert('reihe001', a);
    await x.is('reihe001', 'paused');
    assert.deepEqual(x.encodes(), []);
    x.sb.flag('hang');
    fs.rmSync(path.join(x.sb.ctl, 'pause'));
    await x.is('reihe001', 'running');
    x.convert('reihe002', b);
    await x.is('reihe002', 'queued');
    assert.equal(x.encodes().length, 1);
    x.sb.flag('hang', false);
    assert.equal((await x.end('reihe001')).state, 'done');
    assert.equal((await x.end('reihe002')).state, 'done');
    assert.equal(x.encodes().length, 2);
  });

  it('Funktion aus (run weg) bricht den laufenden Auftrag ab', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    const src = x.file('a.mkv');
    const before = fs.readFileSync(src, 'utf8');
    x.convert('aus00001', src);
    await x.is('aus00001', 'running');
    fs.rmSync(path.join(x.sb.ctl, 'run'));
    await waitFor(() => x.state('aus00001') === null && x.children().length === 0, { what: 'stopped' });
    assert.equal(fs.readFileSync(src, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(x.sb.root, '.gc-umwandeln')), ['.ignore']);
  });

  it('Wächter hart beendet (Stromausfall) → halbe Zwischendatei wird weggeräumt, der Auftrag beginnt neu; am Zielort lag immer das Original', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    const src = x.file('a.mkv');
    const before = fs.readFileSync(src, 'utf8');
    x.convert('neu00001', src);
    await x.is('neu00001', 'running');
    const kids = x.children();
    await x.w.stop('SIGKILL');
    for (const [pid] of kids) process.kill(Number(pid), 'SIGKILL');
    const part = path.join(x.sb.root, '.gc-umwandeln', 'neu00001.part.mkv');
    fs.writeFileSync(part, 'halbe datei');
    assert.equal(fs.readFileSync(src, 'utf8'), before);
    assert.equal(x.state('neu00001').state, 'running', 'der alte Zustand steht noch im Volume');
    x.sb.flag('hang', false);
    x.start();
    assert.equal((await x.end('neu00001')).state, 'done');
    assert.match(fs.readFileSync(src, 'utf8'), /^pix_fmt=yuv420p$/m);
    assert.equal(fs.readFileSync(path.join(x.sb.root, '.gc-papierkorb', DAY(), 'a.mkv'), 'utf8'), before);
    assert.equal(x.encodes().length, 2);
  });

  it('SIGTERM (Container stoppt): ffmpeg beendet, Zwischendatei weg', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    const src = x.file('a.mkv');
    x.convert('term0001', src);
    const part = path.join(x.sb.root, '.gc-umwandeln', 'term0001.part.mkv');
    await waitFor(() => fs.existsSync(path.join(x.sb.dir, 'fake', 'started')), { what: 'ffmpeg running' });
    const [[pid]] = x.children();
    await x.w.stop('SIGTERM');
    await waitFor(() => !fs.existsSync(`/proc/${pid}`), { what: 'ffmpeg gone' });
    assert.ok(!fs.existsSync(part));
  });

  it('neue Fassung des Skripts vom Gateway: gewechselt wird erst, wenn nichts läuft', async (t) => {
    const x = setup(t);
    x.sb.flag('hang');
    x.convert('skript01', x.file('a.mkv'));
    await x.is('skript01', 'running');
    const v2 = fs.readFileSync(WATCHER, 'utf8').replace('\numask 022\n', '\numask 022\n: > "$C/state/zweite-fassung"\n');
    assert.notEqual(v2, fs.readFileSync(WATCHER, 'utf8'));
    fs.writeFileSync(path.join(x.sb.ctl, 'umwandeln.sh.tmp'), v2);
    fs.renameSync(path.join(x.sb.ctl, 'umwandeln.sh.tmp'), path.join(x.sb.ctl, 'umwandeln.sh'));
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!fs.existsSync(path.join(x.sb.ctl, 'state', 'zweite-fassung')));
    assert.equal(x.state('skript01').state, 'running');
    x.sb.flag('hang', false);
    assert.equal((await x.end('skript01')).state, 'done');
    await waitFor(() => fs.existsSync(path.join(x.sb.ctl, 'state', 'zweite-fassung')), { what: 're-exec' });
  });
});

describe('umwandeln.sh: Wiederanlauf mitten im Tausch (.gc-info pending)', () => {
  it('vier Lagen: nur Link angelegt · Tausch fertig · Original schon weg, neue Datei wartet · Original weg, nichts da', async (t) => {
    const x = setup(t, { start: false });
    const day = path.join(x.sb.root, '.gc-papierkorb', '2026-11-20');
    const work = path.join(x.sb.root, '.gc-umwandeln');
    fs.mkdirSync(day, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const orig = (n) => media({ pad: n });
    const neu = media({ profile: 'High', pixFmt: 'yuv420p' });
    const at = Math.floor(Date.now() / 1000) - 3600;
    // a) nur der harte Link war angelegt
    const a = x.file('a.mkv', orig(1));
    fs.linkSync(a, path.join(day, 'a.mkv'));
    writeInfo(path.join(day, 'a.mkv.gc-info'), { id: 'lage000a', state: 'pending', at, src: a, size: 1 });
    // b) rename(2) war schon geschehen
    const b = x.file('b.mkv', neu);
    fs.writeFileSync(path.join(day, 'b.mkv'), orig(2));
    writeInfo(path.join(day, 'b.mkv.gc-info'), { id: 'lage000b', state: 'pending', at, src: b, size: 2 });
    // c) Dateisystem ohne Links: Original verschoben, neue Datei liegt noch im Arbeitsordner
    const c = path.join(x.sb.root, 'c.mkv');
    fs.writeFileSync(path.join(day, 'c.mkv'), orig(3));
    fs.writeFileSync(path.join(work, 'lage000c.part.mkv'), neu);
    writeInfo(path.join(day, 'c.mkv.gc-info'), { id: 'lage000c', state: 'pending', at, src: c, size: 3 });
    // d) Original verschoben, keine neue Datei mehr
    const d = path.join(x.sb.root, 'sub', 'd.mkv');
    fs.writeFileSync(path.join(day, 'd.mkv'), orig(4));
    writeInfo(path.join(day, 'd.mkv.gc-info'), { id: 'lage000d', state: 'pending', at, src: d, size: 4 });
    // e) eine .gc-info, die aus der Wurzel hinaus zeigt, wird nicht angefasst
    const outside = path.join(x.sb.dir, 'draussen.mkv');
    fs.writeFileSync(path.join(day, 'e.mkv'), orig(5));
    writeInfo(path.join(day, 'e.mkv.gc-info'), { id: 'lage000e', state: 'pending', at, src: outside, size: 5 });
    fs.writeFileSync(path.join(work, 'fremd999.part.mkv'), 'liegengeblieben');

    x.start();
    await x.alive();
    assert.equal(fs.readFileSync(a, 'utf8'), orig(1));
    assert.ok(!fs.existsSync(path.join(day, 'a.mkv')) && !fs.existsSync(path.join(day, 'a.mkv.gc-info')));
    assert.equal(fs.readFileSync(b, 'utf8'), neu);
    assert.equal(fs.readFileSync(path.join(day, 'b.mkv'), 'utf8'), orig(2));
    assert.deepEqual([info(path.join(day, 'b.mkv.gc-info')).state, info(path.join(day, 'b.mkv.gc-info')).at], ['done', String(at)]);
    assert.equal(fs.readFileSync(c, 'utf8'), neu);
    assert.equal(fs.readFileSync(path.join(day, 'c.mkv'), 'utf8'), orig(3));
    assert.equal(info(path.join(day, 'c.mkv.gc-info')).state, 'done');
    assert.equal(fs.readFileSync(d, 'utf8'), orig(4), 'Original zurück an seinem Ort');
    assert.ok(!fs.existsSync(path.join(day, 'd.mkv')) && !fs.existsSync(path.join(day, 'd.mkv.gc-info')));
    assert.ok(!fs.existsSync(outside));
    assert.equal(fs.readFileSync(path.join(day, 'e.mkv'), 'utf8'), orig(5));
    assert.deepEqual(fs.readdirSync(work), [], 'Zwischendateien weg');

    // derselbe Auftrag noch einmal (Gateway nach Neustart): fertig, ohne neu umzuwandeln
    x.convert('lage000b', b);
    assert.equal((await x.end('lage000b')).state, 'done');
    assert.deepEqual([x.res('lage000b').resumed, x.res('lage000b').trash], ['1', path.join(day, 'b.mkv')]);
    assert.deepEqual(x.encodes(), []);
  });

  it('Dateisystem ohne harte Links: zwei Umbenennungen, gleiches Ergebnis', async (t) => {
    const x = setup(t, { start: false });
    fs.writeFileSync(path.join(x.sb.dir, 'bin', 'ln'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    x.start({ extraEnv: { PATH: `${path.join(x.sb.dir, 'bin')}:${process.env.PATH}` } });
    const src = x.file('a.mkv');
    const before = fs.readFileSync(src, 'utf8');
    const ino = fs.statSync(src).ino;
    x.convert('ohnelink', src);
    assert.equal((await x.end('ohnelink')).state, 'done');
    const trash = path.join(x.sb.root, '.gc-papierkorb', DAY(), 'a.mkv');
    assert.equal(fs.readFileSync(trash, 'utf8'), before);
    assert.equal(fs.statSync(trash).ino, ino);
    assert.match(fs.readFileSync(src, 'utf8'), /^pix_fmt=yuv420p$/m);
    assert.equal(info(trash + '.gc-info').state, 'done');
  });

  it('dieselbe Datei am selben Tag zweimal: das zweite Original bekommt einen eigenen Ordner', async (t) => {
    const x = setup(t);
    const src = x.file('a.mkv', media({ pad: 1 }));
    x.convert('doppelt1', src);
    assert.equal((await x.end('doppelt1')).state, 'done');
    fs.writeFileSync(src, media({ pad: 2 }));
    x.convert('doppelt2', src);
    assert.equal((await x.end('doppelt2')).state, 'done');
    const base = path.join(x.sb.root, '.gc-papierkorb');
    assert.equal(fs.readFileSync(path.join(base, DAY(), 'a.mkv'), 'utf8'), media({ pad: 1 }));
    assert.equal(fs.readFileSync(path.join(base, `${DAY()}_2`, 'a.mkv'), 'utf8'), media({ pad: 2 }));
    assert.equal(x.res('doppelt2').trash, path.join(base, `${DAY()}_2`, 'a.mkv'));
  });
});

describe('umwandeln.sh: Papierkorb – Frist, wiederherstellen, löschen', () => {
  const seed = (x, name, id, ageDays, state = 'done') => {
    const dir = path.join(x.sb.root, '.gc-papierkorb', `alt-${id}`, 'Serie');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), media({ pad: 10 }));
    writeInfo(path.join(dir, `${name}.gc-info`), { id, state, at: Math.floor(Date.now() / 1000) - ageDays * 86400, src: path.join(x.sb.root, 'Serie', name), size: 10 });
    return path.join(dir, name);
  };

  it('nach 14 Tagen gelöscht, davor nicht; leere Ordner verschwinden; offene Tausche bleiben', async (t) => {
    const x = setup(t, { start: false });
    const old = seed(x, 'alt.mkv', 'frist001', 15);
    const edge = seed(x, 'knapp.mkv', 'frist002', 13);
    const pend = seed(x, 'offen.mkv', 'frist003', 30, 'pending');
    fs.mkdirSync(path.join(x.sb.root, 'Serie'));
    fs.writeFileSync(path.join(x.sb.root, 'Serie', 'offen.mkv'), 'neu');   // Tausch war fertig → wird „done“ mit altem Datum
    const stray = path.join(x.sb.root, '.gc-papierkorb', 'von-hand.mkv');
    fs.writeFileSync(stray, 'ohne gc-info');
    x.start();
    await x.alive();
    assert.ok(!fs.existsSync(old) && !fs.existsSync(old + '.gc-info'));
    assert.ok(!fs.existsSync(path.join(x.sb.root, '.gc-papierkorb', 'alt-frist001')), 'leerer Ordner weg');
    assert.ok(fs.existsSync(edge) && fs.existsSync(edge + '.gc-info'));
    assert.ok(!fs.existsSync(pend), 'ein fertiger Tausch von vor 30 Tagen ist abgelaufen');
    assert.ok(fs.existsSync(stray), 'ohne .gc-info wird nichts gelöscht');
    const list = fs.readFileSync(path.join(x.sb.ctl, 'state', 'trash'), 'utf8').trim().split('\n');
    assert.equal(list.length, 1);
    assert.equal(list[0].split('\t')[0], 'frist002');
  });

  it('die Frist kommt aus conf (TRASH_DAYS); ohne conf wird nie gelöscht', async (t) => {
    const x = setup(t, { start: false, conf: CONF.replace('TRASH_DAYS=14', 'TRASH_DAYS=30') });
    const a = seed(x, 'a.mkv', 'frist010', 20);
    const b = seed(x, 'b.mkv', 'frist011', 31);
    x.start();
    await x.alive();
    assert.ok(fs.existsSync(a));
    assert.ok(!fs.existsSync(b));

    const y = setup(t, { start: false, conf: null });
    const c = seed(y, 'c.mkv', 'frist012', 400);
    y.start();
    await waitFor(() => fs.existsSync(path.join(y.sb.ctl, 'state', 'caps')), { what: 'up' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(fs.existsSync(c));
  });

  it('wiederherstellen: das Original ersetzt die neue Datei in einem Schritt; unbekannt → not_in_trash', async (t) => {
    const x = setup(t);
    const src = x.file('Serie/Folge 02.mkv');
    const before = fs.readFileSync(src, 'utf8');
    x.convert('zurueck1', src);
    assert.equal((await x.end('zurueck1')).state, 'done');
    x.unjob('zurueck1');
    x.job('q0000001', ['KIND=restore', 'REF=zurueck1']);
    assert.equal((await x.end('q0000001')).state, 'done');
    assert.equal(x.res('q0000001').restored, src);
    assert.equal(fs.readFileSync(src, 'utf8'), before);
    assert.deepEqual(x.tree().filter((p) => p.startsWith('.gc-papierkorb')), ['.gc-papierkorb', '.gc-papierkorb/.ignore']);
    assert.equal(fs.readFileSync(path.join(x.sb.ctl, 'state', 'trash'), 'utf8'), '');
    x.job('q0000002', ['KIND=restore', 'REF=zurueck1']);
    assert.equal((await x.end('q0000002')).code, 'not_in_trash');
    x.job('q0000003', ['KIND=restore', 'REF=../../x']);
    assert.equal((await x.end('q0000003')).code, 'bad_request');
  });

  it('wiederherstellen legt einen inzwischen gelöschten Ordner wieder an; eine .gc-info nach außen wird abgelehnt', async (t) => {
    const x = setup(t, { start: false });
    const a = seed(x, 'weg.mkv', 'zurueck2', 1);
    const evil = path.join(x.sb.root, '.gc-papierkorb', 'x', 'evil.mkv');
    fs.mkdirSync(path.dirname(evil), { recursive: true });
    fs.writeFileSync(evil, 'x');
    writeInfo(evil + '.gc-info', { id: 'zurueck3', state: 'done', at: Math.floor(Date.now() / 1000), src: path.join(x.sb.dir, 'ctl', 'run'), size: 1 });
    const trav = path.join(x.sb.root, '.gc-papierkorb', 'y', 't.mkv');
    fs.mkdirSync(path.dirname(trav), { recursive: true });
    fs.writeFileSync(trav, 'x');
    writeInfo(trav + '.gc-info', { id: 'zurueck4', state: 'done', at: Math.floor(Date.now() / 1000), src: `${x.sb.root}/../ctl/run`, size: 1 });
    x.start();
    x.job('q0000010', ['KIND=restore', 'REF=zurueck2']);
    x.job('q0000011', ['KIND=restore', 'REF=zurueck3']);
    x.job('q0000012', ['KIND=restore', 'REF=zurueck4']);
    assert.equal((await x.end('q0000010')).state, 'done');
    assert.ok(fs.existsSync(path.join(x.sb.root, 'Serie', 'weg.mkv')) && !fs.existsSync(a));
    assert.equal((await x.end('q0000011')).code, 'outside_roots');
    assert.equal((await x.end('q0000012')).code, 'bad_path');
    assert.equal(fs.readFileSync(path.join(x.sb.ctl, 'run'), 'utf8'), 'on\n');
    assert.ok(fs.existsSync(evil) && fs.existsSync(trav));
  });

  it('endgültig löschen: eines oder alle', async (t) => {
    const x = setup(t, { start: false });
    const a = seed(x, 'a.mkv', 'weg00001', 1);
    const b = seed(x, 'b.mkv', 'weg00002', 2);
    const c = seed(x, 'c.mkv', 'weg00003', 3);
    x.start();
    x.job('q0000020', ['KIND=purge', 'REF=weg00001']);
    assert.equal((await x.end('q0000020')).state, 'done');
    assert.ok(!fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(c));
    x.job('q0000021', ['KIND=purge', 'REF=weg00001']);
    assert.equal((await x.end('q0000021')).code, 'not_in_trash');
    x.job('q0000022', ['KIND=purge', 'ALL=1']);
    assert.equal((await x.end('q0000022')).state, 'done');
    assert.ok(!fs.existsSync(b) && !fs.existsSync(c));
    assert.deepEqual(fs.readdirSync(path.join(x.sb.root, '.gc-papierkorb')), []);
    x.job('q0000023', ['KIND=unsinn']);
    assert.equal((await x.end('q0000023')).code, 'bad_request');
  });
});
