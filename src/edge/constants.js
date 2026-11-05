'use strict';

// Edge-Laufzeit (docs/edge.md): Grenzen und Zeiten aus dem Vertrag zwischen
// Gateway und Server (Phase 2, Version 1). Eine Stelle für alle Zahlen, damit
// Tests und Doku dieselben Werte sehen.

const path = require('node:path');

const EDGE_HOST_VERSION = '1.0.0';
const PROTOCOL = 'gc-edge.v1';
const PROTOCOL_VERSION = 1;

// Feste UID/GID des Edge-Benutzers im Image (Dockerfile: Benutzer "gcedge").
// Die Netzgrenze des Gateway-Containers (Owner-Match) hängt an dieser Zahl.
const EDGE_UID = 61001;
const EDGE_GID = 61001;

const LIMITS = Object.freeze({
  frameBytes: 64 * 1024,          // ein WebSocket-Textframe
  callTimeoutMaxMs: 30000,        // Aufruf vom Server
  callTimeoutDefaultMs: 30000,
  openCallsPerPlugin: 32,
  eventsPerSec: 50,
  logsPerSec: 20,
  logLineBytes: 2048,
  eventBufferMax: 1000,           // offline gepufferte Ereignisse je Plugin
  eventBufferMaxAgeMs: 60 * 60 * 1000,
  storeBytes: 1024 * 1024,        // gc.store je Plugin
  maxPlugins: 32,
  packageBytes: 20 * 1024 * 1024, // wie der Server (constants.js LIMITS)
  unpackedBytes: 50 * 1024 * 1024,
  fileCount: 1000,
  pathLength: 200,
  pathDepth: 12,
  manifestBytes: 256 * 1024,
  hostCallsPerPlugin: 64,         // gleichzeitige gc.*-Aufrufe eines Prozesses
  httpRequestBytes: 1024 * 1024,
  httpResponseBytes: 5 * 1024 * 1024,
  httpTimeoutMaxMs: 30000,
  udpSocketsPerPlugin: 16,
  udpDatagramBytes: 8192,
  tcpSocketsPerPlugin: 32,
  tcpWriteBufferBytes: 1024 * 1024,
  mdnsBrowsesPerPlugin: 8,
  mqttSubscriptionsPerPlugin: 64,
  mqttPayloadBytes: 256 * 1024,
  memoryMbMin: 16,
  memoryMbMax: 256,
  memoryMbDefault: 48,
});

const TIMING = Object.freeze({
  pingMs: 20000,
  pongTimeoutMs: 60000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 60000,
  unsupportedRetryMs: 10 * 60 * 1000, // älterer Server ohne Edge-Endpunkt (404)
  authRetryMs: 5 * 60 * 1000,         // Token abgelehnt (401/403)
  statusEveryMs: 30000,
  statusDebounceMs: 1000,
  fenceCheckMs: 30000,
  fenceMarkerMaxAgeMs: 3 * 60 * 1000,
  startTimeoutMs: 15000,
  stopGraceMs: 3000,
  childPingMs: 30000,
  childDeadMs: 75000,
  stableAfterMs: 10 * 60 * 1000,
  downloadTimeoutMs: 60000,
});

// Neustart nach Absturz: 1 s … 5 min, der letzte Wert wiederholt sich.
const RESTART_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 15000, 30000, 60000, 300000]);

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]{1,40})?$/;

function assertId(id) {
  if (typeof id !== 'string' || id.length < 2 || id.length > 64 || !ID_RE.test(id)) throw new Error('invalid plugin id');
  return id;
}

function assertVersion(v) {
  if (typeof v !== 'string' || v.length > 64 || !VERSION_RE.test(v)) throw new Error('invalid plugin version');
  return v;
}

// Pfade (im Edge-Container; per Umgebung überschreibbar für Tests).
function paths(env = process.env) {
  const stateDir = env.GC_EDGE_STATE_DIR || '/state-edge';
  return {
    runDir: env.GC_EDGE_RUN_DIR || '/run/gc-edge',            // Gateway → Edge (nur lesbar)
    statusDir: env.GC_EDGE_STATUS_DIR || '/run/gc-edge-status', // Edge → Gateway (Telemetrie)
    stateDir,
    packagesDir: path.join(stateDir, 'packages'),
    dataDir: path.join(stateDir, 'data'),
    mqttDir: env.GC_EDGE_MQTT_DIR || '/gc-mqtt',
  };
}

module.exports = {
  EDGE_HOST_VERSION, PROTOCOL, PROTOCOL_VERSION, EDGE_UID, EDGE_GID, LIMITS, TIMING, RESTART_BACKOFF_MS,
  ID_RE, VERSION_RE, assertId, assertVersion, paths,
};
