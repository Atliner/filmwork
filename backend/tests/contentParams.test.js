'use strict';

process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test';
process.env.DB_PASSWORD ||= 'not-used-by-params-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeContentPayload, updateContentPayload } = require('../lib/contentParams');

test('normalises a movie payload and its comma-separated lists', () => {
  const payload = normalizeContentPayload({
    titleFa: 'دون',
    titleEn: 'Dune',
    contentType: 'movie',
    releaseYear: '۲۰۲۴',
    genres: 'علمی تخیلی، ماجراجویی',
    cast: 'Timothée Chalamet, Zendaya',
    countries: 'آمریکا، کانادا',
    imdbScore: '8.5',
    runtimeMinutes: '166',
    hasSub: true,
    status: 'published',
  });
  assert.equal(payload.releaseYear, 2024);
  assert.deepEqual(payload.genres, ['علمی تخیلی', 'ماجراجویی']);
  assert.deepEqual(payload.castMembers, ['Timothée Chalamet', 'Zendaya']);
  assert.deepEqual(payload.countries, ['آمریکا', 'کانادا']);
  assert.equal(payload.imdbScore, 8.5);
  assert.equal(payload.runtimeMinutes, 166);
  assert.equal(payload.status, 'published');
});

test('fills the automatic broadcast note using Persian digits', () => {
  const payload = normalizeContentPayload({
    titleFa: 'پیت', titleEn: 'The Pitt', contentType: 'series', seriesRunning: true, currentSeason: '4',
  });
  assert.equal(payload.seriesRunning, true);
  assert.equal(payload.currentSeason, 4);
  assert.match(payload.broadcastNote, /فصل ۴/);
});

test('ignores series-only fields for movies', () => {
  const payload = normalizeContentPayload({
    titleFa: 'فیلم', titleEn: 'Movie', contentType: 'movie',
    seriesRunning: true, currentSeason: 3, lastAirYear: 2020, seasonCount: 4,
  });
  assert.equal(payload.seriesRunning, false);
  assert.equal(payload.currentSeason, null);
  assert.equal(payload.lastAirYear, null);
  assert.equal(payload.seasonCount, null);
  assert.equal(payload.broadcastNote, null);
});

test('rejects a title-less payload and an out-of-order year range', () => {
  assert.throws(() => normalizeContentPayload({ titleFa: '  ', titleEn: '' }), /عنوان/);
  assert.throws(() => normalizeContentPayload({
    titleFa: 'x', titleEn: 'x', contentType: 'series', releaseYear: 2020, lastAirYear: 2010,
  }), /سال آخرین فصل/);
});

test('applies a one-field patch without wiping the rest of the record', () => {
  const existing = {
    content: {
      type: 'series', title: 'پیت', originalTitle: 'The Pitt', status: 'published',
      genres: ['درام'], cast: ['Noah Wyle'], countries: ['آمریکا'], seasons: 6, episodes: 34,
      seriesRunning: true, currentSeason: 6, imdbScore: 8.9,
    },
    versions: [{ kind: 'sub', title: '1080p', resolution: '1080p', links: [] }],
  };
  const payload = updateContentPayload(existing, { status: 'draft' });
  assert.equal(payload.status, 'draft');
  assert.equal(payload.titleFa, 'پیت');
  assert.deepEqual(payload.genres, ['درام']);
  assert.equal(payload.seriesRunning, true);
  assert.equal(payload.imdbScore, 8.9);
  assert.equal(payload.versions.length, 1);
});
