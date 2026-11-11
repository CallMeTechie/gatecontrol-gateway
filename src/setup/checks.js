'use strict';

// Selbstprüfungen der Einrichtungsseite (docs/setup-page.md): Internet
// erreichbar, Uhrzeit plausibel, VPN-Gerät vorhanden, Ordner config
// beschreibbar. Jede Prüfung ist einzeln ersetzbar (Tests) und hat eine feste
// Zeitgrenze; das Ergebnis enthält nur feste Kennungen, keinen freien Text.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// Öffentliche Resolver mit Zertifikat auf die IP-Adresse – dieselben Ziele wie
// die Internetqualität (src/features/config.js), also keine neue Gegenstelle.
const PROBE_HOSTS = ['1.1.1.1', '9.9.9.9'];
const PROBE_TIMEOUT_MS = 5_000;
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const CLOCK_ERRORS = new Set(['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED']);
const PROBE_LINK = 'gcprobe0';

/** HEAD https://<ip>/ → { reachable, date, clockError }. Es wird nichts gesendet außer der Anfrage selbst. */
function probeHttps(host, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const req = https.request({ host, port: 443, method: 'HEAD', path: '/', agent: false, timeout: timeoutMs }, (res) => {
      const date = Date.parse(res.headers.date || '');
      res.resume();
      finish({ reachable: true, date: Number.isFinite(date) ? date : null, clockError: false });
    });
    req.on('timeout', () => { req.destroy(); finish({ reachable: false, date: null, clockError: false }); });
    // Ein Zertifikat „noch nicht gültig“/„abgelaufen“ heißt: Gegenstelle da, eigene Uhr falsch.
    req.on('error', (err) => finish({ reachable: CLOCK_ERRORS.has(err.code), date: null, clockError: CLOCK_ERRORS.has(err.code) }));
    req.end();
  });
}

/** Internet + Uhrzeit in einem: erste erreichbare Gegenstelle zählt. */
async function checkInternetAndClock({ probe = probeHttps, hosts = PROBE_HOSTS, now = Date.now, floor = buildTime() } = {}) {
  let reachable = false;
  let clock = null;
  for (const h of hosts) {
    const r = await probe(h);
    if (!r.reachable) continue;
    reachable = true;
    if (r.clockError) clock = false;
    else if (r.date !== null) clock = Math.abs(now() - r.date) <= MAX_CLOCK_SKEW_MS;
    break;
  }
  // Ohne Vergleichswert: eine Uhr vor dem Bau des Programms geht sicher falsch.
  if (clock === null) clock = floor ? now() >= floor : null;
  if (clock === true && floor && now() < floor) clock = false;
  return { internet: reachable, clock: reachable || clock === false ? clock : null };
}

/** Zeitpunkt, zu dem dieses Programm gebaut wurde (mtime der package.json), als untere Grenze der Uhr. */
function buildTime() {
  try { return fs.statSync(path.join(__dirname, '..', '..', 'package.json')).mtimeMs; } catch { return 0; }
}

function run(cmd, args, timeoutMs = 4_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => resolve(!err));
  });
}

let kernelWgKnown = false;

/**
 * Kann der Kernel WireGuard selbst (dann braucht es kein /dev/net/tun)?
 * Probe: eine WireGuard-Schnittstelle anlegen und sofort wieder entfernen.
 */
async function kernelWireguard({ exec = run } = {}) {
  if (kernelWgKnown) return true;
  if (!(await exec('ip', ['link', 'add', PROBE_LINK, 'type', 'wireguard']))) return false;
  await exec('ip', ['link', 'del', PROBE_LINK]);
  kernelWgKnown = true;
  return true;
}

/**
 * /dev/net/tun benutzbar? Öffnen ohne ioctl ändert nichts; ENOENT heißt: das
 * Gerät ist nicht in den Container eingebunden, ENODEV: Modul `tun` nicht
 * geladen. Angelegt oder verändert wird hier nichts.
 */
async function tunUsable({ dev = '/dev/net/tun', fsImpl = fs } = {}) {
  try { fsImpl.closeSync(fsImpl.openSync(dev, 'r+')); return true; } catch { return false; }
}

/** VPN-Gerät: Kernel-WireGuard oder /dev/net/tun für wireguard-go. */
async function checkVpnDevice(deps = {}) {
  const kernel = deps.kernelWireguard || kernelWireguard;
  const tun = deps.tunUsable || tunUsable;
  if (await tun()) return { ok: true, via: 'tun' };
  if (await kernel()) return { ok: true, via: 'kernel' };
  return { ok: false, via: null };
}

/** Ordner der gateway.env beschreibbar? Echte Schreibprobe (ein `:ro`-Mount lässt sich nur so sicher erkennen). */
function checkConfigWritable(dir, { fsImpl = fs } = {}) {
  const probe = path.join(dir, `.gc-write-test-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fsImpl.writeFileSync(probe, '', { mode: 0o600, flag: 'wx' });
    fsImpl.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Alle Prüfungen mit Zwischenspeicher: höchstens alle `ttlMs` neu (knapp unter
 * den 10 s, in denen die Seite nachfragt – so ist jede Abfrage frisch), und
 * nur wenn jemand die Seite ansieht (kein Hintergrundverkehr).
 */
function createChecks({ configDir, ttlMs = 8_000, minForceMs = 2_000, deps = {}, now = Date.now } = {}) {
  let last = null;
  let at = 0;
  let running = null;

  async function runAll() {
    const [net, vpn] = await Promise.all([
      (deps.internetAndClock || checkInternetAndClock)(),
      (deps.vpnDevice || checkVpnDevice)(),
    ]);
    const config = (deps.configWritable || checkConfigWritable)(configDir);
    return {
      internet: net.internet === true,
      clock: net.clock,
      tun: vpn.ok === true,
      config: config === true,
    };
  }

  async function get({ force = false } = {}) {
    // „Erneut prüfen“ höchstens alle paar Sekunden wirklich neu (kein Dauerfeuer aus dem Heimnetz)
    if (last && now() - at < (force ? minForceMs : ttlMs)) return last;
    if (!running) {
      running = runAll()
        .then((r) => { last = r; at = now(); return r; })
        .finally(() => { running = null; });
    }
    return running;
  }

  return { get, peek: () => last };
}

/** Alles da, um zu verbinden? Eine unbekannte Uhrzeit (kein Vergleichswert) blockiert nicht. */
function ready(c) {
  return !!c && c.internet && c.clock !== false && c.tun && c.config;
}

module.exports = {
  createChecks, ready, checkInternetAndClock, checkVpnDevice, checkConfigWritable, tunUsable, kernelWireguard, probeHttps,
  MAX_CLOCK_SKEW_MS,
};
