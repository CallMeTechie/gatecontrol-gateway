'use strict';

const express = require('express');
const { normalizeMac } = require('../../features/macs');
const { parseChat } = require('../../ai/ai');

// nur diese Route bekommt einen großen Body (Mails, Dokumente); alle anderen bleiben bei 16 KB (server.js)
const AI_CHAT_PATH = '/api/ai/chat';
const AI_CHAT_LIMIT = '2mb';
const AI_WAIT_MS = 10_000;
const AI_FLUSH_MS = 250;
const AI_ANSWER_MAX = 256 * 1024;

// Management-Aufrufe des Servers (über den Tunnel, X-Gateway-Token):
//   POST /api/netwatch/scan     { ports?: true }  – „Jetzt scannen“ (Phase 3a)
//   POST /api/inetq/speedtest   {}                – „Jetzt messen“ (Phase 3a)
//   GET  /api/dns/log?limit&mac                   – Einzelprotokoll (nur mit logQueries)
//   POST /api/dns/test          { domain, mac? }  – Was würde passieren?
//   POST /api/cache/sync        {}                – Vorrat jetzt abgleichen
//   POST /api/cache/clear       {}                – Zwischenspeicher leeren
//   POST /api/print/discover    { retrust? }      – Drucker/Scanner neu suchen (Phase 3c); retrust: geändertes Zertifikat bestätigen
//   POST /api/print/jobs        {}                – Druckaufträge jetzt abholen
//   POST /api/print/scan        { scanId, deviceId, source, color, resolution, format, duplex }
//   POST /api/print/scan/cancel { scanId }
//   POST /api/radio/status      {}                – Funk: frischer Zustand + Bluetooth-Sensoren (Phase 3c, Schritt 2)
//   POST /api/radio/zigbee/pair { seconds? }      – Zigbee-Geräte anlernen (60…254 s, Standard 180)
//   POST /api/radio/zigbee/unlock {}              – deCONZ 60 s für neue Schlüssel öffnen (Smart Home)
//   POST /api/radio/zigbee/retry {}               – deCONZ-Schlüssel neu holen
//   POST /api/radio/zigbee/remove { ieee }        – zigbee2mqtt: Gerät aus dem Netz entfernen
//   POST /api/radio/zigbee/set  { ieee, set }     – zigbee2mqtt: Gerät schalten (Smart Home)
//   POST /api/radio/thread/form { name? }         – Thread: neues Netz anlegen
//   POST /api/radio/thread/join { dataset }       – Thread: Datensatz (TLV-Hex) übernehmen – nie ins Log
//   POST /api/radio/thread/dataset {}             – Thread: aktiver Datensatz (TLV-Hex) für Matter-Controller
//   POST /api/ai/status         {}                – Lokale KI: frischer Zustand (Phase 3c, Schritt 3, docs/local-ai.md)
//   POST /api/ai/pull           { model }         – Modell herunterladen (Fortschritt über /api/ai/status)
//   POST /api/ai/pull/cancel    {}                – Download abbrechen
//   POST /api/ai/delete         { model }         – Modell löschen
//   POST /api/ai/chat           { model, system, messages, … } – Antwort als NDJSON-Strom (Body ≤ 2 MB)
// Aufträge antworten sofort (202); das Ergebnis kommt über die normalen Berichte.
function reply(res, outcome, busyError) {
  if (outcome === 'accepted') return res.status(202).json({ accepted: true });
  if (outcome === 'busy') return res.status(409).json({ error: busyError });
  return res.status(503).json({ error: 'feature_disabled' });
}

function createFeaturesRouter({ featureMgr }) {
  const router = express.Router();
  router.post('/netwatch/scan', (req, res) => {
    const ports = req.body && req.body.ports === true;
    reply(res, featureMgr.netwatch.requestScan({ ports }), 'scan_in_progress');
  });
  router.post('/inetq/speedtest', (req, res) => {
    reply(res, featureMgr.inetq.requestSpeedtest(), 'speedtest_running');
  });

  const dnsOn = () => !!(featureMgr.dns && featureMgr.dns.cfg && featureMgr.dns.cfg.enabled);
  router.get('/dns/log', (req, res) => {
    if (!dnsOn()) return res.status(503).json({ error: 'feature_disabled' });
    if (featureMgr.dns.cfg.logQueries !== true) return res.status(403).json({ error: 'log_disabled' });
    const limit = /^[0-9]{1,4}$/.test(String(req.query.limit || '')) ? Number(req.query.limit) : 100;
    const mac = typeof req.query.mac === 'string' && req.query.mac ? req.query.mac : null;
    if (mac && !normalizeMac(mac)) return res.status(400).json({ error: 'invalid_mac' });
    return res.json({ entries: featureMgr.dns.queryLog({ limit, mac }) });
  });
  router.post('/dns/test', (req, res) => {
    if (!dnsOn()) return res.status(503).json({ error: 'feature_disabled' });
    const b = req.body || {};
    if (typeof b.domain !== 'string') return res.status(400).json({ error: 'invalid_domain' });
    const r = featureMgr.dns.test(b.domain, b.mac);
    if (r.error) return res.status(400).json(r);
    return res.json(r);
  });

  router.post('/cache/sync', (req, res) => {
    reply(res, featureMgr.cache.requestSync ? featureMgr.cache.requestSync() : 'disabled', 'sync_running');
  });
  router.post('/cache/clear', async (req, res) => {
    reply(res, featureMgr.cache.clear ? await featureMgr.cache.clear() : 'disabled', 'busy');
  });

  // Phase 3c: Drucken & Scannen (src/print/print.js)
  const print = () => featureMgr.print || {};
  router.post('/print/discover', (req, res) => {
    const retrust = req.body && typeof req.body.retrust === 'string' ? req.body.retrust : null;
    reply(res, print().requestSearch ? print().requestSearch({ retrust }) : 'disabled', 'search_running');
  });
  router.post('/print/jobs', (req, res) => {
    reply(res, print().requestJobs ? print().requestJobs() : 'disabled', 'busy');
  });
  router.post('/print/scan', (req, res) => {
    const r = print().requestScan ? print().requestScan(req.body || {}) : 'disabled';
    if (r === 'invalid') return res.status(400).json({ error: 'invalid_request' });
    if (r === 'unknown_device') return res.status(404).json({ error: 'unknown_device' });
    return reply(res, r, 'scanner_busy');
  });
  router.post('/print/scan/cancel', (req, res) => {
    const id = req.body && typeof req.body.scanId === 'string' ? req.body.scanId : '';
    reply(res, print().cancelScan ? print().cancelScan(id) : 'disabled', 'busy');
  });

  // Phase 3c, Schritt 2: Funk (src/radio/radio.js)
  const radio = () => featureMgr.radio || {};
  router.post('/radio/status', async (req, res) => {
    const r = radio().status ? await radio().status() : null;
    if (!r) return res.status(503).json({ error: 'feature_disabled' });
    return res.json({ radio: r });
  });
  const zigbeeReply = (res, r) => {
    if (r === 'accepted') return res.status(202).json({ accepted: true });
    if (r === 'not_running' || r === 'key_needed' || r === 'has_network') return res.status(409).json({ error: r });
    if (r === 'not_found') return res.status(404).json({ error: r });
    if (r === 'invalid') return res.status(400).json({ error: 'invalid_request' });
    if (r === 'failed') return res.status(502).json({ error: 'deconz_failed' });
    return res.status(503).json({ error: 'feature_disabled' });
  };
  router.post('/radio/zigbee/pair', async (req, res) => {
    const s = req.body && req.body.seconds;
    if (s !== undefined && !(Number.isInteger(s) && s >= 60 && s <= 254)) return res.status(400).json({ error: 'invalid_request' });
    zigbeeReply(res, radio().requestPair ? await radio().requestPair({ seconds: s }) : 'disabled');
  });
  router.post('/radio/zigbee/unlock', async (req, res) => {
    zigbeeReply(res, radio().requestUnlock ? await radio().requestUnlock() : 'disabled');
  });
  router.post('/radio/zigbee/retry', async (req, res) => {
    zigbeeReply(res, radio().requestRetry ? await radio().requestRetry() : 'disabled');
  });
  const IEEE_RE = /^(0x[0-9a-f]{16}|([0-9a-f]{2}:){7}[0-9a-f]{2})$/;
  router.post('/radio/zigbee/remove', async (req, res) => {
    const ieee = req.body && typeof req.body.ieee === 'string' ? req.body.ieee.toLowerCase() : '';
    if (!IEEE_RE.test(ieee)) return res.status(400).json({ error: 'invalid_request' });
    zigbeeReply(res, radio().requestRemove ? await radio().requestRemove({ ieee }) : 'disabled');
  });
  router.post('/radio/zigbee/set', async (req, res) => {
    const b = req.body || {};
    const ieee = typeof b.ieee === 'string' ? b.ieee.toLowerCase() : '';
    if (!IEEE_RE.test(ieee) || !b.set || typeof b.set !== 'object' || Array.isArray(b.set)) return res.status(400).json({ error: 'invalid_request' });
    zigbeeReply(res, radio().requestSet ? await radio().requestSet({ ieee, set: b.set }) : 'disabled');
  });
  router.post('/radio/thread/form', async (req, res) => {
    const name = req.body && req.body.name;
    if (name !== undefined && name !== null && !(typeof name === 'string' && /^[A-Za-z0-9 ._-]{1,16}$/.test(name.trim()))) return res.status(400).json({ error: 'invalid_request' });
    zigbeeReply(res, radio().requestThreadForm ? await radio().requestThreadForm({ name: name || null }) : 'disabled');
  });
  router.post('/radio/thread/join', async (req, res) => {
    const ds = req.body && typeof req.body.dataset === 'string' ? req.body.dataset.trim() : '';
    if (!/^[0-9a-fA-F]{20,508}$/.test(ds)) return res.status(400).json({ error: 'invalid_request' });
    zigbeeReply(res, radio().requestThreadJoin ? await radio().requestThreadJoin({ dataset: ds }) : 'disabled');
  });
  router.post('/radio/thread/dataset', async (req, res) => {
    const r = radio().requestThreadDataset ? await radio().requestThreadDataset() : { outcome: 'disabled' };
    res.set('Cache-Control', 'no-store');
    if (r.outcome === 'ok') return res.json({ dataset: r.tlv });
    if (r.outcome === 'not_running' || r.outcome === 'no_network') return res.status(409).json({ error: r.outcome });
    if (r.outcome === 'failed') return res.status(502).json({ error: 'otbr_failed' });
    return res.status(503).json({ error: 'feature_disabled' });
  });

  // Phase 3c, Schritt 3: Lokale KI (src/ai/ai.js)
  const ai = () => featureMgr.ai || {};
  const aiReply = (res, r) => {
    if (r === 'accepted') return res.status(202).json({ accepted: true });
    if (r === 'invalid_model') return res.status(400).json({ error: r });
    if (r === 'not_found') return res.status(404).json({ error: r });
    if (r === 'not_running' || r === 'pull_running' || r === 'lan_source' || r === 'no_pull') return res.status(409).json({ error: r });
    if (r === 'failed') return res.status(502).json({ error: 'ai_failed' });
    return res.status(503).json({ error: 'feature_disabled' });
  };
  router.post('/ai/status', async (req, res) => {
    if (!ai().status || !ai().cfg || !ai().cfg.enabled) return res.status(503).json({ error: 'feature_disabled' });
    return res.json({ ai: await ai().status() });
  });
  router.post('/ai/pull', (req, res) => {
    aiReply(res, ai().requestPull ? ai().requestPull(req.body && req.body.model) : 'disabled');
  });
  router.post('/ai/pull/cancel', (req, res) => {
    aiReply(res, ai().cancelPull ? ai().cancelPull() : 'disabled');
  });
  router.post('/ai/delete', async (req, res) => {
    const r = ai().removeModel ? await ai().removeModel(req.body && req.body.model) : 'disabled';
    if (r === 'deleted') return res.json({ deleted: true });
    return aiReply(res, r);
  });
  router.post('/ai/chat', express.json({ limit: AI_CHAT_LIMIT }), async (req, res) => {
    const svc = ai();
    if (!svc.chat) return res.status(503).json({ error: 'feature_disabled' });
    const q = parseChat(req.body);
    if (!q) return res.status(400).json({ error: 'invalid_request' });
    const why = svc.canChat();
    if (why === 'busy') return res.status(429).json({ error: 'busy' });
    if (why === 'not_running') return res.status(409).json({ error: 'not_running' });
    if (why) return res.status(503).json({ error: 'feature_disabled' });
    // ab hier der Strom: eine JSON-Zeile je Ereignis (docs/local-ai.md §3)
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const write = (o) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n'); };
    const started = Date.now();
    let pending = '';
    let size = 0;
    let gotText = false;
    let flushTimer = null;
    const flush = () => { flushTimer = null; if (pending) { write({ d: pending }); pending = ''; } };
    const wait = setInterval(() => { if (!gotText) write({ wait: 1 }); }, AI_WAIT_MS);
    try {
      const r = await svc.chat(q, {
        signal: ctrl.signal,
        onDelta: (piece) => {
          size += Buffer.byteLength(piece);
          if (size > AI_ANSWER_MAX) throw Object.assign(new Error('answer too large'), { code: 'too_large' });
          gotText = true;
          pending += piece;
          if (!flushTimer) flushTimer = setTimeout(flush, AI_FLUSH_MS);
        },
      });
      clearTimeout(flushTimer);
      flush();
      write({ done: true, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, finish: r.finish, ms: Date.now() - started });
    } catch (e) {
      clearTimeout(flushTimer);
      const code = e && typeof e.code === 'string' && /^[a-z0-9_]{1,32}$/.test(e.code) ? e.code : 'error';
      write({ error: code, message: String((e && e.message) || code).slice(0, 200) });
    } finally {
      clearInterval(wait);
      if (!res.writableEnded) res.end();
    }
  });
  return router;
}

module.exports = { createFeaturesRouter, AI_CHAT_PATH };
