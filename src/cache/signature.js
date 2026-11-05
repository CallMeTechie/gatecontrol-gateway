'use strict';

// Freigabe eines Blobs im LAN (Vertrag Phase 3b §2.2):
//   sig = HMAC-SHA256(secret, sha256 + '\n' + exp)  (hex)
// `exp` = Unix-Sekunden, höchstens 10 Min. in der Zukunft (+ 60 s Uhrenabweichung).
// Vergleich in konstanter Zeit.

const crypto = require('node:crypto');

const SHA_RE = /^[0-9a-f]{64}$/;
const EXP_RE = /^[0-9]{1,12}$/;
const SIG_RE = /^[0-9a-fA-F]{64}$/;
const MAX_AHEAD_S = 600;
const SKEW_S = 60;

function sign(secret, sha256, exp) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(`${sha256}\n${exp}`, 'utf8').digest('hex');
}

/** → 'ok' | 'bad_request' | 'expired' | 'too_far' | 'bad_signature' */
function verify(secret, sha256, exp, sig, nowMs = Date.now()) {
  if (!secret || typeof sha256 !== 'string' || !SHA_RE.test(sha256)) return 'bad_request';
  if (typeof exp !== 'string' || !EXP_RE.test(exp) || typeof sig !== 'string' || !SIG_RE.test(sig)) return 'bad_request';
  const e = Number(exp);
  const now = Math.floor(nowMs / 1000);
  if (e < now) return 'expired';
  if (e > now + MAX_AHEAD_S + SKEW_S) return 'too_far';
  const want = Buffer.from(sign(secret, sha256, exp), 'hex');
  const got = Buffer.from(sig.toLowerCase(), 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return 'bad_signature';
  return 'ok';
}

module.exports = { sign, verify, SHA_RE, MAX_AHEAD_S, SKEW_S };
