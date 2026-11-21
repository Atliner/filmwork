'use strict';
process.env.NODE_ENV = 'development';
process.env.DB_HOST ||= '127.0.0.1'; process.env.DB_NAME ||= 'test'; process.env.DB_USER ||= 'test'; process.env.DB_PASSWORD ||= 'unused';
process.env.DEMO_DATA = '1'; process.env.JWT_SECRET ||= 'a'.repeat(64); process.env.AUTH_CODE_PEPPER ||= 'b'.repeat(64); process.env.PHONE_ENCRYPTION_KEY ||= 'c'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogFacets, parseCatalogFilters } = require('../lib/catalogFilters');
const { app } = require('../server');
let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => new Promise((r) => server.close(r)));
async function get(path) { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; }
test('facets count unique genres and use actual bounds and normalized countries', () => {
  const f = catalogFacets([{ genres: '["درام","درام","اکشن"]', country: 'ایران، آمریکا', release_year: 2001, imdb_score: 6 }, { genres: ['درام'], countries: ['ایران'], releaseYear: 2020, imdbScore: 9 }]);
  assert.deepEqual(f.genres.map((g) => [g.name,g.count]), [['درام',2],['اکشن',1]]);
  assert.deepEqual(f.years, { min: 2001, max: 2020 }); assert.deepEqual(f.ratings, { min: 6, max: 9 });
  assert.deepEqual(new Set(f.countries), new Set(['ایران','آمریکا']));
  assert.throws(() => parseCatalogFilters({ minRating: '9', maxRating: '1' }));
});
test('published archive facets and combined filters agree in demo', async () => {
  const facets = (await get('/api/contents-facets')).body;
  assert.ok(facets.genres.length); assert.equal(facets.genres[0].name, 'درام');
  assert.ok(!facets.countries.includes('فرانسه')); assert.ok(!facets.networks.includes('MUBI'));
  const list = (await get('/api/contents?audio=both&country=' + encodeURIComponent('آمریکا') + '&age=PG-13&sort=rating')).body.items;
  assert.ok(list.length); assert.ok(list.every((item) => item.hasDub && item.hasSub && item.countries.includes('آمریکا') && item.ageRating === 'PG-13'));
  const running = (await get('/api/contents?running=1')).body.items;
  assert.ok(running.length); assert.ok(running.every((item) => item.type === 'series' && item.seriesRunning));
  const years = (await get('/api/contents?yearFrom=2022&yearTo=2024&minRating=8&maxRating=8.5&sort=year')).body.items;
  assert.ok(years.length); assert.ok(years.every((i) => i.releaseYear >= 2022 && i.releaseYear <= 2024 && i.imdbScore >= 8 && i.imdbScore <= 8.5));
  assert.ok(years.every((i, n) => !n || years[n-1].releaseYear >= i.releaseYear));
  const person = (await get('/api/contents?role=cast&person=Noah%20Wyle')).body.items;
  assert.equal(person.length, 1); assert.equal(person[0].originalTitle, 'The Pitt');
  assert.equal((await get('/api/contents?role=director&person=Noah%20Wyle')).body.items.length, 0);
  assert.equal((await get('/api/contents?minRating=9&maxRating=2')).status, 422);
});

test('MySQL public DTO includes the last broadcast year including equal years and null', () => {
  const { contentDto } = require('../server');
  const row = { asset_uuid:'id', content_type:'series', release_year:2025, last_air_year:2026, imdb_score:null };
  assert.equal(contentDto(row).lastAirYear, 2026);
  assert.equal(contentDto({ ...row, last_air_year:2025 }).lastAirYear, 2025);
  assert.equal(contentDto({ ...row, last_air_year:null }).lastAirYear, null);
});
