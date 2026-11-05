'use strict';

// Docker-HEALTHCHECK des Edge-Containers: der Edge-Host schreibt seine
// Zusammenfassung mindestens alle 30 s; ist sie älter als 2 min, hängt er.

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./constants');

try {
  const st = fs.statSync(path.join(paths().statusDir, 'status.json'));
  process.exit(Date.now() - st.mtimeMs < 120000 ? 0 : 1);
} catch {
  process.exit(1);
}
