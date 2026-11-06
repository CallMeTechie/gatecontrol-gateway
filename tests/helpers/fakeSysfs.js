'use strict';

// Ein kleines sysfs zum Testen der Funk-Erkennung (src/radio/detect.js):
// USB-Geräte unter devices/…/usbN/<port> mit idVendor/idProduct/manufacturer/
// product, darunter eine tty (cdc_acm: …/tty/ttyACM0, usb-serial: …/ttyUSB0),
// class/tty/<tty> → Link aufs Gerät, dev = major:minor; Bluetooth unter
// class/bluetooth/hciN.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * @param {{ usb?: Array<{ port, vid, pid, manufacturer?, product?, tty, dev }>, uart?: Array<{ tty, dev }>, bt?: Array<{ name, usbPort?, product? }> }} spec
 * @returns {string} Wurzel (statt /sys)
 */
function makeSysfs(spec = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sysfs-'));
  const devices = path.join(root, 'devices', 'platform', 'soc', 'usb1');
  for (const u of spec.usb || []) {
    const dev = path.join(devices, u.port);
    write(path.join(dev, 'idVendor'), u.vid + '\n');
    write(path.join(dev, 'idProduct'), u.pid + '\n');
    if (u.manufacturer) write(path.join(dev, 'manufacturer'), u.manufacturer + '\n');
    if (u.product) write(path.join(dev, 'product'), u.product + '\n');
    const iface = path.join(dev, `${u.port}:1.0`);
    const ttyDev = u.tty.startsWith('ttyUSB') ? path.join(iface, u.tty) : path.join(iface, 'tty', u.tty);
    fs.mkdirSync(ttyDev, { recursive: true });
    const cls = path.join(root, 'class', 'tty', u.tty);
    fs.mkdirSync(cls, { recursive: true });
    fs.symlinkSync(ttyDev, path.join(cls, 'device'));
    write(path.join(cls, 'dev'), u.dev + '\n');
  }
  for (const u of spec.uart || []) {
    const dev = path.join(root, 'devices', 'platform', 'soc', 'fe201000.serial');
    fs.mkdirSync(dev, { recursive: true });
    const cls = path.join(root, 'class', 'tty', u.tty);
    fs.mkdirSync(cls, { recursive: true });
    fs.symlinkSync(dev, path.join(cls, 'device'));
    write(path.join(cls, 'dev'), u.dev + '\n');
  }
  for (const b of spec.bt || []) {
    let dev;
    if (b.usbPort) {
      const usb = path.join(devices, b.usbPort);
      write(path.join(usb, 'idVendor'), '0a12\n');
      write(path.join(usb, 'idProduct'), '0001\n');
      if (b.product) write(path.join(usb, 'product'), b.product + '\n');
      dev = path.join(usb, `${b.usbPort}:1.0`);
    } else {
      dev = path.join(root, 'devices', 'platform', 'soc', 'fe215040.serial', 'serial0', 'serial0-0');
    }
    fs.mkdirSync(path.join(dev, 'bluetooth', b.name), { recursive: true });
    const cls = path.join(root, 'class', 'bluetooth');
    fs.mkdirSync(cls, { recursive: true });
    fs.symlinkSync(path.join(dev, 'bluetooth', b.name), path.join(cls, b.name));
    fs.symlinkSync(dev, path.join(dev, 'bluetooth', b.name, 'device'));
  }
  return root;
}

const CONBEE2 = { port: '1-1.2', vid: '1cf1', pid: '0030', manufacturer: 'dresden elektronik ingenieurtechnik GmbH', product: 'ConBee II', tty: 'ttyACM0', dev: '166:0' };
const ZBT1 = { port: '1-1.3', vid: '10c4', pid: 'ea60', manufacturer: 'Nabu Casa', product: 'Home Assistant Connect ZBT-1', tty: 'ttyUSB0', dev: '188:0' };

module.exports = { makeSysfs, CONBEE2, ZBT1 };
