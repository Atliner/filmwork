'use strict';

/**
 * Owner console API contract: auth gate, guarded demo login, parse → create → read →
 * hero → delete. Runs against the in-memory store so it needs no MySQL.
 */

process.env.NODE_ENV = 'development';
// The pool is created at import time even in demo mode, so give it inert values.
process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test';
process.env.DB_PASSWORD ||= 'unused';
process.env.DEMO_DATA = '1';
process.env.PORT = '0';
process.env.JWT_SECRET ||= 'a'.repeat(64);
process.env.AUTH_CODE_PEPPER ||= 'b'.repeat(64);
process.env.PHONE_ENCRYPTION_KEY ||= 'c'.repeat(64);
process.env.ADMIN_OWNER_IDS ||= '123456789';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');

let server;
let base;
let cookie = '';
let csrf = '';

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function call(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) };
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = response.headers.getSetCookie?.() || [];
  if (setCookie.length) cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

test('the console and its API stay hidden without an owner session', async () => {
  assert.equal((await call('/owner-console')).status, 404);
  assert.equal((await call('/api/admin/contents')).status, 404);
  assert.equal((await call('/api/admin/stats')).status, 404);
});

test('demo login issues an owner session and a CSRF token', async () => {
  const response = await fetch(`${base}/owner-console/demo-login`, { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/owner-console');
  cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  const consolePage = await call('/owner-console');
  assert.equal(consolePage.status, 200);
  const session = await call('/api/admin/session');
  assert.equal(session.status, 200);
  assert.ok(session.data.csrfToken);
  csrf = session.data.csrfToken;
});

test('writes without the CSRF header are rejected', async () => {
  const response = await fetch(`${base}/api/admin/contents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ titleFa: 'x', titleEn: 'x' }),
  });
  assert.equal(response.status, 403);
});

test('owner can read and save global site, download and player settings', async () => {
  const current = await call('/api/admin/site-settings');
  assert.equal(current.status, 200);
  assert.equal(current.data.settings['download.burst_limit'], '10');
  const saved = await call('/api/admin/site-settings', { method: 'PATCH', body: { settings: {
    'site.name': 'سینماگرام', 'download.burst_limit': '12', 'download.daily_cap': '0', 'player.enabled': '0',
  } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.settings['site.name'], 'سینماگرام');
  assert.equal(saved.data.settings['download.burst_limit'], '12');
  assert.equal(saved.data.settings['player.enabled'], '0');
  const invalid = await call('/api/admin/site-settings', { method: 'PATCH', body: { settings: { 'download.delay_minutes': '1,wait,3' } } });
  assert.equal(invalid.status, 422);
});

test('overview reports counts for both types', async () => {
  const { status, data } = await call('/api/admin/stats');
  assert.equal(status, 200);
  assert.ok(data.overview.totals.contents > 0);
  assert.equal(data.overview.totals.contents, data.overview.totals.movies + data.overview.totals.series);
  assert.equal(data.mode, 'demo');
  assert.ok(data.overview.cards.length >= 4);
  assert.equal(data.overview.timeline.length, 14);
});

test('the library filters and paginates', async () => {
  const all = await call('/api/admin/contents?limit=50');
  assert.equal(all.status, 200);
  assert.ok(all.data.items.length > 0);
  const series = await call('/api/admin/contents?type=series');
  assert.ok(series.data.items.every((item) => item.type === 'series'));
  const page = await call('/api/admin/contents?limit=2&page=1');
  assert.equal(page.data.items.length, 2);
});

test('the public detail payload carries both scripts and the crew', async () => {
  const list = await call('/api/admin/contents?limit=50');
  const series = list.data.items.find((item) => item.type === 'series');
  assert.ok(series.directors.length, 'directors should reach the public DTO');
  assert.ok(series.cast.length, 'cast should reach the public DTO');
});

test('the library search answers Persian and English, titles and crew alike', async () => {
  const created = await call('/api/admin/contents', {
    method: 'POST',
    body: {
      titleFa: 'پیت', titleEn: 'The Pitt', contentType: 'series', releaseYear: 2026,
      genres: 'درام', directors: 'دامین مارکانو | Damian Marcano', cast: 'نوآ وایلی | Noah Wyle',
      countries: 'آمریکا', network: 'HBO Max', status: 'published',
    },
  });
  assert.equal(created.status, 201);
  const byFa = await call('/api/admin/contents?q=پیت');
  assert.ok(byFa.data.items.some((item) => item.id === created.data.content.id));
  const byEn = await call('/api/admin/contents?q=The%20Pitt');
  assert.ok(byEn.data.items.some((item) => item.id === created.data.content.id));
  const byDirectorFa = await call('/api/admin/contents?q=مارکانو');
  assert.ok(byDirectorFa.data.items.some((item) => item.id === created.data.content.id));
  const byDirectorEn = await call('/api/admin/contents?q=Marcano');
  assert.ok(byDirectorEn.data.items.some((item) => item.id === created.data.content.id));
  const byCastEn = await call('/api/admin/contents?q=Noah%20Wyle');
  assert.ok(byCastEn.data.items.some((item) => item.id === created.data.content.id));
  await call(`/api/admin/contents/${created.data.content.id}`, { method: 'DELETE' });
});

test('bilingual crew stays separate through validation instead of being merged', async () => {
  const created = await call('/api/admin/contents', {
    method: 'POST',
    body: {
      titleFa: 'دوزبانه', titleEn: 'Bilingual', contentType: 'movie',
      directors: 'دامین مارکانو، جان ولز | Damian Marcano, John Wells',
      cast: 'نوآ وایلی | Noah Wyle', status: 'draft',
    },
  });
  const detail = await call(`/api/admin/contents/${created.data.content.id}`);
  assert.deepEqual(detail.data.content.directors, [
    'دامین مارکانو', 'جان ولز', 'Damian Marcano', 'John Wells',
  ]);
  assert.deepEqual(detail.data.content.cast, ['نوآ وایلی', 'Noah Wyle']);
  await call(`/api/admin/contents/${created.data.content.id}`, { method: 'DELETE' });
});

test('the owner sees Telegram identity, masked phone and wallet per user', async () => {
  const list = await call('/api/admin/users');
  assert.equal(list.status, 200);
  const user = list.data.items[0];
  assert.ok(user.accountName);
  assert.ok('telegramUsername' in user);
  assert.ok('telegramUserId' in user);
  assert.match(user.phoneMasked, /•/);
  assert.equal(user.walletCurrency, 'IRR');
  assert.ok(!('phone' in user), 'the full phone must not ride along with the list');
});

test('users can be filtered by role and searched, and their phone revealed on demand', async () => {
  const advertisers = await call('/api/admin/users?role=advertiser');
  assert.ok(advertisers.data.items.length > 0);
  assert.ok(advertisers.data.items.every((user) => user.isAdvertiser && user.roles.includes('user') && user.roles.includes('advertiser')));
  const target = advertisers.data.items[0];
  const revealed = await call(`/api/admin/users/${target.id}/phone`);
  assert.equal(revealed.status, 200);
  assert.ok(revealed.data.phone.length > 6);
});

test('the owner tops up a wallet and the balance moves', async () => {
  const list = await call('/api/admin/users');
  const user = list.data.items[0];
  const before = user.walletBalance;
  const credit = await call(`/api/admin/users/${user.id}/wallet`, { method: 'POST', body: { amount: 2_500_000 } });
  assert.equal(credit.status, 201);
  assert.equal(credit.data.wallet.balance, before + 2_500_000);
  const after = (await call('/api/admin/users')).data.items.find((entry) => entry.id === user.id);
  assert.equal(after.walletBalance, before + 2_500_000);
});

test('wallet top-up rejects a zero or negative amount and needs CSRF', async () => {
  const list = await call('/api/admin/users');
  const user = list.data.items[0];
  assert.equal((await call(`/api/admin/users/${user.id}/wallet`, { method: 'POST', body: { amount: 0 } })).status, 422);
  const saved = csrf;
  csrf = 'wrong';
  assert.equal((await call(`/api/admin/users/${user.id}/wallet`, { method: 'POST', body: { amount: 1000 } })).status, 403);
  csrf = saved;
});

test('deleting a user removes the account and every dependent row', async () => {
  const list = await call('/api/admin/users');
  const victim = list.data.items[list.data.items.length - 1];
  const removed = await call(`/api/admin/users/${victim.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.deleted, true);
  const after = await call('/api/admin/users');
  assert.ok(!after.data.items.some((entry) => entry.id === victim.id));
  assert.equal((await call(`/api/admin/users/${victim.id}`, { method: 'DELETE' })).status, 404);
  // A deleted id must not authenticate anything either.
  assert.equal((await call(`/api/admin/users/${victim.id}/phone`)).status, 404);
});

test('every sidebar menu item is wired to the router and to an existing view', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'private', 'admin.js'), 'utf8');
  const menuViews = [...html.matchAll(/class="nav-item"\s+data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(menuViews.length >= 7, 'the sidebar still lists every section');
  const registered = [...script.matchAll(/^\s{4}(\w+): (?:render|\()/gm)].map((m) => m[1]);
  for (const view of menuViews) {
    assert.ok(registered.includes(view), `menu item ${view} has no render function`);
  }
  assert.match(script, /button\.matches\('\[data-view\]'\)/, 'clicks on .nav-item must navigate');
});

test('ad settings expose the eight placements in three groups with a working policy', async () => {
  const config = await call('/api/admin/ads/settings');
  assert.equal(config.status, 200);
  assert.equal(config.data.placements.length, 8);
  const groups = config.data.placements.reduce((acc, slot) => {
    acc[slot.group] = (acc[slot.group] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(groups, { video: 4, banner: 3, link: 1 });
  assert.equal(config.data.policy.maxVideoMb, 8);
  assert.equal(config.data.policy.defaultVideoDuration, 15);
  assert.equal(config.data.policy.autoApprove, false);
});

test('the owner switches a placement off and on, and saves its duration', async () => {
  const off = await call('/api/admin/ads/placements/banner_player', { method: 'PATCH', body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.data.placements.find((slot) => slot.placement === 'banner_player').enabled, false);
  const on = await call('/api/admin/ads/placements/banner_player', { method: 'PATCH', body: { enabled: true } });
  assert.equal(on.data.placements.find((slot) => slot.placement === 'banner_player').enabled, true);
  const timed = await call('/api/admin/ads/placements/pre_roll', { method: 'PATCH', body: { durationSeconds: 20, pricePerThousand: 60000 } });
  const slot = timed.data.placements.find((entry) => entry.placement === 'pre_roll');
  assert.equal(slot.durationSeconds, 20);
  assert.equal(slot.cpm, 60000);
  assert.equal((await call('/api/admin/ads/placements/nope', { method: 'PATCH', body: { enabled: true } })).status, 422);
});

test('ad settings are validated, clamped and persisted', async () => {
  const saved = await call('/api/admin/ads/settings', {
    method: 'PATCH',
    body: { settings: { 'ads.max_video_mb': '9999', 'ads.auto_approve': '1', 'ads.cpm_video': '75000', 'ads.rules': 'قوانین تازه' } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.settings['ads.max_video_mb'], '100', 'clamped to the upper bound');
  assert.equal(saved.data.settings['ads.auto_approve'], '1');
  assert.equal(saved.data.policy.cpm.video, 75000);
  assert.equal(saved.data.policy.autoApprove, true);
  assert.equal(saved.data.settings['ads.rules'], 'قوانین تازه');
  await call('/api/admin/ads/settings', { method: 'PATCH', body: { settings: { 'ads.auto_approve': '0' } } });
});

test('the review queue approves and rejects; rejection purges the creative', async () => {
  const created = await call('/api/admin/ads/campaigns', {
    method: 'POST',
    body: { campaignName: 'کمپین مالک تست', headline: 'تبلیغ آزمایشی مالک', placement: 'pre_roll', creativeUrl: 'https://example.com/ad.mp4' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.campaign.status, 'active');
  assert.equal(created.data.campaign.ownerCampaign, true);
  const list = await call('/api/admin/ads/campaigns?owner=owner');
  assert.ok(list.data.items.some((ad) => ad.id === created.data.campaign.id));
  const rejected = await call(`/api/admin/ads/campaigns/${created.data.campaign.id}/review`, {
    method: 'POST',
    body: { status: 'rejected', note: 'کیفیت پایین' },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, 'rejected');
  const after = await call('/api/admin/ads/campaigns');
  const row = after.data.items.find((ad) => ad.id === created.data.campaign.id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.reviewNote, 'کیفیت پایین');
});

test('owner campaigns need no wallet balance and no budget', async () => {
  const created = await call('/api/admin/ads/campaigns', {
    method: 'POST',
    body: { campaignName: 'کمپین بدون بودجه', headline: 'رایگان برای مالک', placement: 'banner_player', creativeUrl: 'https://example.com/banner.png' },
  });
  assert.equal(created.status, 201);
  const dashboard = await call('/api/admin/ads/dashboard');
  assert.ok(dashboard.data.totals.ownerCampaigns >= 1);
  assert.ok(Array.isArray(dashboard.data.byGroup));
});

test('the ads dashboard and config only offer enabled placements', async () => {
  await call('/api/admin/ads/placements/banner_download', { method: 'PATCH', body: { enabled: false } });
  const config = await call('/api/config');
  assert.equal(config.status, 200);
  assert.ok(!config.data.placementPrices.some((price) => price.placement === 'banner_download'));
  await call('/api/admin/ads/placements/banner_download', { method: 'PATCH', body: { enabled: true } });
});

test('the host self-check reports the runtime, not a crash', async () => {
  const report = await call('/api/admin/diagnostics');
  assert.equal(report.status, 200);
  assert.ok(['demo', 'mysql'].includes(report.data.mode));
  assert.ok(Array.isArray(report.data.checks));
});

test('the deploy panel stays inert until GITHUB_REPO is configured', async () => {
  // The developer .env may already point at the repository; the contract under
  // test is the unconfigured answer, so hide it for this case.
  const savedRepo = process.env.GITHUB_REPO;
  delete process.env.GITHUB_REPO;
  const status = await call('/api/admin/deploy/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.configured, false);
  const run = await call('/api/admin/deploy/github', { method: 'POST', body: {} });
  assert.equal(run.status, 422);
  assert.equal(run.data.error.code, 'DEPLOY_NOT_CONFIGURED');
  if (savedRepo !== undefined) process.env.GITHUB_REPO = savedRepo;
});

test('a Telegram post is parsed into an editable draft', async () => {
  const { status, data } = await call('/api/admin/parse', {
    method: 'POST',
    body: { text: '🎬 The Pitt | پیت\nنوع: سریال\nسال شروع: ۲۰۲۶\nژانر: درام\nامتیاز IMDb: ۸.۹\nکیفیت: 1080p، 720p' },
  });
  assert.equal(status, 200);
  assert.equal(data.draft.fields.titleFa, 'پیت');
  assert.equal(data.draft.fields.titleEn, 'The Pitt');
  assert.equal(data.draft.fields.contentType, 'series');
  assert.equal(data.draft.fields.imdbScore, 8.9);
  assert.deepEqual(data.draft.fields.qualities, ['1080p', '720p']);
  assert.ok(data.draft.meta.confidence > 50);
});

test('an empty import is rejected with a readable message', async () => {
  const { status, data } = await call('/api/admin/parse', { method: 'POST', body: { text: '   ' } });
  assert.equal(status, 422);
  assert.equal(data.error.code, 'EMPTY_SOURCE');
});

let createdId;

test('creating content stores metadata, versions and the hero flag', async () => {
  const { status, data } = await call('/api/admin/contents', {
    method: 'POST',
    body: {
      titleFa: 'پیت',
      titleEn: 'The Pitt',
      contentType: 'series',
      releaseYear: 2026,
      lastAirYear: null,
      seriesRunning: true,
      currentSeason: 6,
      genres: 'درام، پزشکی',
      cast: 'Noah Wyle، Tracy Ifeachor',
      countries: 'آمریکا',
      imdbScore: 8.9,
      posterUrl: 'https://example.com/poster.jpg',
      status: 'published',
      featuredHero: true,
      versions: [
        {
          kind: 'sub',
          title: '1080p',
          resolution: '1080p',
          links: [
            { season: 1, episode: 1, telegramUrl: 'https://t.me/c/1/1' },
            { season: 1, episode: 2, telegramUrl: 'https://t.me/c/1/2' },
          ],
        },
        { kind: 'dub', title: '720p', resolution: '720p', links: [{ season: 1, episode: 1 }] },
      ],
    },
  });
  assert.equal(status, 201);
  createdId = data.content.id;
  assert.equal(data.content.title, 'پیت');
  assert.equal(data.content.featuredHero, true);
});

test('the detail endpoint returns versions, links and derived counts', async () => {
  const { status, data } = await call(`/api/admin/contents/${createdId}`);
  assert.equal(status, 200);
  assert.equal(data.content.originalTitle, 'The Pitt');
  assert.equal(data.content.seriesRunning, true);
  assert.deepEqual(data.content.genres, ['درام', 'پزشکی']);
  assert.equal(data.versions.length, 2);
  assert.equal(data.versions[0].links.length, 2);
  assert.deepEqual(data.counts.episodes, 2);
  assert.equal(data.counts.mediaLinks, 3);
});

test('a single promoted title owns the hero banner', async () => {
  const list = await call('/api/admin/contents?limit=50');
  const other = list.data.items.find((item) => item.id !== createdId);
  const promoted = await call(`/api/admin/contents/${other.id}/hero`, { method: 'POST', body: { enabled: true } });
  assert.equal(promoted.status, 200);
  const after = await call('/api/admin/contents?limit=50');
  assert.equal(after.data.items.filter((item) => item.featuredHero).length, 1);
  assert.equal(after.data.items.find((item) => item.featuredHero).id, other.id);
});

test('patching only the status keeps the rest of the record', async () => {
  const { status, data } = await call(`/api/admin/contents/${createdId}`, {
    method: 'PATCH',
    body: { status: 'draft' },
  });
  assert.equal(status, 200);
  assert.equal(data.content.status, 'draft');
  assert.equal(data.content.title, 'پیت');
  assert.deepEqual(data.content.genres, ['درام', 'پزشکی']);
  assert.equal(data.versions.length, 2);
});

test('editing the metadata updates the same record', async () => {
  const { status, data } = await call(`/api/admin/contents/${createdId}`, {
    method: 'PATCH',
    body: { titleFa: 'پیت (فصل ۶)', status: 'published' },
  });
  assert.equal(status, 200);
  assert.equal(data.content.title, 'پیت (فصل ۶)');
});

test('syncing media links works even when the bot stored nothing yet', async () => {
  const { status, data } = await call(`/api/admin/contents/${createdId}/sync-media`, { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(typeof data.imported, 'number');
  assert.ok(Array.isArray(data.versions));
});

test('deleting removes the content and its detail page', async () => {
  const removed = await call(`/api/admin/contents/${createdId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.deleted, true);
  const missing = await call(`/api/admin/contents/${createdId}`);
  assert.equal(missing.status, 404);
});
