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
