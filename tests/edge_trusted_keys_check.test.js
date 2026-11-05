'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { extractServerKeys, compare } = require('../scripts/check-edge-trusted-keys');

test('Server-Schlüssel aus constants.js lesen und vergleichen', () => {
  const src = `const BUILTIN_PUBLIC_KEYS = Object.freeze([\n  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // eins\n  "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",\n]);\nconst LIMITS = 1;`;
  const keys = extractServerKeys(src);
  assert.deepStrictEqual(keys, ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=']);
  assert.deepStrictEqual(compare(keys, [...keys].reverse()), { missing: [], extra: [] });
  assert.deepStrictEqual(compare(keys, [keys[0]]), { missing: [keys[1]], extra: [] });
  assert.deepStrictEqual(compare([keys[0]], keys), { missing: [], extra: [keys[1]] });
  assert.throws(() => extractServerKeys('nichts'));
});
