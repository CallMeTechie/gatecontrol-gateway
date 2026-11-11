'use strict';

// Was für ein Gerät ist das? Nur für die Anzeige der Einrichtungsseite und um
// die Synology-Anleitung dort zu zeigen, wo sie passt.

const fs = require('node:fs');
const os = require('node:os');

function read(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/\0/g, '').trim(); } catch { return ''; }
}

function clean(s, max = 60) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

/**
 * @returns {{ kind: 'synology'|'rpi'|'other', label: string }}
 */
function detectPlatform({ readFile = read, hostname = os.hostname, hardwareProfile } = {}) {
  // DSM-Kernel: /proc/sys/kernel/syno_hw_version (z. B. „DS224+“), auch im Container lesbar
  const syno = clean(readFile('/proc/sys/kernel/syno_hw_version'));
  if (syno) return { kind: 'synology', label: `Synology ${syno}` };
  let model = '';
  try { model = clean((hardwareProfile ? hardwareProfile() : require('../health/telemetry').hardwareProfile()).model); } catch { model = ''; }
  if (/raspberry pi/i.test(model)) return { kind: 'rpi', label: model };
  return { kind: 'other', label: model || clean(hostname()) || 'Gateway' };
}

module.exports = { detectPlatform };
