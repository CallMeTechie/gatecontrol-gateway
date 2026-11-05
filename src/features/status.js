'use strict';

// Zustand je Funktion für die Telemetrie (Karte „Funktionen“ im Server):
// an/aus, läuft gerade, letzter Lauf, letzter Erfolg, letzter Fehler.

const MAX_MSG = 200;

class FeatureStatus {
  constructor(now = Date.now) {
    this.now = now;
    this.enabled = false;
    this.running = false;
    this.lastRunAt = null;
    this.lastOkAt = null;
    this.lastError = null;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.running = false;
  }

  start() {
    this.running = true;
    this.lastRunAt = this.now();
  }

  ok() {
    this.running = false;
    this.lastOkAt = this.now();
    this.lastError = null;
  }

  fail(err) {
    this.running = false;
    const message = String(err && err.message ? err.message : err).slice(0, MAX_MSG);
    this.lastError = { at: this.now(), message };
  }

  snapshot(extra = {}) {
    return {
      enabled: this.enabled,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      ...extra,
    };
  }
}

/**
 * Wiederkehrende Aufgabe ohne Überlappung: nächster Lauf erst nach dem Ende
 * des vorigen. `delayFn()` liefert die Wartezeit bis zum nächsten Lauf.
 */
function loop(fn, delayFn, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  let stopped = false;
  async function run() {
    timer = null;
    if (stopped) return;
    try { await fn(); } catch (_e) { /* fn meldet selbst */ }
    if (!stopped) schedule(delayFn());
  }
  function schedule(ms) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(run, Math.max(0, ms));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  return {
    start(firstDelayMs = 0) { stopped = false; schedule(firstDelayMs); },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; },
  };
}

module.exports = { FeatureStatus, loop };
