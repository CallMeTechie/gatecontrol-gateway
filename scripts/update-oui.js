#!/usr/bin/env node
'use strict';

// Erzeugt src/netwatch/oui.txt (Hersteller je MAC-Präfix, offline im Image)
// aus der öffentlichen IEEE-Liste der MA-L-Zuteilungen (24-Bit-OUI).
//
//   curl -fsSLo /tmp/oui.csv https://standards-oui.ieee.org/oui/oui.csv
//   node scripts/update-oui.js /tmp/oui.csv
//
// Lädt nichts herunter. Ausgabe: sortierte Zeilen "AABBCC<TAB>Hersteller",
// Rechtsformen wie "Inc." / "Co., Ltd." gekürzt, höchstens 48 Zeichen, nur
// druckbare Zeichen. Gleiche Eingabe → gleiche Datei (Diff zeigt nur echte
// Änderungen). Die Datei wird von src/netwatch/oui.js gelesen.

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'src', 'netwatch', 'oui.txt');
const MAX_NAME = 48;

/** Minimaler CSV-Parser (RFC 4180: Anführungszeichen, "" als Escape, Zeilenumbrüche in Feldern). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Rechtsformen am Ende des Namens (wiederholt angewendet: "Foo Co., Ltd." → "Foo").
const SUFFIX = /[\s,.]*\b(?:inc|incorporated|corp|corporation|co|company|ltd|limited|llc|l\.l\.c|gmbh|ag|kg|s\.?a|s\.?p\.?a|s\.?r\.?l|b\.?v|n\.?v|pty|oy|ab|a\/s|as|sas|s\.?a\.?s|s\.?l|plc|pte|bhd|sdn|kk|k\.k|co\.ltd)\b\.?\s*$/i;

function cleanName(raw) {
  let n = String(raw).replace(/[^\x20-\x7e\u00a0-\u024f]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const next = n.replace(SUFFIX, '').replace(/[\s,.&-]+$/, '').trim();
    if (!next || next === n) break;
    n = next;
  }
  if (n.length > MAX_NAME) n = n.slice(0, MAX_NAME).trim();
  return n;
}

function build(csvText) {
  const rows = parseCsv(csvText);
  const header = rows.shift() || [];
  const iReg = header.indexOf('Registry');
  const iHex = header.indexOf('Assignment');
  const iName = header.indexOf('Organization Name');
  if (iReg < 0 || iHex < 0 || iName < 0) throw new Error('unexpected CSV header: ' + header.join(','));
  const map = new Map();
  for (const r of rows) {
    if (r[iReg] !== 'MA-L') continue;
    const hex = String(r[iHex] || '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(hex)) continue;
    const name = cleanName(r[iName]);
    if (name && !map.has(hex)) map.set(hex, name);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([h, n]) => `${h}\t${n}`);
}

if (require.main === module) {
  const src = process.argv[2];
  if (!src) { console.error('usage: node scripts/update-oui.js <oui.csv>'); process.exit(2); }
  const lines = build(fs.readFileSync(src, 'utf8'));
  if (lines.length < 10000) { console.error(`only ${lines.length} entries — wrong file?`); process.exit(1); }
  const head = [
    '# Hersteller je MAC-Präfix (IEEE MA-L), erzeugt mit scripts/update-oui.js',
    `# Quelle: https://standards-oui.ieee.org/oui/oui.csv (IEEE Registration Authority, öffentliche Liste), Stand ${new Date().toISOString().slice(0, 10)}`,
    `# ${lines.length} Einträge; Format: AABBCC<TAB>Name, sortiert`,
  ];
  fs.writeFileSync(OUT, head.concat(lines).join('\n') + '\n');
  console.log(`${OUT}: ${lines.length} Einträge, ${fs.statSync(OUT).size} Bytes`);
}

module.exports = { parseCsv, cleanName, build };
