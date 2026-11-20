'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { titleId, extractPosters, imdbPosters } = require('../lib/imdbPosters');
const poster = (id, img) => `<a href="/title/tt31938062/mediaviewer/rm${id}/?ref_=ttmi"><img src="https://m.media-amazon.com/images/M/MV5B${img}._V1_QL75_UX328_.jpg" alt="View Poster"></a>`;
const html = `<img src="https://m.media-amazon.com/images/M/MV5Blogo.jpg">${poster(1,'abcdef')}${poster(2,'abcdef')}${poster(3,'ghijkl')}<a href="/title/tt1111111/mediaviewer/rm1/"><img src="https://m.media-amazon.com/images/M/MV5Bother.jpg"></a>`;
test('validates IMDb title links without fetching arbitrary URLs', () => {
  assert.equal(titleId('https://www.imdb.com/title/tt31938062/?ref_=x'), 'tt31938062');
  for (const url of ['http://127.0.0.1/title/tt31938062/', 'https://imdb.com.evil.com/title/tt31938062/', 'https://www.imdb.com/title/tt31938062/mediaindex/', 'https://user@imdb.com/title/tt31938062/']) assert.throws(() => titleId(url), (e) => e.code === 'IMDB_URL_INVALID');
});
test('extracts only unique poster URLs from the requested title, limited by count', () => {
  const all = extractPosters(html, 'tt31938062', 50); assert.equal(all.length, 2); assert.match(all[0], /MV5Babcdef/);
  assert.equal(extractPosters(html, 'tt31938062', 1).length, 1);
});
test('fetches the poster-filtered index, handles partial results and blocked pages', async () => {
  let seen;
  const result = await imdbPosters('https://www.imdb.com/title/tt31938062/', 10, async (url) => { seen = url; return new Response(html, { headers:{'content-type':'text/html'} }); });
  assert.equal(seen, 'https://www.imdb.com/title/tt31938062/mediaindex/?refine=poster'); assert.equal(result.length, 2);
  await assert.rejects(imdbPosters('https://www.imdb.com/title/tt31938062/', 51), (e) => e.code === 'IMDB_COUNT_INVALID');
  await assert.rejects(imdbPosters('https://www.imdb.com/title/tt31938062/', 2, async () => new Response('blocked', {status:403})), (e) => e.code === 'IMDB_UPSTREAM');
  await assert.rejects(imdbPosters('https://www.imdb.com/title/tt31938062/', 2, async () => new Response('nothing', {headers:{'content-type':'text/html'}})), (e) => e.code === 'IMDB_POSTERS_UNAVAILABLE');
});
