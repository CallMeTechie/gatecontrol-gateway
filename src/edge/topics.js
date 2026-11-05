'use strict';

// MQTT-Themen und -Filter (MQTT 3.1.1, Abschnitt 4.7): Prüfung der Filter
// aus Manifest/Sollzustand und die Frage "deckt der genehmigte Filter A den
// angefragten Filter/das Thema B ab?" – zentral im Edge-Host, nie im Plugin.

const MAX_LEN = 256;

function validFilter(f) {
  if (typeof f !== 'string' || f.length === 0 || f.length > MAX_LEN) return false;
  if (/[\0\r\n]/.test(f)) return false;
  const levels = f.split('/');
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    if (l === '#') { if (i !== levels.length - 1) return false; continue; }
    if (l === '+') continue;
    if (l.includes('#') || l.includes('+')) return false;
  }
  return true;
}

function validTopic(t) {
  return typeof t === 'string' && t.length > 0 && t.length <= MAX_LEN && !/[\0\r\n#+]/.test(t);
}

/**
 * Regeln des Vertrags (Abschnitt 4) für Plugin-Themen: gültiger Filter,
 * nicht mit `#`/`+` beginnend, kein `$`-Thema (z. B. `$SYS`).
 */
function validPluginFilter(f) {
  return validFilter(f) && !f.startsWith('#') && !f.startsWith('+') && !f.startsWith('$');
}

/** Passt das Thema `topic` auf den Filter `filter`? */
function matches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  // $-Themen passen nie auf Filter, die mit Platzhaltern beginnen
  if (topic.startsWith('$') && (f[0] === '#' || f[0] === '+')) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** Deckt der Filter `outer` alles ab, was der Filter `inner` liefern kann? */
function covers(outer, inner) {
  const o = outer.split('/');
  const n = inner.split('/');
  for (let i = 0; i < o.length; i++) {
    if (o[i] === '#') return true;
    if (i >= n.length) return false;
    if (n[i] === '#') return false;            // inner breiter als outer
    if (o[i] === '+') continue;
    if (n[i] === '+' || n[i] !== o[i]) return false;
  }
  return o.length === n.length;
}

module.exports = { validFilter, validTopic, validPluginFilter, matches, covers, MAX_LEN };
