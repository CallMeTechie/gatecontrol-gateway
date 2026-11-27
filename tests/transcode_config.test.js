'use strict';

// features.transcode und die Pfadprüfung des Gateways (src/transcode/config.js, docs/transcode.md §1/§4).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTranscode, normalizeRoots, checkPath } = require('../src/transcode/config');
const { normalizeFeatures } = require('../src/features/config');

describe('features.transcode', () => {
  it('fehlt es (älterer Server): aus, mit den Standardwerten', () => {
    assert.deepEqual(normalizeTranscode(undefined), { enabled: false, roots: [], software: false, trashDays: 14, quality: 23, verifyDecode: true, minFreeGb: 20, minFreePct: 5 });
    assert.deepEqual(normalizeFeatures(undefined).transcode.enabled, false);
    assert.deepEqual(normalizeFeatures({}).transcode.enabled, false);
  });

  it('übernimmt gültige Werte, ersetzt Unsinn durch den Standard', () => {
    const t = normalizeTranscode({ enabled: true, roots: ['/volume2/mediathek'], software: true, trashDays: 30, quality: 20, verifyDecode: false, minFreeGb: 0, minFreePct: 0, gpu: 'intel' });
    assert.deepEqual(t, { enabled: true, roots: ['/volume2/mediathek'], software: true, trashDays: 30, quality: 20, verifyDecode: false, minFreeGb: 0, minFreePct: 0 });
    const u = normalizeTranscode({ enabled: 'yes', software: 1, trashDays: 0, quality: 99, minFreeGb: -1, minFreePct: 95, roots: 'x' });
    assert.deepEqual(u, { enabled: false, roots: [], software: false, trashDays: 14, quality: 23, verifyDecode: true, minFreeGb: 20, minFreePct: 5 });
    assert.equal(normalizeFeatures({ transcode: { enabled: true, roots: ['/m'] } }).transcode.enabled, true);
  });

  it('Wurzeln: absolut, normalisiert, ohne „:“, nicht verschachtelt, nie ein Arbeitsordner, höchstens 8', () => {
    assert.deepEqual(normalizeRoots(['/volume2/mediathek', '/volume1/filme']), ['/volume2/mediathek', '/volume1/filme']);
    assert.deepEqual(normalizeRoots(['/', 'relativ', '/a/', '/a//b', '/a/../b', '/a/./b', '/a:b', '/a\nb', 7, null, '/ok/.gc-papierkorb', '/ok/.gc-umwandeln/x']), []);
    assert.deepEqual(normalizeRoots(['/a', '/a/b', '/a']), ['/a']);
    assert.deepEqual(normalizeRoots(['/a/b', '/a']), ['/a/b']);
    assert.deepEqual(normalizeRoots(['/ab', '/a']), ['/ab', '/a']);
    assert.equal(normalizeRoots(Array.from({ length: 12 }, (_, i) => `/m${i}`)).length, 8);
  });
});

describe('Pfadprüfung des Gateways (nur die Schreibweise – die Datei selbst prüft der Dienst)', () => {
  const roots = ['/volume2/mediathek', '/volume1/filme'];
  const ok = (p, kind) => checkPath(p, roots, kind);

  it('nimmt Pfade unter einer Wurzel; umgewandelt wird nur MKV', () => {
    assert.deepEqual(ok('/volume2/mediathek/Serie A/Staffel 1/Folge 01 [10bit].mkv'), { ok: true, path: '/volume2/mediathek/Serie A/Staffel 1/Folge 01 [10bit].mkv', root: '/volume2/mediathek' });
    assert.equal(ok('/volume1/filme/Film (2021)/Film.MKV').ok, true);
    assert.equal(ok('/volume1/filme/Ünïcödé – „Film“.mkv').ok, true);
    assert.deepEqual(ok('/volume1/filme/Film.mp4'), { ok: false, error: 'unsupported_container' });
    assert.equal(ok('/volume1/filme/Film.mp4', 'probe').ok, true);
    assert.deepEqual(ok('/volume1/filme/notiz.txt', 'probe'), { ok: false, error: 'unsupported_type' });
    assert.deepEqual(ok('/volume1/filme/.mkv'), { ok: false, error: 'unsupported_container' });
    assert.deepEqual(ok('/volume1/filme/mkv'), { ok: false, error: 'unsupported_container' });
  });

  it('kein Ausbruch: außerhalb, „..“, doppelte Schrägstriche, Steuerzeichen, Arbeitsordner', () => {
    for (const p of ['/etc/passwd.mkv', '/volume2/mediathekX/a.mkv', '/volume2/a.mkv', '/volume2/mediathek.mkv']) {
      assert.deepEqual(ok(p), { ok: false, error: 'outside_roots' }, p);
    }
    for (const p of ['/volume2/mediathek/../../etc/a.mkv', '/volume2/mediathek/a/../b.mkv', '/volume2/mediathek//a.mkv', '/volume2/mediathek/./a.mkv',
      '/volume2/mediathek/a.mkv/', 'volume2/mediathek/a.mkv', '', '/', '/volume2/mediathek/a\nSOFTWARE=1.mkv', '/volume2/mediathek/a\u0000.mkv', '/volume2/mediathek/a\u007f.mkv',
      '/volume2/mediathek/.gc-papierkorb/2026-11-27/a.mkv', '/volume2/mediathek/x/.gc-umwandeln/a.mkv', null, undefined, 7, {}, ['/volume2/mediathek/a.mkv'],
      `/volume2/mediathek/${'a'.repeat(256)}.mkv`, `/volume2/mediathek/${'ab/'.repeat(1500)}a.mkv`]) {
      assert.deepEqual(ok(p), { ok: false, error: 'bad_path' }, String(p).slice(0, 60));
    }
    assert.deepEqual(checkPath('/a/b.mkv', []), { ok: false, error: 'outside_roots' });
  });
});
