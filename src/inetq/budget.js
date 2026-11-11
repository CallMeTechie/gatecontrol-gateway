'use strict';

// Tagesbudget der Speedtests (docs/netzwerk-internet.md „Speedtest“): wie viel
// Datenvolumen und wie viele Tests in den letzten 24 Stunden gelaufen sind.
// Liegt in /state/inetq-budget.json und übersteht damit Neustart und Update –
// der Server zählt nur im Arbeitsspeicher und fängt nach seinem Neustart bei
// null an. Gezählt wird in Stundenfächern (höchstens 25 Einträge).

const { readJson, writeJson } = require('../features/persist');

const STATE_FILE = 'inetq-budget.json';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
// wie der Server (SPEED_BUDGET_BYTES), falls er kein eigenes Limit schickt
const DEFAULT_DAY_BYTES = 12_000_000_000;
// weniger Rest lohnt keinen Test mehr (die Messung wäre nach Sekundenbruchteilen zu Ende)
const MIN_TEST_BYTES = 20_000_000;
const MAX_REFUSED_MS = DAY;

const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

class SpeedBudget {
  constructor({ stateDir = null, now = Date.now } = {}) {
    this.stateDir = stateDir;
    this.now = now;
    this.slots = []; // [{ t: Stundenbeginn, bytes, tests }], aufsteigend
    this.refusedUntil = null; // der Server hat „budget“ gemeldet → bis dahin kein Test
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.stateDir) return;
    const s = readJson(this.stateDir, STATE_FILE, 64 * 1024);
    if (!s) return;
    const now = this.now();
    if (Array.isArray(s.slots)) {
      const byHour = new Map();
      for (const x of s.slots.slice(-48)) {
        // Fächer aus der Zukunft (verstellte Uhr) zählen nicht – sie würden das Budget tagelang sperren
        if (!x || !Number.isSafeInteger(x.t) || x.t > now || now - x.t >= DAY + HOUR) continue;
        const t = x.t - (x.t % HOUR);
        const cur = byHour.get(t) || { t, bytes: 0, tests: 0 };
        cur.bytes += int(x.bytes);
        cur.tests += int(x.tests);
        byHour.set(t, cur);
      }
      this.slots = [...byHour.values()].sort((a, b) => a.t - b.t);
    }
    if (Number.isSafeInteger(s.refusedUntil) && s.refusedUntil > now && s.refusedUntil - now <= MAX_REFUSED_MS) this.refusedUntil = s.refusedUntil;
  }

  _prune(now) {
    this.slots = this.slots.filter((x) => x.t <= now && now - x.t < DAY);
    if (this.refusedUntil !== null && this.refusedUntil <= now) this.refusedUntil = null;
  }

  _save() {
    if (this.stateDir) writeJson(this.stateDir, STATE_FILE, { v: 1, slots: this.slots, refusedUntil: this.refusedUntil });
  }

  /** In den letzten 24 Stunden verbrauchtes Volumen (Bytes). */
  usedBytes(now = this.now()) {
    this.load();
    this._prune(now);
    return this.slots.reduce((a, x) => a + x.bytes, 0);
  }

  tests(now = this.now()) {
    this.load();
    this._prune(now);
    return this.slots.reduce((a, x) => a + x.tests, 0);
  }

  /** Rest bis zum Tageslimit (nie negativ). */
  remaining(limitBytes = DEFAULT_DAY_BYTES, now = this.now()) {
    return Math.max(0, limitBytes - this.usedBytes(now));
  }

  /** Wann wieder Platz für einen Test ist (ms) – null, wenn jetzt schon. */
  blockedUntil(limitBytes = DEFAULT_DAY_BYTES, now = this.now()) {
    const used = this.usedBytes(now);
    let until = this.refusedUntil;
    if (limitBytes - used < MIN_TEST_BYTES) {
      // das älteste Fach fällt als erstes aus dem Fenster
      let rest = used;
      let own = null;
      for (const x of this.slots) {
        rest -= x.bytes;
        own = x.t + DAY;
        if (limitBytes - rest >= MIN_TEST_BYTES) break;
      }
      if (own !== null && (until === null || own > until)) until = own;
    }
    return until !== null && until > now ? until : null;
  }

  /** Ein Test ist gelaufen: Volumen buchen (auch ein abgebrochener zählt). */
  record(bytes, now = this.now()) {
    this.load();
    this._prune(now);
    const t = now - (now % HOUR);
    let slot = this.slots[this.slots.length - 1];
    if (!slot || slot.t !== t) { slot = { t, bytes: 0, tests: 0 }; this.slots.push(slot); }
    slot.bytes += int(Math.round(bytes));
    slot.tests += 1;
    this._save();
  }

  /** Der Server hat einen Stream mit „budget“ abgelehnt: bis `until` (höchstens 24 h) keinen Test mehr starten. */
  refused(until, now = this.now()) {
    this.load();
    const u = Number.isFinite(until) && until > now ? Math.min(until, now + MAX_REFUSED_MS) : now + HOUR;
    this.refusedUntil = Math.round(u);
    this._save();
  }

  snapshot(limitBytes = DEFAULT_DAY_BYTES, now = this.now()) {
    return {
      usedBytes: this.usedBytes(now),
      limitBytes,
      tests: this.tests(now),
      blockedUntil: this.blockedUntil(limitBytes, now),
    };
  }
}

module.exports = { SpeedBudget, DEFAULT_DAY_BYTES, MIN_TEST_BYTES, STATE_FILE };
