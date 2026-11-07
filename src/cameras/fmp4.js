'use strict';

// Fragmentiertes MP4 (die HLS-Segmente von ffmpeg) ohne Umkodieren
// zusammensetzen: Zeitstempel (tfdt) auf 0 setzen, Gesamtdauer (mehd) in die
// Init-Daten schreiben, Codec-Text für den Browser (avc1.PPCCLL). Nur Lesen und
// Zahlen ändern – keine Bilddaten werden angefasst.

class Mp4Error extends Error {
  constructor(message) { super(message); this.code = 'bad_mp4'; }
}

/** Boxen in buf[start, end) → [{ type, start, size, body }] (body = Beginn des Inhalts) */
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    let head = 8;
    if (size === 1) {
      if (i + 16 > end) throw new Mp4Error('short largesize');
      const big = buf.readBigUInt64BE(i + 8);
      if (big > BigInt(end - i)) throw new Mp4Error('box too large');
      size = Number(big);
      head = 16;
    } else if (size === 0) size = end - i;
    if (size < head || i + size > end) throw new Mp4Error('bad box size');
    out.push({ type, start: i, size, body: i + head });
    i += size;
  }
  return out;
}

const childOf = (buf, box, type, skip = 0) => boxes(buf, box.body + skip, box.start + box.size).find((b) => b.type === type) || null;

/** Zeitskala aus mvhd/mdhd (Version 0/1). */
function timescaleOf(buf, box) {
  const v = buf[box.body];
  return buf.readUInt32BE(box.body + (v === 1 ? 20 : 12));
}

function hex2(n) { return n.toString(16).padStart(2, '0'); }

function codecOf(buf, stsd) {
  // stsd: Version/Flags (4) + Anzahl (4), dann die Sample-Einträge
  const entries = boxes(buf, stsd.body + 8, stsd.start + stsd.size);
  const e = entries[0];
  if (!e) return null;
  if (e.type === 'avc1' || e.type === 'avc3') {
    const avcC = boxes(buf, e.body + 78, e.start + e.size).find((b) => b.type === 'avcC');
    if (!avcC) return e.type;
    return `${e.type}.${hex2(buf[avcC.body + 1])}${hex2(buf[avcC.body + 2])}${hex2(buf[avcC.body + 3])}`;
  }
  if (e.type === 'hvc1' || e.type === 'hev1') {
    const hvcC = boxes(buf, e.body + 78, e.start + e.size).find((b) => b.type === 'hvcC');
    if (!hvcC) return e.type;
    const b = hvcC.body;
    const profile = buf[b + 1] & 0x1f;
    const tier = (buf[b + 1] >> 5) & 1 ? 'H' : 'L';
    const level = buf[b + 12];
    return `${e.type}.${profile}.6.${tier}${level}.B0`;
  }
  if (e.type === 'mp4a') return 'mp4a.40.2';
  return e.type;
}

/** Init-Segment → { movieTimescale, tracks: [{ id, timescale, handler, codec }] } */
function initInfo(buf) {
  const moov = boxes(buf).find((b) => b.type === 'moov');
  if (!moov) throw new Mp4Error('no moov');
  const mvhd = childOf(buf, moov, 'mvhd');
  const tracks = [];
  for (const trak of boxes(buf, moov.body, moov.start + moov.size).filter((b) => b.type === 'trak')) {
    const tkhd = childOf(buf, trak, 'tkhd');
    const mdia = childOf(buf, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const id = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12));
    const mdhd = childOf(buf, mdia, 'mdhd');
    const hdlr = childOf(buf, mdia, 'hdlr');
    const minf = childOf(buf, mdia, 'minf');
    const stbl = minf && childOf(buf, minf, 'stbl');
    const stsd = stbl && childOf(buf, stbl, 'stsd');
    tracks.push({
      id,
      timescale: mdhd ? timescaleOf(buf, mdhd) : null,
      handler: hdlr ? buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) : null,
      codec: stsd ? codecOf(buf, stsd) : null,
    });
  }
  return { movieTimescale: mvhd ? timescaleOf(buf, mvhd) : 1000, tracks };
}

/** Codec-Angabe für MediaSource/HLS: 'avc1.64001f, mp4a.40.2' */
function codecsString(info) {
  return info.tracks.map((t) => t.codec).filter(Boolean).join(', ');
}

/** Für jeden traf eines Segments: [{ trackId, tfdtOffset, version, value (BigInt) }] */
function tfdtsOf(buf) {
  const out = [];
  for (const moof of boxes(buf).filter((b) => b.type === 'moof')) {
    for (const traf of boxes(buf, moof.body, moof.start + moof.size).filter((b) => b.type === 'traf')) {
      const tfhd = childOf(buf, traf, 'tfhd');
      const tfdt = childOf(buf, traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const version = buf[tfdt.body];
      const off = tfdt.body + 4;
      const value = version === 1 ? buf.readBigUInt64BE(off) : BigInt(buf.readUInt32BE(off));
      out.push({ trackId: buf.readUInt32BE(tfhd.body + 4), tfdtOffset: off, version, value });
    }
  }
  return out;
}

/** Erste Zeitstempel je Spur eines Segments → Map(trackId → BigInt) */
function firstTimes(buf) {
  const m = new Map();
  for (const t of tfdtsOf(buf)) if (!m.has(t.trackId)) m.set(t.trackId, t.value);
  return m;
}

/**
 * Kopie des Segments ohne styp/sidx (deren Zeiten passen nach dem Zusammenfügen
 * nicht mehr – Spieler nähmen sonst die Dauer daraus) mit tfdt − base[trackId] (nie unter 0).
 */
function rebase(buf, base) {
  const keep = boxes(buf).filter((b) => b.type !== 'styp' && b.type !== 'sidx');
  const out = Buffer.concat(keep.map((b) => buf.subarray(b.start, b.start + b.size)));
  for (const t of tfdtsOf(out)) {
    const b = base.get(t.trackId);
    if (b === undefined) continue;
    let v = t.value - b;
    if (v < 0n) v = 0n;
    if (t.version === 1) out.writeBigUInt64BE(v, t.tfdtOffset);
    else out.writeUInt32BE(Number(v & 0xffffffffn), t.tfdtOffset);
  }
  return out;
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

/**
 * Init-Segment mit mehd (Version 1, 64-bit-Dauer) in mvex; Größen von mvex und
 * moov angepasst. → { buf, durationOffset } (dort später die Dauer in
 * Film-Zeitskala eintragen: buf.writeBigUInt64BE(ticks, durationOffset)).
 */
function withMehd(init, ticks = 0n) {
  const top = boxes(init);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov || moov.body - moov.start !== 8) throw new Mp4Error('no plain moov');
  const inner = boxes(init, moov.body, moov.start + moov.size);
  const mvex = inner.find((b) => b.type === 'mvex');
  if (!mvex || mvex.body - mvex.start !== 8) throw new Mp4Error('no mvex');
  const mehd = Buffer.concat([u32(20), Buffer.from('mehd', 'latin1'), Buffer.from([1, 0, 0, 0]), Buffer.alloc(8)]);
  mehd.writeBigUInt64BE(BigInt(ticks), 12);
  const mvexKids = boxes(init, mvex.body, mvex.start + mvex.size).filter((b) => b.type !== 'mehd');
  const newMvex = Buffer.concat([u32(0), Buffer.from('mvex', 'latin1'), mehd, ...mvexKids.map((b) => init.subarray(b.start, b.start + b.size))]);
  newMvex.writeUInt32BE(newMvex.length, 0);
  const parts = inner.map((b) => (b === mvex ? newMvex : init.subarray(b.start, b.start + b.size)));
  const newMoov = Buffer.concat([u32(0), Buffer.from('moov', 'latin1'), ...parts]);
  newMoov.writeUInt32BE(newMoov.length, 0);
  const before = Buffer.concat(top.filter((b) => b.start < moov.start).map((b) => init.subarray(b.start, b.start + b.size)));
  const after = Buffer.concat(top.filter((b) => b.start > moov.start).map((b) => init.subarray(b.start, b.start + b.size)));
  // Lage der Dauer: vor moov + moov-Kopf + Kinder vor mvex + mvex-Kopf + mehd-Kopf (12)
  let off = before.length + 8;
  for (const b of inner) { if (b === mvex) break; off += b.size; }
  off += 8 + 12;
  return { buf: Buffer.concat([before, newMoov, after]), durationOffset: off };
}

module.exports = { boxes, initInfo, codecsString, tfdtsOf, firstTimes, rebase, withMehd, Mp4Error };
