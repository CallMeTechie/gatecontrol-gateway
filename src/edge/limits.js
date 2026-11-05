'use strict';

// Kleine Begrenzer für Ereignisse und Logs je Plugin (Vertrag Abschnitt 7).

/** Höchstens `max` Vorgänge je `windowMs`; zählt verworfene. */
class RateWindow {
  constructor(max, windowMs = 1000, now = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.start = 0;
    this.n = 0;
    this.dropped = 0;
  }

  take() {
    const t = this.now();
    if (t - this.start >= this.windowMs) { this.start = t; this.n = 0; }
    if (this.n >= this.max) { this.dropped++; return false; }
    this.n++;
    return true;
  }

  /** Seit dem letzten Aufruf verworfen (setzt den Zähler zurück). */
  drainDropped() {
    const d = this.dropped;
    this.dropped = 0;
    return d;
  }
}

/** Text auf höchstens `max` Bytes (UTF-8) kürzen, ohne ein Zeichen zu zerschneiden. */
function truncateUtf8(s, max) {
  const str = String(s);
  if (Buffer.byteLength(str, 'utf8') <= max) return str;
  let buf = Buffer.from(str, 'utf8').subarray(0, max);
  // unvollständige Mehrbyte-Folge am Ende abschneiden
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (buf[i] & 0xc0) === 0x80) { i--; back++; }
  if (i >= 0) {
    const lead = buf[i];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need !== back + 1) buf = buf.subarray(0, i);
  }
  return buf.toString('utf8');
}

module.exports = { RateWindow, truncateUtf8 };
