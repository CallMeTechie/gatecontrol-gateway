'use strict';

// 5-Minuten-Werte und Ausfallerkennung der Internetqualität (Vertrag Phase 3a,
// Abschnitt 4). Rein rechnend, ohne Netz und Uhr – gut testbar.

const { mean } = require('./probe');

const BUCKET_MS = 5 * 60_000;
const CONFIRM_MS = 60_000;
// Lag zwischen letzter „weg“-Messung und erster „da“-Messung mehr als das
// (Gateway selbst war aus, z. B. Stromausfall), endet der Ausfall bei der
// letzten „weg“-Messung – was danach war, weiß das Gateway nicht.
const GAP_MS = 10 * 60_000;

class Aggregator {
  constructor(bucketMs = BUCKET_MS) {
    this.bucketMs = bucketMs;
    this.cur = null;
  }

  _finish(b) {
    return {
      t: b.t,
      rttRouterMs: mean(b.router),
      rttInetMs: mean(b.inet),
      lossInetPct: b.sent > 0 ? Math.round(((b.sent - b.received) / b.sent) * 1000) / 10 : null,
      rttServerMs: mean(b.server),
      n: b.n,
    };
  }

  /** Messung aufnehmen → abgeschlossenes Intervall (wenn die Messung in ein neues fällt) oder null. */
  add(m) {
    const t = Math.floor(m.at / this.bucketMs) * this.bucketMs;
    let closed = null;
    if (this.cur && this.cur.t !== t) { closed = this._finish(this.cur); this.cur = null; }
    if (!this.cur) this.cur = { t, router: [], inet: [], server: [], sent: 0, received: 0, n: 0 };
    const b = this.cur;
    b.n++;
    if (m.rttRouterMs !== null && m.rttRouterMs !== undefined) b.router.push(m.rttRouterMs);
    if (m.rttInetMs !== null && m.rttInetMs !== undefined) b.inet.push(m.rttInetMs);
    if (m.rttServerMs !== null && m.rttServerMs !== undefined) b.server.push(m.rttServerMs);
    b.sent += m.sent || 0;
    b.received += m.received || 0;
    return closed;
  }

  /** Intervall abschließen, wenn seine Zeit um ist (z. B. während eines Speedtests ohne Messungen). */
  flush(now) {
    if (this.cur && now >= this.cur.t + this.bucketMs) {
      const closed = this._finish(this.cur);
      this.cur = null;
      return closed;
    }
    return null;
  }
}

/**
 * Ausfall = alle öffentlichen Ziele ≥ 60 s ohne Antwort. Ursache 'router',
 * wenn währenddessen auch der Router nicht antwortete, sonst 'isp'.
 * observe() liefert einen geänderten Ausfall-Datensatz { start, end, cause }
 * (end = null solange er läuft) oder null.
 */
class OutageDetector {
  constructor({ confirmMs = CONFIRM_MS, gapMs = GAP_MS, open = null } = {}) {
    this.confirmMs = confirmMs;
    this.gapMs = gapMs;
    this.suspect = null; // { at, routerDown }
    this.open = open && Number.isFinite(open.start)
      ? { start: open.start, cause: open.cause === 'router' ? 'router' : 'isp', lastDownAt: Number(open.lastDownAt) || open.start }
      : null;
  }

  get active() { return this.suspect !== null || this.open !== null; }

  observe({ at, inetOk, routerOk }) {
    if (inetOk) {
      this.suspect = null;
      if (!this.open) return null;
      const o = this.open;
      this.open = null;
      const end = at - o.lastDownAt > this.gapMs ? o.lastDownAt : at;
      return { start: o.start, end, cause: o.cause };
    }
    const routerDown = routerOk === false;
    if (this.open) {
      this.open.lastDownAt = at;
      if (routerDown && this.open.cause !== 'router') {
        this.open.cause = 'router';
        return { start: this.open.start, end: null, cause: 'router' };
      }
      return null;
    }
    if (!this.suspect) {
      this.suspect = { at, routerDown };
      return null;
    }
    if (routerDown) this.suspect.routerDown = true;
    if (at - this.suspect.at >= this.confirmMs) {
      this.open = { start: this.suspect.at, cause: this.suspect.routerDown ? 'router' : 'isp', lastDownAt: at };
      this.suspect = null;
      return { start: this.open.start, end: null, cause: this.open.cause };
    }
    return null;
  }
}

module.exports = { Aggregator, OutageDetector, BUCKET_MS };
