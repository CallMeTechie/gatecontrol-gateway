'use strict';

// Ein Plugin-Prozess des Edge-Hosts (docs/edge.md "Isolation"): fork von
// child/bootstrap.js mit Nodes Permission-Model, --max-old-space-size =
// memoryMb, leere Umgebung, Neustart mit Backoff (1 s … 5 min), Watchdog per
// Ping. Ansatz wie am Server (gatecontrol src/services/plugins/runtime.js),
// nur ohne Schreibrecht im Dateisystem: gc.store schreibt der Host.

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const EventEmitter = require('node:events');
const { LIMITS, TIMING, RESTART_BACKOFF_MS } = require('./constants');
const { RateWindow, truncateUtf8 } = require('./limits');

const BOOTSTRAP = path.join(__dirname, 'child', 'bootstrap.js');

function flagIf(flag) {
  return process.allowedNodeEnvironmentFlags.has(flag) ? [flag] : [];
}

/** Node-Argumente eines Plugin-Prozesses (exportiert für Tests und Doku). */
function execArgvFor({ dir, memoryMb }) {
  const permission = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  return [
    permission,
    `--allow-fs-read=${BOOTSTRAP}`,
    `--allow-fs-read=${dir}`,
    `--max-old-space-size=${memoryMb}`,
    ...flagIf('--no-addons'),
    ...flagIf('--no-experimental-sqlite'),
    ...flagIf('--disable-sigusr1'),
  ];
}

/** Resident Set Size eines Prozesses in MB (Linux /proc), sonst null. */
function rssMb(pid) {
  if (!pid) return null;
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
  } catch {
    return null;
  }
}

class CallError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class EdgeProcess extends EventEmitter {
  /**
   * @param {object} spec   { id, version, dir, entry, memoryMb }
   * @param {object} hooks  { hostCall(api, args) → Promise, config() → data }
   */
  constructor(spec, { hooks, logger, timing = {}, backoff = RESTART_BACKOFF_MS, now = Date.now } = {}) {
    super();
    this.spec = spec;
    this.id = spec.id;
    this.hooks = hooks;
    this.logger = logger || { info() {}, warn() {}, debug() {} };
    this.timing = { ...TIMING, ...timing };
    this.backoff = backoff;
    this.now = now;
    this.state = 'stopped';  // stopped | starting | running | crashed | stopping
    this.wanted = false;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.hostCalls = 0;
    this.restarts = 0;
    this.backoffIdx = 0;
    this.restartTimer = null;
    this.restartAt = null;
    this.readyTimer = null;
    this.pingTimer = null;
    this.lastPong = 0;
    this.startedAt = 0;
    this.lastError = null;
    this.events = new RateWindow(LIMITS.eventsPerSec, 1000, now);
    this.logs = new RateWindow(LIMITS.logsPerSec, 1000, now);
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  log(level, line) {
    if (!this.logs.take()) return;
    this.emit('log', level, truncateUtf8(line, LIMITS.logLineBytes));
  }

  spawn() {
    if (this.child) return;
    const { dir, entry, memoryMb, id, version } = this.spec;
    const entryPath = path.join(dir, entry);
    if (!entryPath.startsWith(dir + path.sep)) throw new Error('entry outside the plugin folder');
    this.startedAt = this.now();
    this.lastPong = this.now();
    this.setState('starting');
    let child;
    try {
      child = fork(BOOTSTRAP, [], {
        cwd: dir,
        execArgv: execArgvFor({ dir, memoryMb }),
        env: { NODE_ENV: 'production', GC_PLUGIN_ID: id, TZ: process.env.TZ || 'UTC' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'json',
      });
    } catch (e) {
      this.onExit(null, null, e, null);
      return;
    }
    this.child = child;
    const lines = (level) => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.length > 64 * 1024) buf = buf.slice(-64 * 1024);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line && !/ExperimentalWarning|--trace-warnings/.test(line)) this.log(level, line);
        }
      };
    };
    child.stdout.on('data', lines('info'));
    child.stderr.on('data', lines('error'));
    child.on('message', (m) => this.onMessage(m));
    child.on('error', (e) => { this.lastError = e.message; });
    child.on('exit', (code, sig) => this.onExit(code, sig, null, child));
    this.readyTimer = setTimeout(() => {
      if (this.child !== child || this.state !== 'starting') return;
      this.lastError = 'start timeout';
      this.log('error', 'edge part did not start in time');
      try { child.kill('SIGKILL'); } catch { /* weg */ }
    }, this.timing.startTimeoutMs);
    if (this.readyTimer.unref) this.readyTimer.unref();
    let config = null;
    try { config = this.hooks.config ? this.hooks.config() : null; } catch { config = null; }
    this.toChild({ t: 'init', plugin: { id, version, entry: entryPath, config } });
  }

  toChild(msg) {
    if (!this.child || !this.child.connected) return false;
    try { this.child.send(msg); return true; } catch { return false; }
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ready':
        clearTimeout(this.readyTimer);
        this.lastError = null;
        this.startPing();
        this.setState('running');
        this.emit('started');
        break;
      case 'fatal':
        this.lastError = String(m.error || 'start failed').split('\n')[0].slice(0, 300);
        this.log('error', 'start failed: ' + String(m.error || '').slice(0, 1800));
        break;
      case 'log':
        this.log(['info', 'warn', 'error'].includes(m.level) ? m.level : 'info', String(m.line || ''));
        break;
      case 'event':
        if (typeof m.name !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(m.name)) return;
        if (!this.events.take()) return; // > 50/s: verwerfen, Status meldet "throttled"
        this.emit('event', m.name, m.data === undefined ? null : m.data);
        break;
      case 'pong':
        this.lastPong = this.now();
        break;
      case 'result': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value);
        else p.reject(new CallError(typeof m.code === 'string' ? m.code.slice(0, 32) : 'edge_error', String(m.error || 'edge error').slice(0, 500)));
        break;
      }
      case 'host':
        this.onHostCall(m);
        break;
      default:
    }
  }

  onHostCall(m) {
    const reply = (msg) => this.toChild(msg);
    if (this.hostCalls >= LIMITS.hostCallsPerPlugin) {
      reply({ t: 'hostResult', id: m.id, ok: false, error: 'too many concurrent gc calls', code: 'busy' });
      return;
    }
    this.hostCalls++;
    Promise.resolve()
      .then(() => this.hooks.hostCall(String(m.api || ''), m.args && typeof m.args === 'object' ? m.args : {}))
      .then((value) => reply({ t: 'hostResult', id: m.id, ok: true, value: value === undefined ? null : value }),
        (e) => reply({ t: 'hostResult', id: m.id, ok: false, error: String((e && e.message) || e).slice(0, 300),
          code: (e && typeof e.code === 'string') ? e.code : 'edge_error',
          // Zusatzfelder des Edge-Hosts (NetError.data, z. B. sha256 bei tls_pin_mismatch)
          ...(e && e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? { data: e.data } : {}) }))
      .finally(() => { this.hostCalls--; });
  }

  startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.child || this.state !== 'running') return;
      if (this.now() - this.lastPong > this.timing.childDeadMs) {
        this.log('error', 'edge part stopped answering — restarting');
        try { this.child.kill('SIGKILL'); } catch { /* weg */ }
        return;
      }
      this.toChild({ t: 'ping', id: ++this.seq });
    }, this.timing.childPingMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  clearTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.readyTimer);
    this.pingTimer = null;
    this.readyTimer = null;
  }

  /** Nächste Wartezeit nach einem Absturz (exportiert für Tests). */
  nextBackoff() {
    if (this.startedAt && this.now() - this.startedAt > this.timing.stableAfterMs) this.backoffIdx = 0;
    const d = this.backoff[Math.min(this.backoffIdx, this.backoff.length - 1)];
    this.backoffIdx++;
    return d;
  }

  onExit(code, sig, err, child) {
    if (child && this.child !== child) return;
    this.child = null;
    this.clearTimers();
    this.emit('exit');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CallError('not_running', 'edge part ended'));
    }
    this.pending.clear();
    if (this.stopResolve) { const r = this.stopResolve; this.stopResolve = null; r(); }
    if (!this.wanted) { this.setState('stopped'); return; }
    this.restarts++;
    const delay = this.nextBackoff();
    this.lastError = this.lastError || (err ? err.message : `exited (${sig || code})`);
    this.log('error', `process ended (${sig || code}) — restart in ${Math.round(delay / 1000)} s`);
    this.setState('crashed');
    this.restartAt = this.now() + delay;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartAt = null;
      if (this.wanted) { try { this.spawn(); } catch (e) { this.onExit(null, null, e, null); } }
    }, delay);
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  start() {
    this.wanted = true;
    if (this.child || this.restartTimer) return;
    this.backoffIdx = 0;
    this.lastError = null;
    this.spawn();
  }

  stop() {
    this.wanted = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; this.restartAt = null; }
    const child = this.child;
    if (!child) { this.setState('stopped'); return Promise.resolve(); }
    this.setState('stopping');
    return new Promise((resolve) => {
      this.stopResolve = resolve;
      this.toChild({ t: 'stop' });
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* weg */ } }, this.timing.stopGraceMs);
      if (t.unref) t.unref();
    });
  }

  /** Aufruf an gc.handle(method) des Edge-Teils. */
  call(method, params, timeoutMs = LIMITS.callTimeoutDefaultMs) {
    if (this.state !== 'running' || !this.child) return Promise.reject(new CallError('not_running', 'edge part is not running'));
    if (this.pending.size >= LIMITS.openCallsPerPlugin) return Promise.reject(new CallError('busy', 'too many open calls'));
    const limit = Math.max(1, Math.min(LIMITS.callTimeoutMaxMs, Number.isFinite(timeoutMs) ? timeoutMs : LIMITS.callTimeoutDefaultMs));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CallError('timeout', 'edge part did not answer in time')); }, limit);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.toChild({ t: 'call', id, method, params: params === undefined ? null : params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CallError('not_running', 'edge part is not running'));
      }
    });
  }

  configure(data) { this.toChild({ t: 'configure', data }); }

  info() {
    return {
      state: this.state,
      pid: this.child ? this.child.pid : null,
      restarts: this.restarts,
      lastError: this.lastError,
      rssMb: rssMb(this.child && this.child.pid),
      restartAt: this.restartAt ? new Date(this.restartAt).toISOString() : null,
    };
  }
}

module.exports = { EdgeProcess, execArgvFor, rssMb, BOOTSTRAP, CallError };
