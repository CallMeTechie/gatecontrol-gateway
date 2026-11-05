'use strict';

/** "AA-BB-CC-DD-EE-FF" / "aabb.ccdd.eeff" / … → "aa:bb:cc:dd:ee:ff" oder null. */
function normalizeMac(mac) {
  if (typeof mac !== 'string') return null;
  const hex = mac.replace(/[:\-.\s]/g, '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex.match(/../g).join(':');
}

module.exports = { normalizeMac };
