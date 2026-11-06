'use strict';

// Funk-Hardware erkennen (Phase 3c, Schritt 2 – docs/radio.md). Liest nur
// sysfs: USB-Sticks (/sys/class/tty/<tty>/device → USB-Gerät mit idVendor,
// idProduct, manufacturer, product) und Bluetooth-Adapter
// (/sys/class/bluetooth/hci*). sysfs ist im Container lesbar – dafür braucht
// es keine Compose-Änderung und kein /dev. Das Pi-Image meldet einen RaspBee
// auf der GPIO-Leiste zusätzlich in /state/hardware.json (gatecontrol-hwdetect).
// Alles hier ist Eingabe von außen: Namen gekürzt, Muster streng.

const fs = require('node:fs');
const path = require('node:path');

const TTY_RE = /^tty(ACM|USB|AMA)[0-9]{1,3}$/;
const DEV_RE = /^([0-9]{1,3}):([0-9]{1,7})$/;
const HCI_RE = /^hci[0-9]{1,2}$/;
// Major-Nummern, die der deCONZ-Dienst öffnen darf (device_cgroup_rules der Compose-Datei)
const MAJORS = Object.freeze({ ttyACM: 166, ttyUSB: 188, ttyAMA: 204 });
const MAX_STICKS = 8;

/**
 * Bekannte Funksticks. kind: zigbee | thread | multi (Zigbee oder Thread, je nach Firmware).
 * deconz: nur Funkmodule von dresden elektronik spricht deCONZ; baud wie deCONZ sie erwartet.
 */
const KNOWN = [
  { vid: '1cf1', pid: '0030', model: 'ConBee II', kind: 'zigbee', deconz: true, baud: 115200 },
  { vid: '0403', pid: '6015', product: /conbee\s*iii/i, model: 'ConBee III', kind: 'zigbee', deconz: true, baud: 115200 },
  { vid: '0403', pid: '6015', product: /conbee/i, model: 'ConBee', kind: 'zigbee', deconz: true, baud: 38400 },
  { vid: '10c4', pid: 'ea60', product: /skyconnect/i, model: 'Home Assistant SkyConnect', kind: 'multi', deconz: false },
  { vid: '10c4', pid: 'ea60', product: /zbt-1/i, model: 'Home Assistant Connect ZBT-1', kind: 'multi', deconz: false },
  { product: /zbt-2/i, manufacturer: /nabu\s*casa/i, model: 'Home Assistant Connect ZBT-2', kind: 'multi', deconz: false },
  { vid: '1a86', pid: '55d4', product: /dongle plus v2|zbdongle-e/i, model: 'Sonoff ZBDongle-E', kind: 'multi', deconz: false },
  { vid: '10c4', pid: 'ea60', product: /sonoff.*dongle plus|zbdongle-p/i, model: 'Sonoff ZBDongle-P', kind: 'zigbee', deconz: false },
  { vid: '1915', product: /openthread/i, model: 'nRF52840 (OpenThread)', kind: 'thread', deconz: false },
  // sonst jedes Funkmodul von dresden elektronik (deCONZ erkennt den Typ an der Firmware)
  { manufacturer: /dresden.?elektronik/i, model: 'ConBee', kind: 'zigbee', deconz: true, baud: 115200 },
];

/** Text aus sysfs: ohne Steuerzeichen, getrimmt, höchstens n Zeichen. */
function clean(v, n = 64) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    out += c < 32 || c === 127 ? ' ' : ch;
  }
  return out.trim().replace(/\s+/g, ' ').slice(0, n);
}

function readAttr(dir, name, n = 64) {
  try { return clean(fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 256), n); } catch { return ''; }
}

function classify({ vid, pid, manufacturer, product }) {
  for (const k of KNOWN) {
    if (k.vid && k.vid !== vid) continue;
    if (k.pid && k.pid !== pid) continue;
    if (k.product && !k.product.test(product || '')) continue;
    if (k.manufacturer && !k.manufacturer.test(manufacturer || '')) continue;
    return k;
  }
  return null;
}

/** Das USB-Gerät (Ordner mit idVendor) über einem sysfs-Pfad, höchstens 8 Ebenen hoch. */
function usbDeviceOf(devPath) {
  let p = devPath;
  for (let i = 0; i < 8 && p && p !== path.dirname(p); i++) {
    if (fs.existsSync(path.join(p, 'idVendor'))) return p;
    p = path.dirname(p);
  }
  return null;
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** major:minor einer tty → { major, minor } oder null (nur die Major-Nummern der Funksticks). */
function devNumbers(sys, tty) {
  const m = DEV_RE.exec(readAttr(path.join(sys, 'class', 'tty', tty), 'dev', 16));
  if (!m) return null;
  const major = Number(m[1]);
  const prefix = tty.replace(/[0-9]+$/, '');
  if (MAJORS[prefix] !== major) return null;
  return { major, minor: Number(m[2]) };
}

/** USB-Funksticks: [{ id, kind, model, bus: 'usb', tty, dev, deconz, baud, vid, pid }]. */
function usbSticks(sys) {
  const ttyDir = path.join(sys, 'class', 'tty');
  let names = [];
  try { names = fs.readdirSync(ttyDir).filter((n) => TTY_RE.test(n) && !n.startsWith('ttyAMA')).sort(); } catch { return []; }
  const out = [];
  for (const tty of names) {
    const dev = realpath(path.join(ttyDir, tty, 'device'));
    const usb = dev && usbDeviceOf(dev);
    if (!usb) continue;
    const info = {
      vid: readAttr(usb, 'idVendor', 4).toLowerCase(),
      pid: readAttr(usb, 'idProduct', 4).toLowerCase(),
      manufacturer: readAttr(usb, 'manufacturer'),
      product: readAttr(usb, 'product'),
    };
    const k = classify(info);
    if (!k) continue;
    const numbers = devNumbers(sys, tty);
    out.push({
      id: 'usb:' + clean(path.basename(usb), 32),
      kind: k.kind,
      model: k.model,
      product: info.product || null,
      bus: 'usb',
      tty,
      dev: numbers ? `${numbers.major}:${numbers.minor}` : null,
      deconz: k.deconz === true,
      baud: k.baud || null,
      vid: info.vid,
      pid: info.pid,
    });
    if (out.length >= MAX_STICKS) break;
  }
  return out;
}

/** RaspBee aus /state/hardware.json (gatecontrol-hwdetect hat ihn per deCONZ-Protokoll erkannt). */
function hostZigbee(sys, hostProfile) {
  const radios = hostProfile && Array.isArray(hostProfile.radios) ? hostProfile.radios : [];
  // erkannt, oder mit ZIGBEE=on erzwungen (Modul antwortet z. B. mit alter Firmware nicht)
  const r = radios.find((x) => x && x.kind === 'zigbee' && (x.detected === true || x.enabled === true) && typeof x.device === 'string');
  if (!r) return null;
  const tty = path.basename(r.device);
  if (!/^ttyAMA[0-9]{1,3}$/.test(tty)) return null; // USB-Sticks kommen aus sysfs
  const numbers = devNumbers(sys, tty);
  const type = clean(r.type || '', 32);
  return {
    id: 'uart:' + tty,
    kind: 'zigbee',
    model: /raspbee2|conbee2/.test(type) ? 'RaspBee II' : 'RaspBee',
    product: null,
    bus: 'uart',
    tty,
    dev: numbers ? `${numbers.major}:${numbers.minor}` : null,
    deconz: true,
    baud: 38400,
    firmware: typeof r.firmware === 'string' && /^0x[0-9a-f]{8}$/i.test(r.firmware) ? r.firmware.toLowerCase() : null,
  };
}

/** Bluetooth-Adapter: [{ name: 'hci0', bus: 'usb'|'builtin', model }]. */
function bluetoothAdapters(sys) {
  const dir = path.join(sys, 'class', 'bluetooth');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => HCI_RE.test(n)).sort(); } catch { return []; }
  return names.slice(0, 4).map((name) => {
    const dev = realpath(path.join(dir, name, 'device')) || realpath(path.join(dir, name)) || '';
    const usb = /\/usb[0-9]/.test(dev) ? usbDeviceOf(dev) : null;
    return { name, bus: usb ? 'usb' : 'builtin', model: usb ? (readAttr(usb, 'product') || null) : null };
  });
}

/**
 * Alles, was das Gateway an Funk sieht.
 * @param {{ sysRoot?: string, hostProfile?: object|null }} o
 * @returns {{ sticks: object[], bluetooth: object[] }}
 */
function detect({ sysRoot = '/sys', hostProfile = null } = {}) {
  const sticks = usbSticks(sysRoot);
  const host = hostZigbee(sysRoot, hostProfile);
  if (host && !sticks.some((s) => s.tty === host.tty)) sticks.unshift(host);
  return { sticks: sticks.slice(0, MAX_STICKS), bluetooth: bluetoothAdapters(sysRoot) };
}

module.exports = { detect, classify, clean, KNOWN, MAJORS, TTY_RE };
