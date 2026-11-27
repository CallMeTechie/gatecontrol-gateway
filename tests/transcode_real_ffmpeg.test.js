'use strict';

// Wächter umwandeln.sh mit dem echten ffmpeg/ffprobe des Rechners (wie die
// Kamera-Tests: übersprungen, wenn ffmpeg fehlt): ein erzeugtes 10-Bit-Video mit
// zwei Tonspuren, Untertitel, Anhang und Kapiteln → H.264 8 Bit auf dem
// Software-Weg (libx264; VAAPI gibt es hier nicht). Prüft die echten Aufrufe:
// Zuordnung der Spuren, Fortschritt, ffprobe-Vergleich, Probelauf, Tausch.
// Derselbe Ablauf läuft im Workflow „umwandeln-image“ im fertigen Image.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { sandbox, startWatcher, waitFor } = require('./helpers/umwFakes');

const has = (bin) => spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0;
const HAS_FFMPEG = has('ffmpeg') && has('ffprobe')
  && /libx264/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');

function makeClip(dir, file) {
  fs.writeFileSync(path.join(dir, 'sub.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHallo\n\n2\n00:00:02,500 --> 00:00:03,500\nWelt\n');
  fs.writeFileSync(path.join(dir, 'schrift.ttf'), 'keine echte schrift');
  fs.writeFileSync(path.join(dir, 'meta.txt'), ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Eins\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Zwei\n');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=50:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
    '-i', path.join(dir, 'sub.srt'), '-i', path.join(dir, 'meta.txt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map_metadata', '4', '-map_chapters', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-b:a', '64k', '-c:s', 'ass',
    '-metadata:s:a:0', 'language=deu', '-metadata:s:a:1', 'language=jpn',
    '-attach', path.join(dir, 'schrift.ttf'), '-metadata:s:t', 'mimetype=application/x-truetype-font', '-metadata:s:t', 'filename=schrift.ttf',
    '-f', 'matroska', file]);
}

function ffprobe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_chapters', '-show_format', '-of', 'json', file], { encoding: 'utf8' }));
}

describe('umwandeln.sh mit echtem ffmpeg (Software-Weg)', { skip: !HAS_FFMPEG && 'ffmpeg with libx264 not installed' }, () => {
  it('10-Bit-MKV → H.264 High 8 Bit; Ton, Sprache, Untertitel, Anhang und Kapitel bleiben; Original im Papierkorb', async (t) => {
    const sb = sandbox({ device: 'absent' });
    const w = { cur: null };
    t.after(async () => { if (w.cur) await w.cur.stop('SIGKILL'); sb.cleanup(); });
    fs.mkdirSync(path.join(sb.root, 'Serie'));
    const src = path.join(sb.root, 'Serie', "Folge 01 – 'Test' [10bit].mkv");
    makeClip(sb.dir, src);
    const before = ffprobe(src);
    const v0 = before.streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([v0.codec_name, v0.profile, v0.pix_fmt], ['h264', 'High 10', 'yuv420p10le']);
    const origBytes = fs.readFileSync(src);

    fs.writeFileSync(path.join(sb.ctl, 'run'), 'on\n');
    fs.writeFileSync(path.join(sb.ctl, 'conf'), 'TRASH_DAYS=14\nRESERVE_MB=0\nMIN_FREE_GB=0\nMIN_FREE_PCT=0\nVERIFY_DECODE=1\n');
    fs.writeFileSync(path.join(sb.ctl, 'jobs', 'echt0001.job'), `KIND=convert\nSRC=${src}\nSOFTWARE=1\nQUALITY=23\n`);
    w.cur = startWatcher(sb, { extraEnv: { GC_FFMPEG: 'ffmpeg', GC_FFPROBE: 'ffprobe', GC_VAINFO: 'false' } });
    const state = () => { try { return fs.readFileSync(path.join(sb.ctl, 'state', 'echt0001'), 'utf8').trim().split(' '); } catch { return []; } };
    await waitFor(() => ['done', 'failed'].includes(state()[0]), { timeoutMs: 120_000, stepMs: 100, what: 'convert' });
    const res = fs.readFileSync(path.join(sb.ctl, 'state', 'echt0001.res'), 'utf8');
    assert.deepEqual(state().slice(0, 1).concat(state()[2]), ['done', '-'], res);
    assert.match(res, /^mode=software$/m);
    assert.match(res, /^src_bits=10$/m);
    assert.match(res, /^new_bits=8$/m);
    assert.match(res, /^src_fps=50\.000$/m);

    const after = ffprobe(src);
    const v1 = after.streams.filter((s) => s.codec_type === 'video');
    assert.equal(v1.length, 1);
    assert.deepEqual([v1[0].codec_name, v1[0].profile, v1[0].pix_fmt, v1[0].width, v1[0].height, v1[0].r_frame_rate], ['h264', 'High', 'yuv420p', 640, 360, '50/1']);
    const kinds = (p) => p.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort();
    assert.deepEqual(kinds(after).filter((k) => !k.startsWith('video')), kinds(before).filter((k) => !k.startsWith('video')));
    assert.deepEqual(after.streams.filter((s) => s.codec_type === 'audio').map((s) => s.tags.language), ['deu', 'jpn']);
    assert.deepEqual(after.streams.filter((s) => s.codec_type === 'attachment').map((s) => s.tags.filename), ['schrift.ttf']);
    assert.deepEqual(after.chapters.map((c) => c.tags.title), ['Eins', 'Zwei']);
    assert.ok(Math.abs(Number(after.format.duration) - Number(before.format.duration)) <= 0.6);

    const trash = /^trash=(.*)$/m.exec(res)[1];
    assert.ok(trash.startsWith(path.join(sb.root, '.gc-papierkorb')));
    assert.ok(fs.readFileSync(trash).equals(origBytes), 'das Original liegt unverändert im Papierkorb');
    assert.deepEqual(fs.readdirSync(path.join(sb.root, '.gc-umwandeln')), ['.ignore']);

    // probe (Liste) und wiederherstellen
    fs.rmSync(path.join(sb.ctl, 'jobs', 'echt0001.job'));
    fs.writeFileSync(path.join(sb.ctl, 'jobs', 'echt0002.job'), `KIND=probe\nSRC=${src}\n`);
    fs.writeFileSync(path.join(sb.ctl, 'jobs', 'echt0003.job'), 'KIND=restore\nREF=echt0001\n');
    await waitFor(() => fs.existsSync(path.join(sb.ctl, 'state', 'echt0003')) && fs.existsSync(path.join(sb.ctl, 'state', 'echt0002.res')), { what: 'probe + restore' });
    const p = fs.readFileSync(path.join(sb.ctl, 'state', 'echt0002.res'), 'utf8');
    assert.match(p, /^src_codec=h264$/m);
    assert.match(p, /^src_audio=2$/m);
    assert.match(p, /^src_subtitles=1$/m);
    assert.match(p, /^src_attachments=1$/m);
    assert.match(p, /^src_chapters=2$/m);
    assert.match(p, /^src_container=matroska,webm$/m);
    assert.ok(fs.readFileSync(src).equals(origBytes), 'wiederhergestellt');
  });
});
