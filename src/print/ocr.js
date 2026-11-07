'use strict';

// Texterkennung für Scans (docs/print.md „Texterkennung“): aus den Seiten
// eines Scans (JPEG) ein durchsuchbares PDF – das Bild bleibt, der erkannte
// Text liegt unsichtbar darüber – und der Text für die Suche im Drive.
// tesseract (deu+eng, im Image) erkennt je Seite in einem eigenen Prozess mit
// niedriger Priorität und einem Kern (OMP_THREAD_LIMIT=1), pdfunite (poppler)
// fügt die Seiten zusammen. Zeitgrenzen je Seite und je Auftrag; es läuft
// immer nur ein Auftrag (print.js reiht sie ein).

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PAGE_TIMEOUT_MS = 240_000;        // eine Seite (Raspberry Pi 3: oft 30–90 s)
const TOTAL_TIMEOUT_MS = 30 * 60_000;   // ein ganzer Auftrag
const MAX_TEXT = 1024 * 1024;           // erkannter Text, höchstens 1 MB
const LANGS = ['deu', 'eng'];

const TOOLS = { tesseract: process.env.GC_TESSERACT || 'tesseract', pdfunite: process.env.GC_PDFUNITE || 'pdfunite' };

class OcrError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

let checked = null;

/** { tool, langs }: tesseract und pdfunite da, welche der Sprachen deu/eng es kennt. Einmal geprüft. */
function probe() {
  if (checked) return checked;
  let langs = [];
  let tool = false;
  try {
    const r = spawnSync(TOOLS.tesseract, ['--list-langs'], { timeout: 10_000, encoding: 'utf8' });
    if (!r.error && r.status === 0) {
      tool = true;
      const seen = new Set(`${r.stdout || ''}\n${r.stderr || ''}`.split(/\s+/));
      langs = LANGS.filter((l) => seen.has(l));
    }
  } catch (_e) { tool = false; }
  let unite = false;
  try { unite = spawnSync(TOOLS.pdfunite, ['-v'], { timeout: 5_000, stdio: 'ignore' }).error == null; } catch (_e) { unite = false; }
  checked = { tool: tool && unite, langs };
  return checked;
}

/** Texterkennung möglich: Werkzeuge da und mindestens eine der Sprachen. */
function available() {
  const p = probe();
  return p.tool && p.langs.length > 0;
}

/** Ein Werkzeug laufen lassen (niedrige Priorität, ein Kern) → { code, err } */
function run(cmd, args, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
    } catch (e) { reject(new OcrError('ocr_unavailable', e.message)); return; }
    try { os.setPriority(child.pid, 15); } catch (_e) { /* nur ein Hinweis an den Kernel */ }
    let err = '';
    let done = false;
    const finish = (e, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (e) { try { child.kill('SIGKILL'); } catch (_x) { /* schon beendet */ } reject(e); } else resolve(v);
    };
    const timer = setTimeout(() => finish(new OcrError('ocr_timeout', 'page timeout')), timeoutMs);
    const onAbort = () => finish(new OcrError('canceled'));
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    child.stderr.on('data', (c) => { if (err.length < 2000) err += c.toString('utf8'); });
    child.on('error', (e) => finish(new OcrError(e.code === 'ENOENT' ? 'ocr_unavailable' : 'ocr_failed', e.message)));
    child.on('close', (code) => {
      if (code === 0) finish(null, { code, err });
      else finish(new OcrError('ocr_failed', err.trim().split('\n').pop().slice(0, 160) || `exit ${code}`));
    });
  });
}

/**
 * Seiten (JPEG/PNG-Dateien) → ein durchsuchbares PDF und der Text.
 * opts: { dir (Arbeitsordner), dpi, signal, pageTimeoutMs, totalTimeoutMs, onPage(n) }
 * → { pdf: Datei, text, pages }
 */
async function recognize(files, opts = {}) {
  const p = probe();
  if (!p.tool || !p.langs.length) throw new OcrError('ocr_unavailable', 'tesseract/pdfunite or languages missing');
  if (!Array.isArray(files) || !files.length) throw new OcrError('ocr_failed', 'no pages');
  const dir = opts.dir;
  const dpi = Number.isInteger(opts.dpi) && opts.dpi >= 70 && opts.dpi <= 1200 ? opts.dpi : 300;
  const until = Date.now() + (opts.totalTimeoutMs || TOTAL_TIMEOUT_MS);
  const pdfs = [];
  let text = '';
  try {
    for (let i = 0; i < files.length; i++) {
      const left = until - Date.now();
      if (left <= 0) throw new OcrError('ocr_timeout', 'job timeout');
      const base = path.join(dir, `ocr-${i + 1}`);
      // --dpi: Scans ohne Auflösung im JPEG würden sonst als 70 dpi gelesen (falsche Seitengröße)
      await run(TOOLS.tesseract, [files[i], base, '-l', p.langs.join('+'), '--dpi', String(dpi), 'pdf', 'txt'], {
        timeoutMs: Math.min(opts.pageTimeoutMs || PAGE_TIMEOUT_MS, left), signal: opts.signal || null,
      });
      pdfs.push(base + '.pdf');
      try {
        const t = fs.readFileSync(base + '.txt', 'utf8');
        if (text.length < MAX_TEXT) text += (text ? '\n\n' : '') + t.replace(/\f/g, '').trim();
      } catch (_e) { /* kein Text auf der Seite */ }
      fs.rmSync(base + '.txt', { force: true });
      if (typeof opts.onPage === 'function') await opts.onPage(i + 1);
    }
    const out = path.join(dir, 'ocr.pdf');
    if (pdfs.length === 1) fs.renameSync(pdfs[0], out);
    else {
      const left = until - Date.now();
      if (left <= 0) throw new OcrError('ocr_timeout', 'job timeout');
      await run(TOOLS.pdfunite, [...pdfs, out], { timeoutMs: Math.min(120_000, left), signal: opts.signal || null });
    }
    return { pdf: out, text: text.slice(0, MAX_TEXT), pages: files.length };
  } finally {
    for (const f of pdfs) fs.rmSync(f, { force: true });
  }
}

module.exports = { recognize, available, probe, OcrError, LANGS, PAGE_TIMEOUT_MS, TOTAL_TIMEOUT_MS, _tools: TOOLS, _reset() { checked = null; } };
