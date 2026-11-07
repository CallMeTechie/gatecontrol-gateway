'use strict';

// Grafikkarten für die lokale KI (docs/local-ai.md §2.1). Zwei Blicke:
//
//  1. Der Rechner (sysfs, auch im Gateway-Container lesbar): PCI-Klasse 0x03…,
//     Hersteller, geladener Treiber (nvidia, nouveau, amdgpu, i915, xe …),
//     Grafikspeicher (AMD: mem_info_vram_total), NVIDIA-Treiberversion
//     (/sys/module/nvidia/version), ROCm-Schnittstelle /dev/kfd
//     (/sys/class/kfd/kfd) und Render-Knoten (/sys/class/drm/renderD*).
//  2. Der Dienst ki: sein Wächter schreibt /gc-ai/ki.gpu – die GPU-Art aus der
//     Compose-Datei (GC_KI_GPU), welche Geräte der Container sieht und, mit dem
//     NVIDIA Container Toolkit, was nvidia-smi meldet (Name, Speicher, Treiber).
//
// Daraus macht der Server die Hinweise („Treiber fehlt“, „Toolkit fehlt“,
// „Compose-Datei neu laden“) und die Modellgrößen nach Grafikspeicher.

const fs = require('node:fs');
const path = require('node:path');
const { cleanText } = require('../print/config');

const VENDORS = { '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel' };
const MODES = new Set(['none', 'nvidia', 'amd', 'intel']);
const DEVICES = { nvidia0: 'nvidia', nvidiactl: 'nvidia', kfd: 'kfd' };
const GPU_FILE = 'ki.gpu';
const FRESH_S = 5 * 60;
const MAX_CARDS = 4;

function readText(file, max = 4096) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

const MB = 1024 * 1024;

/** Grafikkarten und Treiber des Rechners aus sysfs/procfs. */
function detectHost(sysRoot = '/sys', procRoot = '/proc') {
  const cards = [];
  let names = [];
  try { names = fs.readdirSync(path.join(sysRoot, 'bus/pci/devices')).slice(0, 256).sort(); } catch { names = []; }
  for (const n of names) {
    const dir = path.join(sysRoot, 'bus/pci/devices', n);
    const cls = (readText(path.join(dir, 'class'), 64) || '').trim();
    if (!/^0x03[0-9a-f]{4}$/i.test(cls)) continue;
    const vendor = VENDORS[(readText(path.join(dir, 'vendor'), 64) || '').trim().toLowerCase()] || 'other';
    let driver = null;
    try { driver = path.basename(fs.readlinkSync(path.join(dir, 'driver'))); } catch { driver = null; }
    if (driver && !/^[a-z0-9_-]{1,24}$/i.test(driver)) driver = null;
    let vramMb = null;
    const vram = Number((readText(path.join(dir, 'mem_info_vram_total'), 64) || '').trim());
    if (Number.isFinite(vram) && vram > 0) vramMb = Math.round(vram / MB);
    let name = null;
    if (vendor === 'nvidia') {
      const info = readText(path.join(procRoot, 'driver/nvidia/gpus', n, 'information'), 4096) || '';
      const m = /^Model:\s*(.+)$/m.exec(info);
      if (m) name = cleanText(m[1], 64) || null;
    }
    // Intel auf Bus 0 ist die eingebaute Grafik; eine AMD-APU hat nur einen kleinen eigenen Speicher
    const integrated = vendor === 'intel' ? /^[0-9a-f]{4}:00:/i.test(n) : (vendor === 'amd' && vramMb !== null && vramMb < 2048);
    cards.push({ vendor, driver: driver ? driver.toLowerCase() : null, vramMb, integrated, name });
    if (cards.length >= MAX_CARDS) break;
  }
  const nv = (readText(path.join(sysRoot, 'module/nvidia/version'), 64) || '').trim();
  let render = false;
  try { render = fs.readdirSync(path.join(sysRoot, 'class/drm')).some((d) => /^renderD[0-9]+$/.test(d)); } catch { render = false; }
  return {
    cards,
    nvidiaDriver: /^[0-9][0-9.]{0,19}$/.test(nv) ? nv : null,
    kfd: exists(path.join(sysRoot, 'class/kfd/kfd')),
    render,
  };
}

/**
 * /gc-ai/ki.gpu des Wächters → { mode, devices, cards, at } oder null
 * (fehlt, zu alt, alte Compose-Datei ohne GPU-Bericht).
 *   mode nvidia | amd | intel | none
 *   at   <Unix-Sekunden>
 *   dev  nvidia0 | nvidiactl | kfd | renderD128 …
 *   nv   <Name>, <Speicher MiB>, <Treiber>     (nvidia-smi)
 */
function readServiceGpu(ctlDir, nowMs = Date.now()) {
  const text = readText(path.join(ctlDir, GPU_FILE), 4096);
  if (!text) return null;
  let mode = null;
  let at = 0;
  const devices = new Set();
  const cards = [];
  for (const raw of text.split('\n').slice(0, 64)) {
    const line = raw.trim();
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1).trim();
    if (k === 'mode' && MODES.has(v)) mode = v;
    else if (k === 'at' && /^[0-9]{1,12}$/.test(v)) at = Number(v);
    else if (k === 'dev') {
      if (DEVICES[v]) devices.add(DEVICES[v]);
      else if (/^renderD[0-9]{1,4}$/.test(v)) devices.add('dri');
    } else if (k === 'nv' && cards.length < MAX_CARDS) {
      const [name, mem, drv] = v.split(',').map((x) => x.trim());
      const mib = Number(mem);
      cards.push({
        name: cleanText(name, 64) || null,
        vramMb: Number.isFinite(mib) && mib > 0 ? Math.round(mib) : null,
        driver: /^[0-9][0-9.]{0,19}$/.test(drv || '') ? drv : null,
      });
    }
  }
  if (!mode || !at || Math.abs(nowMs / 1000 - at) > FRESH_S) return null;
  return { mode, devices: [...devices].sort(), cards };
}

/** Sieht der Dienst die Geräte, die seine GPU-Art braucht? (null: keine GPU gewählt) */
function serviceAccess(svc) {
  if (!svc || svc.mode === 'none') return null;
  const d = new Set(svc.devices);
  if (svc.mode === 'nvidia') return d.has('nvidia');
  if (svc.mode === 'amd') return d.has('kfd') && d.has('dri');
  return d.has('dri');
}

module.exports = { detectHost, readServiceGpu, serviceAccess, VENDORS, GPU_FILE };
