'use strict';

// `features.radio` (Vertrag Phase 3c, Schritt 2 §2, erweitert für zigbee2mqtt,
// Thread und verschlüsselte Bluetooth-Sensoren) prüfen.
//   zigbee:  true | false | null  – null (Standard) = automatisch: an, wenn ein
//            deCONZ-Funkmodul erkannt ist (wie bisher im Pi-Image)
//   stack:   'deconz' | 'zigbee2mqtt' – welcher Zigbee-Dienst den Stick bedient
//            (Standard deconz; „automatisch“ schaltet nur deCONZ von selbst ein)
//   ble:     true | false         – passiv Bluetooth-Sensoren mithören
//   thread:  true | false         – OpenThread Border Router (Stick mit RCP-Firmware)
//   bleKeys: Stand der Schlüssel verschlüsselter Bluetooth-Sensoren (Hex) oder null –
//            die Schlüssel selbst holt das Gateway über GET /api/v1/gateway/radio/ble/keys
//   sticks:  [{ id, use }] – von Hand festgelegte Sticks (Capability radio-stick-assign):
//            id = feste Kennung aus der Erkennung (by-id-Name, port:…, uart:…),
//            use = 'zigbee' | 'thread' | 'none'; nicht genannte Sticks = automatisch
// Fehlt `features.radio` (älterer Server) → Zigbee automatisch mit deCONZ, Rest aus.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const STACKS = ['deconz', 'zigbee2mqtt'];
const STICK_USES = ['zigbee', 'thread', 'none'];
const STICK_ID_RE = /^[A-Za-z0-9#+.:=@_-]{1,128}$/;
const MAX_STICKS = 16;

/** Von Hand festgelegte Sticks: gültige Einträge, je Kennung der erste, „auto“ fällt weg. */
function normalizeSticks(raw) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(raw) ? raw.slice(0, 64) : []) {
    if (!isObj(e) || typeof e.id !== 'string' || !STICK_ID_RE.test(e.id) || !STICK_USES.includes(e.use) || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ id: e.id, use: e.use });
    if (out.length >= MAX_STICKS) break;
  }
  return out;
}

function normalizeRadio(raw) {
  const r = isObj(raw) ? raw : {};
  return {
    zigbee: typeof r.zigbee === 'boolean' ? r.zigbee : null,
    stack: STACKS.includes(r.stack) ? r.stack : 'deconz',
    ble: r.ble === true,
    thread: r.thread === true,
    bleKeys: typeof r.bleKeys === 'string' && /^[0-9a-f]{8,64}$/.test(r.bleKeys) ? r.bleKeys : null,
    sticks: normalizeSticks(r.sticks),
  };
}

module.exports = { normalizeRadio, normalizeSticks, STACKS, STICK_USES };
