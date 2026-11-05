'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDns, cleanPattern, minutes } = require('../src/dns/config');
const { Policy, scheduleActive } = require('../src/dns/policy');
const { parseListText } = require('../src/dns/listParser');
const { safeSearchTarget } = require('../src/dns/safeSearch');

const KID = 'aa:bb:cc:00:00:01';
const KID2 = 'aa:bb:cc:00:00:02';
const ADULT = 'aa:bb:cc:00:00:09';

function cfg(extra = {}) {
  return normalizeDns({
    enabled: true,
    upstream: { mode: 'doh', provider: 'quad9', fallbackRouter: true },
    alwaysAllow: ['gc.example.net'],
    lists: { ads: { url: 'https://lists.example/ads.txt', format: 'domains' }, adult: { url: 'https://lists.example/a.txt', format: 'hosts' } },
    categories: { social: ['tiktok.com', 'instagram.com'], games: ['roblox.com'], video: ['netflix.com'] },
    profiles: [
      { id: 'std', name: 'Standard', lists: ['ads'], macs: [] },
      {
        id: 'kids', name: 'Kinder', lists: ['ads', 'adult'], safeSearch: true,
        allow: ['*.schulportal.hessen.de', 'anton.app'], deny: ['badgame.com'],
        schedules: [
          { days: [1, 2, 3, 4, 5], from: '21:00', to: '07:00', block: 'categories', categories: ['social', 'games', 'video'], allowAlways: ['school.example'] },
          { days: [6, 7], from: '22:00', to: '08:00', block: 'all', allowAlways: [] },
        ],
        macs: [KID, 'AA-BB-CC-00-00-02'],
      },
      { id: 'free', name: 'Ohne Filter', lists: [], macs: [ADULT] },
    ],
    defaultProfile: 'std',
    ...extra,
  });
}

async function lists() {
  return new Map([
    ['ads', (await parseListText('doubleclick.net\nads.example.com\n', 'domains')).list],
    ['adult', (await parseListText('0.0.0.0 adult.example.org\n', 'hosts')).list],
  ]);
}

// Ortszeit fest auf Europe/Berlin (Policy rechnet in Prozess-Zeitzone)
let oldTz;
before(() => { oldTz = process.env.TZ; process.env.TZ = 'Europe/Berlin'; });
after(() => { if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz; });
// 2026-11-02 ist ein Montag
const at = (day, hh, mm = 0) => new Date(2026, 10, day, hh, mm).getTime();

describe('dns: config normalisation', () => {
  it('missing or broken → off with defaults', () => {
    const c = normalizeDns(undefined);
    assert.equal(c.enabled, false);
    assert.deepEqual(c.upstream, { mode: 'doh', provider: 'quad9', url: null, fallbackRouter: true });
    assert.equal(c.blockResponse, 'zero');
    assert.deepEqual(c.profiles, []);
    assert.equal(c.defaultProfile, null);
  });

  it('validates lists, patterns, macs, schedules, pauses', () => {
    const c = normalizeDns({
      enabled: true,
      upstream: { provider: 'custom', url: 'http://insecure.example/dns-query' },
      lists: {
        ok: { url: 'https://x.example/l.txt', format: 'adblock', sha256: 'A'.repeat(64) },
        '../evil': { url: 'https://x.example/l.txt', format: 'domains' },
        http: { url: 'http://x.example/l.txt', format: 'domains' },
        fmt: { url: 'https://x.example/l.txt', format: 'json' },
      },
      categories: { social: ['tiktok.com', 'x y'], 'Bad Key': ['a.com'] },
      profiles: [
        { id: 7, lists: ['ok', 'missing'], allow: ['*.ok.org', 'bad pattern'], macs: ['AABBCCDDEEFF', 'nope'],
          schedules: [{ days: [1, 9], from: '21:00', to: '24:00', block: 'categories', categories: ['social', 'unknown'] },
            { days: [1], from: '25:00', to: '07:00', block: 'all' }, { days: [1], from: '20:00', to: '21:00', block: 'categories', categories: [] }] },
        { id: '7', name: 'dup' },
        { id: 'has space' },
      ],
      defaultProfile: 'missing',
      pauses: [{ macs: ['aa:bb:cc:dd:ee:ff'], until: '2026-11-05T18:30:00Z' }, { macs: [], until: '2026-11-05T18:30:00Z' }, { macs: ['aa:bb:cc:dd:ee:ff'], until: 'bald' }],
      blockResponse: 'nxdomain',
    });
    assert.equal(c.upstream.provider, 'quad9', 'custom without https url falls back');
    assert.deepEqual(Object.keys(c.lists), ['ok']);
    assert.equal(c.lists.ok.sha256, 'a'.repeat(64));
    assert.deepEqual(c.categories, { social: ['tiktok.com'] });
    assert.equal(c.profiles.length, 1);
    const p = c.profiles[0];
    assert.equal(p.id, '7');
    assert.deepEqual(p.lists, ['ok']);
    assert.deepEqual(p.allow, ['*.ok.org']);
    assert.deepEqual(p.macs, ['aa:bb:cc:dd:ee:ff']);
    assert.deepEqual(p.schedules, [{ days: [1], from: 1260, to: 1440, block: 'categories', categories: ['social'], allowAlways: [] }]);
    assert.equal(c.defaultProfile, '7');
    assert.deepEqual(c.pauses, [{ macs: ['aa:bb:cc:dd:ee:ff'], until: Date.parse('2026-11-05T18:30:00Z') }]);
    assert.equal(c.blockResponse, 'nxdomain');
    assert.equal(cleanPattern(' *.Example.COM '), '*.example.com');
    assert.equal(minutes('07:05'), 425);
    assert.equal(minutes('24:00'), null);
  });
});

describe('dns: policy', () => {
  it('profile per MAC, default profile, lists, alwaysAllow', async () => {
    const p = new Policy(cfg(), { lists: await lists(), extraAllow: ['server.example.org'] });
    assert.deepEqual(p.decide('www.doubleclick.net', null, at(2, 12)), { profileId: 'std', action: 'block', reason: 'list', list: 'ads' });
    assert.equal(p.decide('adult.example.org', null, at(2, 12)).action, 'allow', 'std has no adult list');
    assert.deepEqual(p.decide('adult.example.org', KID, at(2, 12)), { profileId: 'kids', action: 'block', reason: 'list', list: 'adult' });
    assert.equal(p.decide('adult.example.org', KID2, at(2, 12)).profileId, 'kids', 'dash MAC normalised');
    assert.deepEqual(p.decide('doubleclick.net', ADULT, at(2, 12)), { profileId: 'free', action: 'allow', reason: 'default' });
    assert.equal(p.decide('gc.example.net', KID, at(2, 12)).reason, 'always_allow');
    assert.equal(p.decide('server.example.org', KID, at(2, 12)).reason, 'always_allow');
  });

  it('local names go to the router unfiltered; Firefox canary → NXDOMAIN', async () => {
    const p = new Policy(cfg(), { lists: await lists(), localSuffixes: ['heim.example'] });
    for (const n of ['fritz.box', 'nas.fritz.box', 'drucker', 'tv.local', 'x.lan', '5.1.168.192.in-addr.arpa', '1.0.0.10.in-addr.arpa', 'pc.heim.example']) {
      assert.equal(p.decide(n, KID, at(7, 23)).reason, 'local', n);
    }
    assert.equal(p.decide('1.1.1.1.in-addr.arpa', KID, at(2, 12)).reason, 'default');
    assert.deepEqual(p.decide('use-application-dns.net', null, at(2, 12)), { profileId: 'std', action: 'block', reason: 'canary', nxdomain: true });
  });

  it('allow/deny patterns', async () => {
    const p = new Policy(cfg(), { lists: await lists() });
    assert.equal(p.decide('badgame.com', KID, at(2, 12)).reason, 'profile_deny');
    assert.equal(p.decide('www.badgame.com', KID, at(2, 12)).reason, 'profile_deny');
    assert.equal(p.decide('www.schulportal.hessen.de', KID, at(7, 23)).reason, 'profile_allow');
    assert.equal(p.decide('schulportal.hessen.de', KID, at(7, 23)).reason, 'schedule', '*. does not cover the bare domain');
    assert.equal(p.decide('anton.app', KID, at(7, 23)).reason, 'profile_allow');
  });

  it('schedules over midnight: start day counts, end next morning', async () => {
    const p = new Policy(cfg(), { lists: await lists() });
    // Mo 2.11. 21:00 → Di 07:00 Kategorien gesperrt
    assert.equal(p.decide('tiktok.com', KID, at(2, 20, 59)).action, 'allow');
    assert.deepEqual(p.decide('www.tiktok.com', KID, at(2, 21, 0)), { profileId: 'kids', action: 'block', reason: 'schedule_category', category: 'social' });
    assert.equal(p.decide('roblox.com', KID, at(3, 6, 59)).reason, 'schedule_category');
    assert.equal(p.decide('roblox.com', KID, at(3, 7, 0)).action, 'allow');
    assert.equal(p.decide('example.com', KID, at(2, 23)).action, 'allow', 'categories rule does not block other sites');
    assert.equal(p.decide('school.example', KID, at(2, 23)).action, 'allow', 'allowAlways of the rule');
    // Fr 6.11. 21:00 gehört zu Mo–Fr; Sa früh bis 07:00 noch gesperrt (Starttag Fr)
    assert.equal(p.decide('netflix.com', KID, at(7, 6)).reason, 'schedule_category');
    // So 8.11. 23:00: „Internet ganz aus“ (Sa–So 22–08); Mo 9.11. 07:30 noch aus (Starttag So)
    assert.equal(p.decide('example.com', KID, at(8, 23)).reason, 'schedule');
    assert.equal(p.decide('example.com', KID, at(9, 7, 30)).reason, 'schedule');
    assert.equal(p.decide('example.com', KID, at(9, 8, 0)).action, 'allow');
    // Fr 6.11. 23:00 ist keine Sa–So-Nacht
    assert.equal(p.decide('example.com', KID, at(6, 23)).action, 'allow');
    // anderes Profil unberührt
    assert.equal(p.decide('tiktok.com', null, at(2, 23)).action, 'allow');
  });

  it('scheduleActive: from == to means the whole day; to 24:00', () => {
    const d = (day, h) => new Date(2026, 10, day, h);
    assert.ok(scheduleActive({ days: [1], from: 0, to: 0 }, d(2, 13)));
    assert.ok(!scheduleActive({ days: [1], from: 0, to: 0 }, d(3, 13)));
    assert.ok(scheduleActive({ days: [7], from: 1200, to: 1440 }, d(8, 23)));
    assert.ok(!scheduleActive({ days: [7], from: 1200, to: 1440 }, d(9, 0)));
  });

  it('pauses: internet off except alwaysAllow + profile allow; extensions suspend schedules', async () => {
    const now = at(2, 15);
    const p = new Policy(cfg({
      pauses: [{ macs: [KID], until: new Date(now + 3600_000).toISOString() }, { macs: [ADULT], until: new Date(now - 1).toISOString() }],
      extensions: [{ macs: [KID2], until: new Date(at(2, 22)).toISOString() }],
    }), { lists: await lists() });
    assert.equal(p.decide('example.com', KID, now).reason, 'paused');
    assert.equal(p.decide('anton.app', KID, now).reason, 'profile_allow');
    assert.equal(p.decide('gc.example.net', KID, now).reason, 'always_allow');
    assert.equal(p.decide('example.com', KID, now + 3600_000).action, 'allow', 'pause over');
    assert.equal(p.decide('example.com', ADULT, now).action, 'allow', 'expired pause');
    assert.equal(p.decide('tiktok.com', KID2, at(2, 21, 30)).action, 'allow', 'extension active');
    assert.equal(p.decide('tiktok.com', KID2, at(2, 22, 0)).reason, 'schedule_category', 'extension over');
    assert.equal(p.decide('doubleclick.net', KID2, at(2, 21, 30)).reason, 'list', 'extension does not lift lists');
  });

  it('safe search: rewrite target only for profiles with safeSearch', async () => {
    const p = new Policy(cfg(), { lists: await lists() });
    assert.equal(p.decide('www.google.de', KID, at(2, 12)).safeSearch, 'forcesafesearch.google.com');
    assert.equal(p.decide('www.google.de', null, at(2, 12)).safeSearch, undefined);
    assert.equal(safeSearchTarget('www.google.co.uk'), 'forcesafesearch.google.com');
    assert.equal(safeSearchTarget('google.com'), 'forcesafesearch.google.com');
    assert.equal(safeSearchTarget('mail.google.com'), null);
    assert.equal(safeSearchTarget('google.dev'), null);
    assert.equal(safeSearchTarget('m.youtube.com'), 'restrict.youtube.com');
    assert.equal(safeSearchTarget('www.bing.com'), 'strict.bing.com');
    assert.equal(safeSearchTarget('duckduckgo.com'), 'safe.duckduckgo.com');
  });

  it('no profiles at all: everything allowed, pauses still work', () => {
    const c = normalizeDns({ enabled: true, pauses: [{ macs: [KID], until: new Date(Date.now() + 60_000).toISOString() }] });
    const p = new Policy(c);
    assert.deepEqual(p.decide('example.com', null), { profileId: null, action: 'allow', reason: 'no_profile' });
    assert.equal(p.decide('example.com', KID).reason, 'paused');
  });
});
