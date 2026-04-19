'use strict';

const logger = require('../logger');

function computeBackoff(fails, { baseMs = 5000, maxMs = 300000 } = {}) {
  const delay = baseMs * Math.pow(2, fails);
  return Math.min(delay, maxMs);
}

class Poller {
  constructor({ intervalMs = 300000, fetcher, debounceMs = 500, baseMs = 5000, maxMs = 300000 }) {
    this.intervalMs = intervalMs;
    this.fetcher = fetcher;
    this.debounceMs = debounceMs;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.consecutiveFails = 0;
    this._timer = null;
    this._debounceTimer = null;
    this._running = false;
  }

  start() {
    this._scheduleNext(this.intervalMs);
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._timer = null;
    this._debounceTimer = null;
  }

  /** Trigger an immediate poll (debounced). */
  triggerImmediate() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._runOnce();
    }, this.debounceMs);
  }

  async _runOnce() {
    if (this._running) return; // prevent concurrent
    this._running = true;
    try {
      await this.fetcher();
      this.consecutiveFails = 0;
      this._scheduleNext(this.intervalMs);
    } catch (err) {
      this.consecutiveFails++;
      const backoff = computeBackoff(this.consecutiveFails, { baseMs: this.baseMs, maxMs: this.maxMs });
      logger.warn({ err: err.message, fails: this.consecutiveFails, backoffMs: backoff }, 'Poll failed, backing off');
      this._scheduleNext(backoff);
    } finally {
      this._running = false;
    }
  }

  _scheduleNext(delayMs) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._runOnce(), delayMs);
  }
}

module.exports = { Poller, computeBackoff };
