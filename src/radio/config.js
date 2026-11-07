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
// Fehlt `features.radio` (älterer Server) → Zigbee automatisch mit deCONZ, Rest aus.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const STACKS = ['deconz', 'zigbee2mqtt'];

function normalizeRadio(raw) {
  const r = isObj(raw) ? raw : {};
  return {
    zigbee: typeof r.zigbee === 'boolean' ? r.zigbee : null,
    stack: STACKS.includes(r.stack) ? r.stack : 'deconz',
    ble: r.ble === true,
    thread: r.thread === true,
    bleKeys: typeof r.bleKeys === 'string' && /^[0-9a-f]{8,64}$/.test(r.bleKeys) ? r.bleKeys : null,
  };
}

module.exports = { normalizeRadio, STACKS };
