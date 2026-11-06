'use strict';

const express = require('express');
const { normalizeMac } = require('../../features/macs');

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
    if (r === 'not_running' || r === 'key_needed') return res.status(409).json({ error: r });
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
  return router;
}

module.exports = { createFeaturesRouter };
