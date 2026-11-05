'use strict';

// Kleine JSON-Zustandsdateien im State-Verzeichnis (/state, überlebt Neustart
// und Update). Schreiben atomar (temporäre Datei + rename); Fehler werden
// gemeldet, aber nie geworfen – ein schreibgeschütztes /state darf keine
// Funktion lahmlegen.

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');

function readJson(dir, name, maxBytes = 4 * 1024 * 1024) {
  let fd = null;
  try {
    // Über einen Deskriptor: Größe und Inhalt stammen sicher von derselben Datei.
    fd = fs.openSync(path.join(dir, name), 'r');
    if (fs.fstatSync(fd).size > maxBytes) return null;
    const v = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_e) {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_e) { /* zu */ }
  }
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.debug({ err: err.message, file }, 'state write failed');
    try { fs.unlinkSync(tmp); } catch (_e) { /* nicht angelegt */ }
    return false;
  }
}

module.exports = { readJson, writeJson };
