'use strict';

// Ortszeit für alle Zeitpläne (Portscan-Fenster, Speedtest-Plan, DNS-Zeiten):
// `features.timezone` vom Server (IANA, Vertrag Phase 3b §1.1) überschreibt
// die Umgebungsvariable TZ des Containers. Node übernimmt eine Änderung von
// process.env.TZ sofort für alle Date-Berechnungen. Fehlt der Wert wieder,
// gilt die ursprüngliche TZ (bzw. UTC).

const ORIGINAL_TZ = process.env.TZ;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** Gültiger IANA-Name (den die eingebaute ICU kennt) → Name, sonst null. */
function validTimezone(tz) {
  if (typeof tz !== 'string' || tz.length > 64 || !TZ_RE.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch (_e) {
    return null;
  }
}

let source = ORIGINAL_TZ ? 'env' : 'default';

/** Zeitzone setzen (null = ursprüngliche). → true, wenn sich die wirksame Zeitzone geändert hat. */
function applyTimezone(tz) {
  const want = validTimezone(tz);
  const before = process.env.TZ;
  if (want) {
    if (before !== want) process.env.TZ = want;
    source = 'server';
  } else {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else if (before !== ORIGINAL_TZ) process.env.TZ = ORIGINAL_TZ;
    source = ORIGINAL_TZ ? 'env' : 'default';
  }
  return process.env.TZ !== before;
}

function timezoneTelemetry() {
  return {
    effective: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    source,
    offsetMin: -new Date().getTimezoneOffset(),
  };
}

module.exports = { applyTimezone, validTimezone, timezoneTelemetry, ORIGINAL_TZ };
