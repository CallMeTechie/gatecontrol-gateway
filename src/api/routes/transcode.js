'use strict';

// Management-API „Videos umwandeln“ (docs/transcode.md §3), über den Tunnel mit
// X-Gateway-Token (server.js). Alles JSON.
//   POST /api/transcode/status  {}                          – frischer Zustand (Dienst, Fähigkeiten, Ordner, Aufträge, Papierkorb)
//   POST /api/transcode/probe   { path }                    – ffprobe-Befund einer Datei
//   POST /api/transcode/submit  { id, path, software?, quality? } – Auftrag in die Warteschlange (202)
//   POST /api/transcode/cancel  { id }
//   POST /api/transcode/pause   { id } | { ttlSec? }        – einen Auftrag bzw. alles anhalten („jemand schaut“)
//   POST /api/transcode/resume  { id } | {}
//   POST /api/transcode/ack     { ids }                     – erledigte Aufträge vergessen
//   POST /api/transcode/restore { id }                      – Original aus dem Papierkorb zurück
//   POST /api/transcode/purge   { id } | { all: true }      – Original(e) endgültig löschen

const express = require('express');
const { rateLimit } = require('express-rate-limit');

function fail(res, e) {
  const code = e && typeof e.code === 'string' && /^[a-z_]{1,32}$/.test(e.code) ? e.code : 'error';
  const status = e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (!res.headersSent) res.status(status).json({ error: code });
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { fail(res, e); }
};

// Alle Abrufe kommen vom Server (ein Topf): reicht für Listen mit vielen Dateien, bremst einen Server, der durchdreht.
const LIMIT = { windowMs: 60_000, limit: 600 };

function createTranscodeRouter({ featureMgr, limit = LIMIT }) {
  const router = express.Router();
  router.use('/transcode', rateLimit({ ...limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'rate_limited' } }));
  const svc = () => {
    const t = featureMgr.transcode;
    if (!t || !t.cfg || !t.cfg.enabled) throw Object.assign(new Error('off'), { code: 'feature_disabled', status: 503 });
    return t;
  };
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  const json = (res, status, data) => res.status(status).set('Cache-Control', 'no-store').json(data);

  router.post('/transcode/status', wrap(async (req, res) => { json(res, 200, svc().status()); }));
  router.post('/transcode/probe', wrap(async (req, res) => { json(res, 200, await svc().probe(body(req).path)); }));
  router.post('/transcode/submit', wrap(async (req, res) => { json(res, 202, { job: svc().submit(body(req)) }); }));
  router.post('/transcode/cancel', wrap(async (req, res) => { json(res, 200, { job: svc().cancel(body(req).id) }); }));
  router.post('/transcode/pause', wrap(async (req, res) => { json(res, 200, { pause: svc().pause(body(req)) }); }));
  router.post('/transcode/resume', wrap(async (req, res) => { json(res, 200, { pause: svc().resume(body(req)) }); }));
  router.post('/transcode/ack', wrap(async (req, res) => { json(res, 200, { removed: svc().ack(body(req).ids) }); }));
  router.post('/transcode/restore', wrap(async (req, res) => { json(res, 200, await svc().restore(body(req).id)); }));
  router.post('/transcode/purge', wrap(async (req, res) => { json(res, 200, await svc().purge(body(req))); }));
  return router;
}

module.exports = { createTranscodeRouter };
