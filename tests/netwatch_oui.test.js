'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeOuiLookup } = require('../src/netwatch/oui');
const { parseCsv, cleanName, build } = require('../scripts/update-oui');

describe('OUI lookup', () => {
  it('finds vendors in the shipped list', () => {
    const o = makeOuiLookup();
    assert.ok(o.size() > 30000, `only ${o.size()} entries`);
    assert.equal(o.lookup('00:11:32:aa:bb:01'), 'Synology');
    assert.equal(o.lookup('24-0A-C4-9F-12-AA'), 'Espressif');
    assert.equal(o.lookup('ff:ff:ff:00:00:00'), null);
    assert.equal(o.lookup('nonsense'), null);
  });

  it('binary search over a small file incl. first/last entry and comments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oui-'));
    const f = path.join(dir, 'oui.txt');
    fs.writeFileSync(f, '# Kommentar\n000000\tFirst\n00AA00\tMiddle Ünïcode\nFFFFFE\tLast\n');
    const o = makeOuiLookup(f);
    assert.equal(o.lookup('00:00:00:12:34:56'), 'First');
    assert.equal(o.lookup('00:aa:00:00:00:00'), 'Middle Ünïcode');
    assert.equal(o.lookup('ff:ff:fe:00:00:00'), 'Last');
    assert.equal(o.lookup('00:aa:01:00:00:00'), null);
    assert.equal(o.size(), 3);
  });

  it('missing file → null, no throw', () => {
    const o = makeOuiLookup('/nonexistent/oui.txt');
    assert.equal(o.lookup('00:11:32:00:00:00'), null);
  });
});

describe('scripts/update-oui.js', () => {
  it('parses quoted CSV and strips legal forms', () => {
    assert.deepEqual(parseCsv('a,"b, c","d ""e"""\n1,2,3\n'), [['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
    assert.equal(cleanName('Apple, Inc.'), 'Apple');
    assert.equal(cleanName('Samsung Electronics Co.,Ltd'), 'Samsung Electronics');
    assert.equal(cleanName('AVM Audiovisuelles Marketing und Computersysteme GmbH'), 'AVM Audiovisuelles Marketing und Computersysteme'.slice(0, 48).trim());
    assert.equal(cleanName('Espressif Inc.'), 'Espressif');
  });

  it('builds sorted MA-L lines only', () => {
    const csv = 'Registry,Assignment,Organization Name,Organization Address\n'
      + 'MA-L,B0C090,"Example Corp.",x\nMA-M,001122,Other,x\nMA-L,0011AA,"Foo, Inc.",x\nMA-L,zzzzzz,Bad,x\n';
    assert.deepEqual(build(csv), ['0011AA\tFoo', 'B0C090\tExample']);
  });
});
