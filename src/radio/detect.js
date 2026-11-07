'use strict';

// Funk-Hardware erkennen (Phase 3c, Schritt 2 – docs/radio.md). Liest nur
// sysfs: USB-Sticks (/sys/class/tty/<tty>/device → USB-Gerät mit idVendor,
// idProduct, manufacturer, product) und Bluetooth-Adapter
// (/sys/class/bluetooth/hci*). sysfs ist im Container lesbar – dafür braucht
// es keine Compose-Änderung und kein /dev. Das Pi-Image meldet einen RaspBee
// auf der GPIO-Leiste zusätzlich in /state/hardware.json (gatecontrol-hwdetect).
// Alles hier ist Eingabe von außen: Namen gekürzt, Muster streng.
//
// Jeder Stick bekommt eine feste Kennung (`id`), an der GateControl die Wahl
// „von Hand festlegen“ (features.radio.sticks) festmacht – nie die ttyACM-Nummer,
// die nach jedem Umstecken eine andere sein kann:
//   Stick mit Seriennummer → sein Name in /dev/serial/by-id
//     (usb-<Hersteller>_<Produkt>_<Seriennummer>-if00[-port0]; liegt /dev/serial/by-id
//     im Container nicht vor, baut das Gateway denselben Namen aus sysfs)
//   ohne brauchbare Seriennummer → die USB-Buchse (port:1-1.2:1.0)
//   RaspBee auf der GPIO-Leiste → uart:ttyAMA0

const fs = require('node:fs');
const path = require('node:path');

const TTY_RE = /^tty(ACM|USB|AMA)[0-9]{1,3}$/;
const DEV_RE = /^([0-9]{1,3}):([0-9]{1,7})$/;
const HCI_RE = /^hci[0-9]{1,2}$/;
// Major-Nummern, die der deCONZ-Dienst öffnen darf (device_cgroup_rules der Compose-Datei)
const MAJORS = Object.freeze({ ttyACM: 166, ttyUSB: 188, ttyAMA: 204 });
const MAX_STICKS = 8;
const ID_MAX = 128;
// Zeichen, die udev in by-id-Namen stehen lässt (alles andere wird „_“)
const ID_RE = /^[A-Za-z0-9#+.:=@_-]{1,128}$/;

/**
 * Bekannte Funksticks. kind: zigbee | thread | multi (Zigbee oder Thread, je nach Firmware).
 * deconz: nur Funkmodule von dresden elektronik spricht deCONZ; baud wie deCONZ sie erwartet.
 * z2m:    Adapter für zigbee2mqtt (ember = Silicon Labs EFR32, zstack = TI CC26xx, deconz = ConBee/RaspBee),
 *         z2mBaud wenn nicht der Standard des Adapters (115200).
 * thread: kann mit RCP-Firmware (OpenThread) als Thread-Funk dienen; threadBaud für den Border Router.
 */
const KNOWN = [
  { vid: '1cf1', pid: '0030', model: 'ConBee II', kind: 'zigbee', deconz: true, baud: 115200, z2m: 'deconz' },
  { vid: '0403', pid: '6015', product: /conbee\s*iii/i, model: 'ConBee III', kind: 'zigbee', deconz: true, baud: 115200, z2m: 'deconz' },
  { vid: '0403', pid: '6015', product: /conbee/i, model: 'ConBee', kind: 'zigbee', deconz: true, baud: 38400, z2m: 'deconz', z2mBaud: 38400 },
  { vid: '10c4', pid: 'ea60', product: /skyconnect/i, model: 'Home Assistant SkyConnect', kind: 'multi', deconz: false, z2m: 'ember', thread: true, threadBaud: 460800 },
  { vid: '10c4', pid: 'ea60', product: /zbt-1/i, model: 'Home Assistant Connect ZBT-1', kind: 'multi', deconz: false, z2m: 'ember', thread: true, threadBaud: 460800 },
  { product: /zbt-2/i, manufacturer: /nabu\s*casa/i, model: 'Home Assistant Connect ZBT-2', kind: 'multi', deconz: false, z2m: 'ember', z2mBaud: 460800, thread: true, threadBaud: 460800 },
  { vid: '1a86', pid: '55d4', product: /dongle plus v2|zbdongle-e/i, model: 'Sonoff ZBDongle-E', kind: 'multi', deconz: false, z2m: 'ember', thread: true, threadBaud: 460800 },
  { vid: '10c4', pid: 'ea60', product: /sonoff.*dongle plus|zbdongle-p/i, model: 'Sonoff ZBDongle-P', kind: 'zigbee', deconz: false, z2m: 'zstack' },
  { vid: '10c4', pid: 'ea60', product: /slzb-07/i, model: 'SMLIGHT SLZB-07', kind: 'multi', deconz: false, z2m: 'ember', thread: true, threadBaud: 460800 },
  { vid: '10c4', pid: 'ea60', product: /slae\.sh|cc2652/i, model: 'CC2652 (slae.sh)', kind: 'zigbee', deconz: false, z2m: 'zstack' },
  { vid: '0451', pid: '16a8', model: 'TI CC2531', kind: 'zigbee', deconz: false, z2m: 'zstack' },
  { vid: '0451', pid: 'bef3', model: 'TI CC26x2R LaunchPad', kind: 'zigbee', deconz: false, z2m: 'zstack' },
  { vid: '1915', product: /openthread/i, model: 'nRF52840 (OpenThread)', kind: 'thread', deconz: false, thread: true, threadBaud: 460800 },
  // sonst jedes Funkmodul von dresden elektronik (deCONZ erkennt den Typ an der Firmware)
  { manufacturer: /dresden.?elektronik/i, model: 'ConBee', kind: 'zigbee', deconz: true, baud: 115200, z2m: 'deconz' },
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

/** Wie udev: Leerraum zusammenfassen und zu „_“, andere unzulässige Zeichen zu „_“. */
function udevEnc(v) {
  return String(v || '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9#+.:=@_-]/g, '_');
}

/** Eine Seriennummer, die einen Stick wirklich kennzeichnet (nicht leer, nicht „0001“ wie bei vielen CP210x). */
function usableSerial(serial) {
  return typeof serial === 'string' && serial.length >= 4 && !/^0+1?$/.test(serial) && !/^(.)\1+$/.test(serial);
}

/** Schnittstellen-Ordner (…/1-1.2:1.0) zwischen tty und USB-Gerät → { dir, num: '00' } oder null. */
function interfaceOf(devPath, usb) {
  let p = devPath;
  for (let i = 0; i < 8 && p && p !== usb && p !== path.dirname(p); i++) {
    const m = /:[0-9]{1,3}\.([0-9]{1,3})$/.exec(path.basename(p));
    if (m) {
      const n = readAttr(p, 'bInterfaceNumber', 2);
      return { dir: p, num: /^[0-9a-f]{2}$/i.test(n) ? n.toLowerCase() : Number(m[1]).toString(16).padStart(2, '0') };
    }
    p = path.dirname(p);
  }
  return null;
}

/** tty → Name in /dev/serial/by-id (nur wenn das Verzeichnis im Container zu sehen ist). */
function byIdNames(devRoot) {
  const out = new Map();
  if (!devRoot) return out;
  const dir = path.join(devRoot, 'serial', 'by-id');
  let names = [];
  try { names = fs.readdirSync(dir).slice(0, 64); } catch { return out; }
  for (const n of names) {
    if (!ID_RE.test(n)) continue;
    let target = '';
    try { target = path.basename(fs.readlinkSync(path.join(dir, n))); } catch { continue; }
    if (TTY_RE.test(target) && !out.has(target)) out.set(target, n);
  }
  return out;
}

/** Feste Kennung eines USB-Sticks: { id, idKind: 'serial' | 'port', portId }. */
function stableId({ tty, usb, iface, info, serial, byId }) {
  const port = clean(path.basename(iface ? iface.dir : usb), 40).replace(/[^0-9.:-]/g, '');
  const portId = 'port:' + (port || tty);
  if (usableSerial(serial)) {
    const real = byId.get(tty);
    if (real && real.includes(udevEnc(serial))) return { id: real.slice(0, ID_MAX), idKind: 'serial', portId };
    const name = 'usb-' + udevEnc(info.manufacturer || info.vid) + '_' + udevEnc(info.product || info.pid) + '_' + udevEnc(serial)
      + '-if' + (iface ? iface.num : '00') + (tty.startsWith('ttyUSB') ? '-port0' : '');
    return { id: name.slice(0, ID_MAX), idKind: 'serial', portId };
  }
  return { id: portId, idKind: 'port', portId };
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

/** USB-Funksticks: [{ id, idKind, port, kind, model, bus: 'usb', tty, dev, deconz, baud, z2m, z2mBaud, thread, threadBaud, vid, pid }]. */
function usbSticks(sys, devRoot) {
  const ttyDir = path.join(sys, 'class', 'tty');
  let names = [];
  try { names = fs.readdirSync(ttyDir).filter((n) => TTY_RE.test(n) && !n.startsWith('ttyAMA')).sort(); } catch { return []; }
  const out = [];
  const byId = byIdNames(devRoot);
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
    const iface = interfaceOf(dev, usb);
    const sid = stableId({ tty, usb, iface, info, serial: readAttr(usb, 'serial', 64), byId });
    out.push({
      id: sid.id,
      idKind: sid.idKind,
      portId: sid.portId,
      port: clean(path.basename(usb), 32),
      kind: k.kind,
      model: k.model,
      product: info.product || null,
      bus: 'usb',
      tty,
      dev: numbers ? `${numbers.major}:${numbers.minor}` : null,
      deconz: k.deconz === true,
      baud: k.baud || null,
      z2m: k.z2m || null,
      z2mBaud: k.z2mBaud || null,
      thread: k.thread === true,
      threadBaud: k.threadBaud || null,
      vid: info.vid,
      pid: info.pid,
    });
    if (out.length >= MAX_STICKS) break;
  }
  // zwei Sticks mit derselben Seriennummer (Werkseinstellung mancher Hersteller): dann zählt die Buchse
  const seen = new Map();
  for (const s of out) seen.set(s.id, (seen.get(s.id) || 0) + 1);
  for (const s of out) {
    if (seen.get(s.id) > 1) { s.id = s.portId; s.idKind = 'port'; }
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
    idKind: 'uart',
    portId: null,
    port: null,
    kind: 'zigbee',
    model: /raspbee2|conbee2/.test(type) ? 'RaspBee II' : 'RaspBee',
    product: null,
    bus: 'uart',
    tty,
    dev: numbers ? `${numbers.major}:${numbers.minor}` : null,
    deconz: true,
    baud: 38400,
    z2m: 'deconz',
    z2mBaud: 38400,
    thread: false,
    threadBaud: null,
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
 * @param {{ sysRoot?: string, devRoot?: string|null, hostProfile?: object|null }} o
 * @returns {{ sticks: object[], bluetooth: object[] }}
 */
function detect({ sysRoot = '/sys', devRoot = '/dev', hostProfile = null } = {}) {
  const sticks = usbSticks(sysRoot, devRoot);
  const host = hostZigbee(sysRoot, hostProfile);
  if (host && !sticks.some((s) => s.tty === host.tty)) sticks.unshift(host);
  return { sticks: sticks.slice(0, MAX_STICKS), bluetooth: bluetoothAdapters(sysRoot) };
}

module.exports = { detect, classify, clean, udevEnc, usableSerial, KNOWN, MAJORS, TTY_RE, ID_RE };
