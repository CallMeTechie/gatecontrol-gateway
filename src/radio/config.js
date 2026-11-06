'use strict';

// `features.radio` (Vertrag Phase 3c, Schritt 2 §2) prüfen.
//   zigbee: true | false | null  – null (Standard) = automatisch: an, wenn ein
//           deCONZ-Funkmodul erkannt ist (wie bisher im Pi-Image)
//   ble:    true | false         – passiv Bluetooth-Sensoren mithören
// Fehlt `features.radio` (älterer Server) → Zigbee automatisch, Bluetooth aus.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function normalizeRadio(raw) {
  const r = isObj(raw) ? raw : {};
  return {
    zigbee: typeof r.zigbee === 'boolean' ? r.zigbee : null,
    ble: r.ble === true,
  };
}

module.exports = { normalizeRadio };
