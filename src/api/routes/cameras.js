'use strict';

// Management-API „Kameras“ (Phase 3c, Schritt 4 – docs/cameras.md §3), über
// den Tunnel mit X-Gateway-Token (server.js). Bilder, Ring und Clips gehen
// binär heraus; alles andere als JSON.
//   POST /api/cameras/status | discover | probe | snapshot | live | events/delete
//   GET  /api/cameras/<id>/live/<index.m3u8|init.mp4|s<n>.m4s>
//   GET  /api/cameras/<id>/live.mp4?s=<Sekunden>
//   GET  /api/cameras/events/<eventId>/clip.mp4 (Range) | thumb.jpg

const fs = require('node:fs');
const express = require('express');
const { ID_RE, EVENT_ID_RE } = require('../../cameras/config');
const fmp4 = require('../../cameras/fmp4');

const LIVE_FILE_RE = /^(index\.m3u8|init\.mp4|s[0-9]{1,9}\.m4s)$/;
const TYPES = { m3u8: 'application/vnd.apple.mpegurl', mp4: 'video/mp4', m4s: 'video/iso.segment' };

function fail(res, e) {
  const code = e && typeof e.code === 'string' && /^[a-z_]{1,32}$/.test(e.code) ? e.code : 'error';
  const status = e && Number.isInteger(e.status) ? e.status : (code === 'feature_disabled' ? 503 : 502);
  if (!res.headersSent) res.status(status).json({ error: code });
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { fail(res, e); }
};

/** Range-Kopf → { start, end } | null (ganz) | false (ungültig) */
function range(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h));
  if (!m || (!m[1] && !m[2])) return false;
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] ? (m[2] ? Number(m[2]) : size - 1) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return false;
  return { start, end };
}

function createCamerasRouter({ featureMgr }) {
  const router = express.Router();
  const cams = () => {
    const c = featureMgr.cameras;
    if (!c || !c.cfg || !c.cfg.enabled) throw Object.assign(new Error('off'), { code: 'feature_disabled', status: 503 });
    return c;
  };
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  router.post('/cameras/status', wrap(async (req, res) => { noStore(res).json({ cameras: await cams().status() }); }));
  router.post('/cameras/discover', wrap(async (req, res) => { noStore(res).json({ found: await cams().discover() }); }));
  router.post('/cameras/probe', wrap(async (req, res) => { noStore(res).json(await cams().probe(req.body || {})); }));
  router.post('/cameras/snapshot', wrap(async (req, res) => {
    const b = req.body || {};
    const r = await cams().snapshot(b.id, { maxBytes: b.maxBytes });
    noStore(res).set({ 'Content-Type': 'image/jpeg', 'X-Snapshot-At': new Date(r.at).toISOString() }).send(r.data);
  }));
  router.post('/cameras/live', wrap(async (req, res) => { noStore(res).json(cams().live((req.body || {}).id)); }));
  router.post('/cameras/events/delete', wrap(async (req, res) => { noStore(res).json({ deleted: cams().deleteEvents((req.body || {}).ids) }); }));

  router.get('/cameras/:id/live/:file', wrap(async (req, res) => {
    const { id, file } = req.params;
    if (!ID_RE.test(id) || !LIVE_FILE_RE.test(file)) return res.status(400).json({ error: 'invalid_request' });
    const b = cams().liveFile(id, file);
    return noStore(res).set('Content-Type', TYPES[file.split('.').pop()]).send(b);
  }));

  // fortlaufendes fMP4 (Zeitstempel ab 0) für Browser ohne HLS
  router.get('/cameras/:id/live.mp4', wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid_request' });
    const c = cams();
    const s = /^[0-9]{1,3}$/.test(String(req.query.s || '')) ? Math.min(600, Math.max(10, Number(req.query.s))) : 300;
    c.live(id);
    let init = null;
    for (let i = 0; i < 20 && !init; i++) {
      try { init = c.liveFile(id, 'init.mp4'); } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    if (!init) return res.status(409).json({ error: 'not_ready' });
    const ring = c.ring(id);
    const pl0 = ring.playlist();
    if (!pl0 || !pl0.segments.length) return res.status(409).json({ error: 'not_ready' });
    noStore(res).status(200).set({ 'Content-Type': 'video/mp4', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(init);
    let closed = false;
    res.on('close', () => { closed = true; });
    const until = Date.now() + s * 1000;
    let last = pl0.segments[pl0.segments.length - 2] ? pl0.segments[pl0.segments.length - 2].seq - 1 : pl0.segments[0].seq - 1;
    let base = null;
    const initMtime = ring.mtime('init.mp4');
    while (!closed && Date.now() < until) {
      const pl = ring.playlist();
      if (!pl || ring.mtime('init.mp4') !== initMtime) break;
      for (const seg of pl.segments) {
        if (seg.seq <= last || closed) continue;
        const b = ring.read(seg.name);
        if (!b) continue;
        if (!base) base = fmp4.firstTimes(b);
        res.write(fmp4.rebase(b, base));
        last = seg.seq;
      }
      c.live(id);
      await new Promise((r) => setTimeout(r, 700));
    }
    if (!res.writableEnded) res.end();
    return undefined;
  }));

  router.get('/cameras/events/:eid/:file', wrap(async (req, res) => {
    const { eid, file } = req.params;
    if (!EVENT_ID_RE.test(eid) || !['clip.mp4', 'thumb.jpg'].includes(file)) return res.status(400).json({ error: 'invalid_request' });
    const f = cams().eventFile(eid, file === 'clip.mp4' ? 'clip' : 'thumb');
    if (!f) return res.status(404).json({ error: 'not_found' });
    const type = file === 'clip.mp4' ? 'video/mp4' : 'image/jpeg';
    const r = range(req.headers.range, f.size);
    if (r === false) return res.status(416).set('Content-Range', `bytes */${f.size}`).end();
    res.set({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    const opts = r ? { start: r.start, end: r.end } : {};
    if (r) res.status(206).set({ 'Content-Range': `bytes ${r.start}-${r.end}/${f.size}`, 'Content-Length': String(r.end - r.start + 1) });
    else res.status(200).set('Content-Length', String(f.size));
    const st = fs.createReadStream(f.path, { ...opts, flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
    st.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
    st.pipe(res);
    return undefined;
  }));
  return router;
}

module.exports = { createCamerasRouter, range };
