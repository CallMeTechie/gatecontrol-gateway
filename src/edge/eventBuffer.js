'use strict';

// Ereignispuffer je Plugin (Vertrag Abschnitt 2): jedes Ereignis bekommt eine
// aufsteigende `seq` und bleibt im Puffer, bis der Server es mit
// {"t":"ack","plugin","seq"} bestätigt (bis einschließlich seq). Offline
// höchstens 1000 Ereignisse bzw. 1 Stunde – ältere fallen heraus (gezählt).
//
// seq ist aufsteigend, aber nicht lückenlos: der Zähler startet bei der
// aktuellen Zeit in ms und zählt dann weiter (max(letzte+1, jetzt)). So
// bleibt er auch über einen Neustart des Edge-Containers aufsteigend, ohne
// bei jedem Ereignis auf die SD-Karte zu schreiben (Ereignisse ≤ 50/s, die
// Uhr läuft mit 1000/s).

const { LIMITS } = require('./constants');

class EventBuffer {
  constructor({ max = LIMITS.eventBufferMax, maxAgeMs = LIMITS.eventBufferMaxAgeMs, now = Date.now } = {}) {
    this.max = max;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.lastSeq = 0;
    this.items = []; // { seq, msg, ts }
    this.lost = 0;
  }

  nextSeq() {
    this.lastSeq = Math.max(this.lastSeq + 1, this.now());
    return this.lastSeq;
  }

  /** Ereignis aufnehmen; liefert die fertige Nachricht (mit seq). */
  push(plugin, name, data, at = new Date(this.now()).toISOString()) {
    const seq = this.nextSeq();
    const msg = { t: 'event', plugin, name, data, at, seq };
    this.items.push({ seq, msg, ts: this.now() });
    this.prune();
    return msg;
  }

  prune() {
    const cutoff = this.now() - this.maxAgeMs;
    while (this.items.length && this.items[0].ts < cutoff) { this.items.shift(); this.lost++; }
    while (this.items.length > this.max) { this.items.shift(); this.lost++; }
  }

  /** Bestätigt bis einschließlich seq. */
  ack(seq) {
    if (!Number.isFinite(seq)) return 0;
    let n = 0;
    while (this.items.length && this.items[0].seq <= seq) { this.items.shift(); n++; }
    return n;
  }

  /** Alle noch unbestätigten Nachrichten (nach dem Wiederverbinden erneut senden). */
  pending() {
    this.prune();
    return this.items.map((i) => i.msg);
  }

  get size() { return this.items.length; }
}

module.exports = { EventBuffer };
