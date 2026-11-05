'use strict';

// Zeitpläne in Ortszeit (Umgebungsvariable TZ des Containers; ohne TZ = UTC).
// Die Zufallsminute verteilt viele Gateways über die Zeit.

function atLocal(baseMs, dayOffset, hour, minute) {
  const d = new Date(baseMs);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** Nächster nächtlicher Portscan: 02:00–04:59 Ortszeit, Zufallsminute. */
function nextNightly(fromMs, rand = Math.random, { startHour = 2, windowMin = 180 } = {}) {
  const m = Math.floor(rand() * windowMin);
  const today = atLocal(fromMs, 0, startHour, m);
  return today > fromMs ? today : atLocal(fromMs, 1, startHour, m);
}

/**
 * Nächster geplanter Speedtest. '4x' = 00/06/12/18 Uhr + Zufallsminute,
 * 'hourly' = jede Stunde + Zufallsminute, sonst null.
 */
function nextSpeedtest(plan, fromMs, rand = Math.random) {
  const m = Math.floor(rand() * 60);
  if (plan === 'hourly') {
    const d = new Date(fromMs);
    d.setMinutes(m, 0, 0);
    let t = d.getTime();
    while (t <= fromMs) t += 3600_000;
    return t;
  }
  if (plan === '4x') {
    for (let day = 0; day <= 1; day++) {
      for (const h of [0, 6, 12, 18]) {
        const t = atLocal(fromMs, day, h, m);
        if (t > fromMs) return t;
      }
    }
  }
  return null;
}

module.exports = { nextNightly, nextSpeedtest, atLocal };
