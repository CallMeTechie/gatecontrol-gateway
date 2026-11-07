'use strict';

// Ablage der Blobs unter `path` (Vertrag Phase 3b §2.2): Dateiname = sha256
// (64 Hex-Zeichen, sonst nichts – kein Pfad aus Eingaben), Verzeichnis
// flach. Index mit Größe, Art und letzter Abgabe (LRU) in .gc-index.json.
// Fremde Dateien im Ordner bleiben unberührt.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setImmediate: tick } = require('node:timers/promises');
const { SHA_RE } = require('./signature');

const INDEX = '.gc-index.json';
const MAX_ITEMS = 50_000;
const PART_MAX_AGE_MS = 7 * 86_400_000;
const SLICE_MS = 10;            // so lange am Stück rechnen, dann die Ereignisschleife freigeben

// Kleiner Rang zuerst (-Infinity = „nicht mehr gewollt“), bei Gleichstand LRU.
const byRank = (a, b) => (a.r === b.r ? a.used - b.used : a.r < b.r ? -1 : 1);

/**
 * Räumungsreihenfolge, einmal je Abgleich berechnet: Kandidaten nach Rang und
 * LRU sortiert, dazu Präfixsummen der Größen. Eine Platzanfrage kostet damit
 * O(log n) (binäre Suche + Summenvergleich), statt bei jedem gewollten Blob
 * den ganzen Bestand neu zu ranken und zu sortieren. Geräumt wird immer vom
 * Anfang der Liste – Einträge, die inzwischen weg sind, werden übersprungen.
 */
class EvictionPlan {
  constructor(store, cands) {
    this.store = store;
    this.cands = cands;
    this.head = 0;
    this.sum = new Float64Array(cands.length + 1);
    for (let i = 0; i < cands.length; i++) this.sum[i + 1] = this.sum[i] + cands[i].size;
  }

  /** Erster Index ab `head` mit Rang ≥ below. */
  _end(below) {
    let lo = this.head;
    let hi = this.cands.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.cands[m].r < below) lo = m + 1; else hi = m;
    }
    return lo;
  }

  /**
   * Platz für `bytes` schaffen, sodass usedBytes + bytes ≤ limit; geräumt
   * werden nur Kandidaten mit Rang < below. Reicht es nicht, bleibt alles.
   */
  async makeRoom(bytes, limit, below = Infinity) {
    const s = this.store;
    let free = limit - s.usedBytes;
    if (free >= bytes) return true;
    const end = this._end(below);
    // Obergrenze (Weggefallene zählen noch mit): reicht selbst die nicht → sofort nein.
    if (free + this.sum[end] - this.sum[this.head] < bytes) return false;
    const victims = [];
    let i = this.head;
    for (; i < end && free < bytes; i++) {
      const it = s.items.get(this.cands[i].sha);
      if (!it) continue;
      victims.push(this.cands[i].sha);
      free += it.size;
    }
    if (free < bytes) return false;
    this.head = i;
    for (const sha of victims) await s.remove(sha);
    return true;
  }
}

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) h.update(c);
  return h.digest('hex');
}

class BlobStore {
  constructor({ dir, now = Date.now }) {
    this.dir = dir;
    this.now = now;
    this.items = new Map(); // sha → { size, kind, storedAt, lastUsedAt }
    this.usedBytes = 0;
    this.added = new Set();
    this.removed = new Set();
    this.dirty = false;
    this.opened = false;
    this.gen = 0;             // zählt synchrone Schreibvorgänge (persist)
    this.saving = null;
    this.saveNext = null;
  }

  /** Nur gültige sha256-Namen → Pfad im Ablageordner; sonst wirft. */
  filePath(sha) {
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error('bad sha256');
    const root = path.resolve(this.dir);
    const file = path.resolve(root, sha);
    if (!file.startsWith(root + path.sep)) throw new Error('bad sha256');
    return file;
  }

  partPath(sha) {
    return `${this.filePath(sha)}.part`;
  }

  has(sha) { return this.items.has(sha); }

  get(sha) { return this.items.get(sha) || null; }

  get count() { return this.items.size; }

  _set(sha, v) {
    const old = this.items.get(sha);
    if (old) this.usedBytes -= old.size;
    this.items.set(sha, v);
    this.usedBytes += v.size;
    this.dirty = true;
  }

  _unset(sha) {
    const old = this.items.get(sha);
    if (!old) return;
    this.items.delete(sha);
    this.usedBytes -= old.size;
    this.dirty = true;
  }

  /** Ordner anlegen, Index laden, mit dem Inhalt abgleichen. Wirft, wenn nicht beschreibbar. */
  async open() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o750 });
    await fsp.access(this.dir, fs.constants.W_OK);
    let idx = {};
    try {
      const fh = await fsp.open(path.join(this.dir, INDEX), 'r');
      try {
        if ((await fh.stat()).size < 32 * 1024 * 1024) idx = JSON.parse(await fh.readFile('utf8')).items || {};
      } finally { await fh.close(); }
    } catch (_e) { /* neu */ }
    this.items.clear();
    this.usedBytes = 0;
    const unknown = [];
    for (const name of await fsp.readdir(this.dir)) {
      if (SHA_RE.test(name)) {
        let st;
        try { st = await fsp.lstat(path.join(this.dir, name)); } catch (_e) { continue; }
        if (!st.isFile()) continue;
        const e = idx[name];
        if (e && e.size === st.size && this.items.size < MAX_ITEMS) {
          this._set(name, { size: st.size, kind: typeof e.kind === 'string' ? e.kind.slice(0, 16) : null, storedAt: Number(e.storedAt) || st.mtimeMs, lastUsedAt: Number(e.lastUsedAt) || 0 });
        } else {
          unknown.push({ name, size: st.size, mtimeMs: st.mtimeMs });
        }
      } else if (/^[0-9a-f]{64}\.part$/.test(name)) {
        try {
          const st = await fsp.lstat(path.join(this.dir, name));
          if (this.now() - st.mtimeMs > PART_MAX_AGE_MS) await fsp.rm(path.join(this.dir, name), { force: true });
        } catch (_e) { /* weg */ }
      }
    }
    // Blobs ohne Index-Eintrag (Absturz zwischen Umbenennen und Index): Inhalt prüfen.
    for (const u of unknown) {
      const file = path.join(this.dir, u.name);
      try {
        if (this.items.size < MAX_ITEMS && (await sha256File(file)) === u.name) {
          this._set(u.name, { size: u.size, kind: null, storedAt: u.mtimeMs, lastUsedAt: 0 });
        } else {
          await fsp.rm(file, { force: true });
        }
      } catch (_e) { /* später */ }
    }
    this.opened = true;
    await this.save();
  }

  touch(sha) {
    const e = this.items.get(sha);
    if (e) { e.lastUsedAt = this.now(); this.dirty = true; }
  }

  /** Fertigen .part-Download übernehmen. */
  async commit(sha, size, kind) {
    await fsp.rename(this.partPath(sha), this.filePath(sha));
    this._set(sha, { size, kind, storedAt: this.now(), lastUsedAt: 0 });
    this.added.add(sha);
    this.removed.delete(sha);
  }

  async remove(sha) {
    if (!this.items.has(sha)) return;
    this._unset(sha);
    this.removed.add(sha);
    this.added.delete(sha);
    await fsp.rm(this.filePath(sha), { force: true });
  }

  /**
   * Räumungsreihenfolge einmal festlegen. `rank(sha, item)` → Zahl (kleiner =
   * zuerst raus, -Infinity erlaubt) oder null (geschützt).
   */
  evictionPlan(rank) {
    const cands = [];
    for (const [sha, it] of this.items) {
      const r = rank(sha, it);
      if (r !== null) cands.push({ sha, r, used: it.lastUsedAt || it.storedAt || 0, size: it.size });
    }
    cands.sort(byRank);
    return new EvictionPlan(this, cands);
  }

  /**
   * Platz für `bytes` schaffen, sodass usedBytes + bytes ≤ limit.
   * `rank(sha, item)` → Zahl (kleiner = zuerst raus) oder null (geschützt).
   * Für viele Anfragen hintereinander `evictionPlan()` nehmen.
   */
  async makeRoom(bytes, limit, rank) {
    if (this.usedBytes + bytes <= limit) return true;
    return this.evictionPlan(rank).makeRoom(bytes, limit);
  }

  async clear() {
    for (const sha of [...this.items.keys()]) await this.remove(sha);
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      if (/^[0-9a-f]{64}\.part$/.test(name)) await fsp.rm(path.join(this.dir, name), { force: true });
    }
    await this.save();
  }

  /**
   * Index sofort und synchron schreiben – nur beim Abschalten/Umziehen. Im
   * laufenden Betrieb `save()` nehmen.
   */
  persist() {
    if (!this.dirty || !this.opened) return;
    this.dirty = false;
    this.gen++;
    const file = path.join(this.dir, INDEX);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, items: Object.fromEntries(this.items) }), { mode: 0o640 });
      fs.renameSync(tmp, file);
    } catch (_e) {
      this.dirty = true;
    }
  }

  /**
   * Index asynchron schreiben, JSON in Häppchen mit Pausen für die
   * Ereignisschleife (bei 20 000+ Einträgen sonst ein spürbarer Block).
   * Überlappende Aufrufe: höchstens ein Folgelauf, der den neuesten Stand schreibt.
   */
  save() {
    if (this.saving) {
      if (!this.saveNext) this.saveNext = this.saving.then(() => { this.saveNext = null; return this.save(); });
      return this.saveNext;
    }
    if (!this.dirty || !this.opened) return Promise.resolve();
    this.saving = this._writeIndex().finally(() => { this.saving = null; });
    return this.saving;
  }

  async _writeIndex() {
    this.dirty = false;
    const gen = this.gen;
    const file = path.join(this.dir, INDEX);
    const tmp = `${file}.tmp-async`;
    const entries = [...this.items];
    const parts = new Array(entries.length);
    let at = performance.now();
    for (let i = 0; i < entries.length; i++) {
      parts[i] = `${JSON.stringify(entries[i][0])}:${JSON.stringify(entries[i][1])}`;
      if ((i & 511) === 511 && performance.now() - at >= SLICE_MS) { await tick(); at = performance.now(); }
    }
    try {
      await fsp.writeFile(tmp, `{"v":1,"items":{${parts.join(',')}}}`, { mode: 0o640 });
      // In der Zwischenzeit synchron geschrieben (Abschalten) → dessen Stand ist neuer.
      if (gen !== this.gen) { await fsp.rm(tmp, { force: true }); return; }
      await fsp.rename(tmp, file);
    } catch (_e) {
      this.dirty = true;
    }
  }

  freeBytes() {
    try {
      const st = fs.statfsSync(this.dir);
      return st.bavail * st.bsize;
    } catch (_e) {
      return null;
    }
  }
}

module.exports = { BlobStore, EvictionPlan, sha256File, MAX_ITEMS, SLICE_MS };
