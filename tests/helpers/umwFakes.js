'use strict';

// Attrappen für den Dienst „umwandeln“ (tests/transcode_*.test.js): ffmpeg,
// ffprobe und vainfo als kleine Shell-Skripte. Eine „Videodatei“ ist hier ein
// Text in der Ausgabeform von ffprobe (-of default); das Ersatz-ffmpeg schreibt
// daraus die „umgewandelte“ Datei (H.264 High, yuv420p). Verhalten über Dateien
// im Ordner $FAKE: encode_fails, decode_fails, no_icq, no_qvbr, no_x264, no_va,
// hang (läuft, bis die Datei weg ist), out (Inhalt der Ausgabe statt der Umformung).
// Solange das Ersatz-ffmpeg umwandelt, liegt $FAKE/started da.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WATCHER = path.join(__dirname, '..', '..', 'src', 'transcode', 'umwandeln.sh');

const FAKE_FFMPEG = `#!/bin/sh
F="\${FAKE:?}"
printf '%s\\n' "$*" >> "$F/calls"
in=""; out=""; prog=""; prev=""
for a in "$@"; do
  case "$prev" in -i) in="\${a#file:}" ;; -progress) prog="$a" ;; esac
  prev="$a"; out="$a"
done
out="\${out#file:}"
case "$*" in
  *"-version"*) echo "ffmpeg version 8.1.3-Fake Copyright (c) the FFmpeg developers"; exit 0 ;;
  *"-encoders"*) [ -f "$F/no_x264" ] || echo " V....D libx264              libx264 H.264"; exit 0 ;;
  *lavfi*)
    case "$*" in
      *ICQ*) [ -f "$F/no_icq" ] && { echo "Driver does not support ICQ RC mode" >&2; exit 1; } ;;
      *QVBR*) [ -f "$F/no_qvbr" ] && { echo "Driver does not support QVBR RC mode" >&2; exit 1; } ;;
    esac
    exit 0 ;;
  *"-f null"*) [ -f "$F/decode_fails" ] && { echo "Error while decoding stream #0:0" >&2; exit 1; }; exit 0 ;;
esac
[ -f "$F/encode_fails" ] && { echo "Conversion failed!" >&2; exit 1; }
printf '%s\\n' "$$" > "$F/started"
i=0
while [ "$i" -lt 2 ] || [ -f "$F/hang" ]; do
  i=$((i + 1))
  [ -n "$prog" ] && printf 'frame=%s\\nfps=78.3\\nout_time_us=%s\\nspeed=3.14x\\nprogress=continue\\n' "$((i * 100))" "$((i * 10000000))" >> "$prog"
  sleep 0.1
done
rm -f "$F/started"
if [ -f "$F/out" ]; then cat "$F/out" > "$out"
else sed -e 's/^pix_fmt=yuv4[24][024]p1[026]le$/pix_fmt=yuv420p/' -e 's/^pix_fmt=p010le$/pix_fmt=yuv420p/' -e 's/^profile=High 10$/profile=High/' -e 's/^codec_name=hevc$/codec_name=h264/' "$in" > "$out"
fi
exit 0
`;

const FAKE_FFPROBE = `#!/bin/sh
for a in "$@"; do f="$a"; done
f="\${f#file:}"
[ -f "$f" ] || exit 1
grep -q '^\\[FORMAT\\]' "$f" || { echo "Invalid data found when processing input" >&2; exit 1; }
cat "$f"
`;

const FAKE_VAINFO = `#!/bin/sh
F="\${FAKE:?}"
[ -f "$F/no_va" ] && { echo "vaInitialize failed with error code -1 (unknown libva error), exit"; exit 3; }
echo "vainfo: VA-API version: 1.22 (libva 2.22.0)"
echo "vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 26.3.5 (1b5e662)"
echo "      VAProfileH264High               :	VAEntrypointVLD"
echo "      VAProfileH264High               :	VAEntrypointEncSlice"
`;

/** Text einer „Videodatei“ (Ausgabe von ffprobe -of default). */
function media({ codec = 'h264', profile = 'High 10', pixFmt = 'yuv420p10le', width = 1920, height = 1080, fps = '50/1', level = 42,
  audio = 2, subtitles = 1, attachments = 2, pictures = 0, chapters = 7, duration = '61.003000', container = 'matroska,webm', pad = 0 } = {}) {
  const out = [];
  let idx = 0;
  const stream = (lines) => { out.push('[STREAM]', `index=${idx++}`, ...lines, '[/STREAM]'); };
  stream([`codec_name=${codec}`, `profile=${profile}`, 'codec_type=video', `width=${width}`, `height=${height}`, `pix_fmt=${pixFmt}`, `level=${level}`,
    'field_order=progressive', `r_frame_rate=${fps}`, 'DISPOSITION:attached_pic=0']);
  for (let i = 0; i < audio; i++) stream(['codec_name=aac', 'profile=LC', 'codec_type=audio', 'r_frame_rate=0/0', 'DISPOSITION:attached_pic=0']);
  for (let i = 0; i < subtitles; i++) stream(['codec_name=ass', 'profile=unknown', 'codec_type=subtitle', 'r_frame_rate=0/0', 'DISPOSITION:attached_pic=0']);
  for (let i = 0; i < attachments; i++) stream(['codec_name=ttf', 'profile=unknown', 'codec_type=attachment', 'r_frame_rate=0/0', 'DISPOSITION:attached_pic=0']);
  for (let i = 0; i < pictures; i++) stream(['codec_name=mjpeg', 'profile=Baseline', 'codec_type=video', 'width=600', 'height=900', 'pix_fmt=yuvj420p', 'r_frame_rate=90000/1', 'DISPOSITION:attached_pic=1']);
  for (let i = 0; i < chapters; i++) out.push('[CHAPTER]', `id=${i + 1}`, '[/CHAPTER]');
  out.push('[FORMAT]', `format_name=${container}`, `duration=${duration}`, '[/FORMAT]');
  return out.join('\n') + '\n' + '#'.repeat(pad);
}

/**
 * Arbeitsordner für einen Test: ctl (Volume umw-ctl), Medienwurzel(n), Attrappen in bin/.
 * device: 'ok' (Datei da), 'absent'.
 */
function sandbox({ roots = ['medien'], device = 'ok' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-umw-')));
  const p = (...a) => path.join(dir, ...a);
  for (const d of ['ctl', 'ctl/jobs', 'tmp', 'bin', 'fake', ...roots]) fs.mkdirSync(p(d), { recursive: true });
  fs.writeFileSync(p('bin', 'ffmpeg'), FAKE_FFMPEG, { mode: 0o755 });
  fs.writeFileSync(p('bin', 'ffprobe'), FAKE_FFPROBE, { mode: 0o755 });
  fs.writeFileSync(p('bin', 'vainfo'), FAKE_VAINFO, { mode: 0o755 });
  fs.writeFileSync(p('fake', 'calls'), '');
  if (device === 'ok') fs.writeFileSync(p('renderD128'), '');
  const rootPaths = roots.map((r) => p(r));
  const env = {
    PATH: process.env.PATH, FAKE: p('fake'),
    GC_UMW_DIR: p('ctl'), GC_UMW_TMP: p('tmp'), GC_UMW_ROOTS: rootPaths.join(':'), GC_UMW_RENDER: p('renderD128'),
    GC_UMW_POLL: '0.05', GC_FFMPEG: p('bin', 'ffmpeg'), GC_FFPROBE: p('bin', 'ffprobe'), GC_VAINFO: p('bin', 'vainfo'),
  };
  const flag = (name, on = true) => { if (on) fs.writeFileSync(p('fake', name), ''); else fs.rmSync(p('fake', name), { force: true }); };
  const calls = () => fs.readFileSync(p('fake', 'calls'), 'utf8').split('\n').filter(Boolean);
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  return { dir, p, env, ctl: p('ctl'), roots: rootPaths, root: rootPaths[0], flag, calls, cleanup };
}

/** Den Wächter starten (wie der Einstieg des Dienstes). stop() beendet ihn und wartet. */
function startWatcher(sb, { script = WATCHER, extraEnv = {} } = {}) {
  const dst = path.join(sb.ctl, 'umwandeln.sh');
  if (!fs.existsSync(dst)) fs.copyFileSync(script, dst);
  const child = spawn('/bin/sh', [dst], { env: { ...sb.env, ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => child.on('exit', r));
  return {
    child,
    stderr: () => stderr,
    stop: async (signal = 'SIGTERM') => { child.kill(signal); await exited; },
  };
}

async function waitFor(fn, { timeoutMs = 10_000, stepMs = 25, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

module.exports = { WATCHER, FAKE_FFMPEG, FAKE_FFPROBE, FAKE_VAINFO, media, sandbox, startWatcher, waitFor };
