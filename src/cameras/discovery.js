'use strict';

// Kameras im LAN finden: WS-Discovery (ONVIF), Probe nach
// 239.255.255.250:3702 mit Typ dn:NetworkVideoTransmitter.
//
// Je eigener LAN-Adresse ein UDP-Socket, gebunden an 0.0.0.0 (zufälliger
// Port) – NIE an die Unicast-Adresse: unter Linux bekommt ein an eine
// Unicast-Adresse gebundener Socket keine Multicast-Pakete. Die LAN-Adresse
// wählt nur die Schnittstelle (setMulticastInterface) und die Mitgliedschaft
// in der Gruppe. ProbeMatches kommen per Unicast an unseren Port, manche
// Kameras schicken sie per Multicast – beides kommt an. Angenommen werden nur
// Antworten von Adressen in eigenen Netzen (hostAllowed).

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const xml = require('./xml');
const { uriParts } = require('./onvif');
const { cleanText } = require('../print/config');
const logger = require('../logger');

const GROUP = '239.255.255.250';
const PORT = 3702;
const MAX_PACKET = 64 * 1024;
const MAX_FOUND = 64;

function probeMessage(id = crypto.randomUUID()) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
    + 'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
    + `<e:Header><w:MessageID>uuid:${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>`
    + '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>'
    + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
}

/** onvif://www.onvif.org/name/Reolink%20E1 → { name, hardware } */
function scopesOf(text) {
  const out = { name: null, hardware: null, manufacturer: null };
  for (const s of String(text || '').split(/\s+/).slice(0, 64)) {
    const m = /^onvif:\/\/www\.onvif\.org\/(name|hardware|mfr|manufacturer)\/(.+)$/i.exec(s);
    if (!m) continue;
    let v;
    try { v = decodeURIComponent(m[2]); } catch { v = m[2]; }
    v = cleanText(v.replace(/_/g, ' '), 48);
    const k = m[1].toLowerCase();
    if (k === 'name' && !out.name) out.name = v;
    else if (k === 'hardware' && !out.hardware) out.hardware = v;
    else if ((k === 'mfr' || k === 'manufacturer') && !out.manufacturer) out.manufacturer = v;
  }
  return out;
}

/** Ein ProbeMatches-Paket von `ip` → [{ host, port, path, name, hardware, manufacturer }] */
function parseMatches(buf, ip) {
  let root;
  try { root = xml.parse(buf.toString('utf8')); } catch { return []; }
  const out = [];
  for (const pm of xml.findAll(root, 'ProbeMatch', 8)) {
    const types = xml.textOf(pm, 'Types');
    if (types && !/NetworkVideoTransmitter|Device/i.test(types)) continue;
    let ep = null;
    for (const a of xml.textOf(pm, 'XAddrs').split(/\s+/).filter(Boolean).slice(0, 8)) {
      // nur Adressen der antwortenden Kamera selbst (keine fremden Hosts über XAddrs)
      try { if (new URL(a).hostname !== ip) continue; } catch { continue; }
      ep = uriParts(a, 'xaddr');
      if (ep) break;
    }
    if (!ep) ep = { port: 80, path: '/onvif/device_service' };
    out.push({ host: ip, ...ep, ...scopesOf(xml.textOf(pm, 'Scopes')) });
  }
  return out;
}

/**
 * Eine Suche: Probe auf jeder LAN-Adresse, Antworten `timeoutMs` lang sammeln.
 * subnets: [{ cidr, localIp }] (eigene private Netze), allowed(ip) → boolean.
 * → [{ host, port, path, name, hardware, manufacturer }] (je Adresse einmal)
 */
function discover({ subnets, allowed, timeoutMs = 3000, socketFactory = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }) }) {
  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
      resolve([...found.values()]);
    };
    const msg = Buffer.from(probeMessage(), 'utf8');
    const ips = [...new Set((subnets || []).map((s) => s && s.localIp).filter(Boolean))];
    if (!ips.length) { resolve([]); return; }
    for (const localIp of ips) {
      let sock;
      try { sock = socketFactory(); } catch (e) { logger.debug({ err: e.message }, 'cameras: discovery socket failed'); continue; }
      sockets.push(sock);
      sock.on('error', (e) => { logger.debug({ err: e.message, localIp }, 'cameras: discovery socket error'); });
      sock.on('message', (buf, rinfo) => {
        if (done || !rinfo || buf.length > MAX_PACKET || !allowed(rinfo.address)) return;
        for (const m of parseMatches(buf, rinfo.address)) {
          if (found.size >= MAX_FOUND) break;
          if (!found.has(m.host)) found.set(m.host, m);
        }
      });
      // 0.0.0.0 (nicht localIp!), damit auch per Multicast geschickte Antworten ankommen
      sock.bind({ address: '0.0.0.0', port: 0 }, () => {
        try {
          sock.setMulticastInterface(localIp);
          sock.setMulticastTTL(1);
          try { sock.addMembership(GROUP, localIp); } catch { /* manche Kernel ohne Multicast-Route: Unicast-Antworten kommen trotzdem */ }
          sock.send(msg, PORT, GROUP);
          // eine Wiederholung, UDP geht verloren
          setTimeout(() => { if (!done) { try { sock.send(msg, PORT, GROUP); } catch { /* closed */ } } }, 600).unref();
        } catch (e) { logger.debug({ err: e.message, localIp }, 'cameras: discovery probe failed'); }
      });
    }
    setTimeout(finish, timeoutMs);
  });
}

module.exports = { discover, parseMatches, probeMessage, scopesOf, GROUP, PORT };
