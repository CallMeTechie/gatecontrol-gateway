'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { parseListText, parseListStream, countLines, hashDomainBytes, ListTooLarge } = require('../src/dns/listParser');
const { hash53, CompactList, PatternSet, HashBuilder, cleanDomain, suffixes } = require('../src/dns/domainSet');

describe('dns: domain sets', () => {
  it('hash53 is stable, 53-bit and matches the byte hasher', () => {
    const h = hash53('ads.example.com');
    assert.equal(h, hash53('ads.example.com'));
    assert.ok(Number.isSafeInteger(h) && h >= 0);
    assert.notEqual(h, hash53('ads.example.org'));
    assert.equal(hashDomainBytes(Buffer.from('ADS.Example.COM.'), 0, 16), h);
  });

  it('cleanDomain lowercases, strips the root dot, converts IDN, rejects junk', () => {
    assert.equal(cleanDomain('WWW.Example.COM.'), 'www.example.com');
    assert.equal(cleanDomain('bücher.de'), 'xn--bcher-kva.de');
    assert.equal(cleanDomain('localhost'), null);
    assert.equal(cleanDomain('localhost', { allowSingleLabel: true }), 'localhost');
    for (const bad of ['', 'a..b', '-a.com', 'a-.com', 'a b.com', 'a/b.com', 'x'.repeat(64) + '.com', 7, null]) {
      assert.equal(cleanDomain(bad), null, String(bad));
    }
    assert.deepEqual(suffixes('a.b.c'), ['a.b.c', 'b.c', 'c']);
  });

  it('PatternSet: plain = domain + subdomains, *. = subdomains only', () => {
    const p = new PatternSet(['example.com', '*.wild.org', 'bad pattern', '']);
    assert.equal(p.size, 2);
    assert.ok(p.matches('example.com'));
    assert.ok(p.matches('a.b.example.com'));
    assert.ok(!p.matches('notexample.com'));
    assert.ok(!p.matches('wild.org'));
    assert.ok(p.matches('x.wild.org'));
    assert.deepEqual(p.toArray(), ['*.wild.org', 'example.com']);
  });

  it('CompactList: suffix, exact and adblock exceptions', () => {
    const b = (arr) => { const x = new HashBuilder(2); for (const d of arr) x.add(d); return x.finish(); };
    const l = new CompactList({ suffix: b(['tracker.net', 'tracker.net']), exact: b(['only.this.org']), except: b(['good.tracker.net']) });
    assert.equal(l.size, 2);
    assert.ok(l.matches('tracker.net'));
    assert.ok(l.matches('x.tracker.net'));
    assert.ok(!l.matches('good.tracker.net'));
    assert.ok(!l.matches('a.good.tracker.net'));
    assert.ok(l.matches('only.this.org'));
    assert.ok(!l.matches('sub.only.this.org'));
    assert.ok(!l.matches('this.org'));
  });
});

describe('dns: list parser', () => {
  it('domains format (comments, *., CRLF, invalid lines)', async () => {
    const r = await parseListText('# Titel\r\nads.example.com\r\n*.track.net\n.dot.org\n! adblock comment\nnot valid line\nbad_..x\n\nUPPER.Case.COM\n', 'domains');
    assert.equal(r.entries, 4);
    assert.ok(r.list.matches('ads.example.com') && r.list.matches('x.ads.example.com'));
    assert.ok(r.list.matches('track.net') && r.list.matches('a.track.net'));
    assert.ok(r.list.matches('dot.org'));
    assert.ok(r.list.matches('upper.case.com'));
    assert.equal(r.skipped, 2);
  });

  it('hosts format: exact names, several per line, skips localhost entries', async () => {
    const r = await parseListText([
      '127.0.0.1 localhost', '127.0.0.1 localhost.localdomain', '::1 ip6-localhost', '0.0.0.0 0.0.0.0',
      '0.0.0.0 ads.example.com  # Kommentar', '0.0.0.0 a.one.net b.two.net', 'ads.only-domain.com',
    ].join('\n'), 'hosts');
    assert.equal(r.entries, 3);
    assert.ok(r.list.matches('ads.example.com'));
    assert.ok(!r.list.matches('x.ads.example.com'), 'hosts entries are exact');
    assert.ok(r.list.matches('a.one.net') && r.list.matches('b.two.net'));
    assert.ok(!r.list.matches('localhost.localdomain'));
    assert.ok(!r.list.matches('ads.only-domain.com'));
  });

  it('adblock format: ||domain^, exceptions, skips rules with options/paths/cosmetics', async () => {
    const r = await parseListText([
      '[Adblock Plus]', '! Title: x', '||ads.example.com^', '||imp.example.net^$important', '@@||ok.ads.example.com^',
      '||path.example.org/ads^', '||third.example.org^$third-party', 'example.com##.banner', '/regex/', '||*.wild.com^',
    ].join('\n'), 'adblock');
    assert.equal(r.entries, 2);
    assert.ok(r.list.matches('ads.example.com') && r.list.matches('x.ads.example.com'));
    assert.ok(!r.list.matches('ok.ads.example.com'), 'exception wins inside the list');
    assert.ok(r.list.matches('imp.example.net'));
    assert.ok(!r.list.matches('path.example.org'));
    assert.ok(!r.list.matches('third.example.org'));
  });

  it('handles lines split across chunks and overlong lines', async () => {
    const chunks = ['ads.exa', 'mple.com\nsecond.or', 'g\n', 'x'.repeat(5000), '\nlast.net'].map((s) => Buffer.from(s));
    const r = await parseListStream(Readable.from(chunks), 'domains');
    assert.equal(r.entries, 3);
    assert.ok(r.list.matches('ads.example.com') && r.list.matches('second.org') && r.list.matches('last.net'));
    assert.equal(r.skipped, 1);
    assert.equal(await countLines(Readable.from(chunks.map((c) => Buffer.from(c)))), 4);
  });

  it('IDN entries are converted to punycode', async () => {
    const r = await parseListText('bücher.de\n', 'domains');
    assert.ok(r.list.matches('xn--bcher-kva.de'));
  });

  it('entry limit throws ListTooLarge; unknown format throws', async () => {
    await assert.rejects(parseListText('a.com\nb.com\nc.com\n', 'domains', { maxEntries: 2 }), (e) => e instanceof ListTooLarge && e.code === 'too_many_entries');
    await assert.rejects(parseListText('a.com', 'json'), /unknown list format/);
  });

  it('presized builder keeps exactly the unique entries', async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `d${i % 4000}.example.com`).join('\n');
    const r = await parseListText(text, 'domains', { expectedEntries: 5000 });
    assert.equal(r.entries, 4000);
    assert.ok(r.list.matches('d3999.example.com'));
    assert.ok(!r.list.matches('d4000.example.com'));
  });
});
