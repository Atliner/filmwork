'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedUrl, extractPosterUrl, resolvePoster, posterImage, fetchAllowed } = require('../lib/posterImport');
const jpeg = Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0xff,0xd9]);
test('finds poster image in IMPAwards page formats', () => {
  for (const name of ['pitt','silo_ver5']) {
    const html = `<img src="http://www.impawards.com/bootstrap/img/logo.png"><img src="http://www.impawards.com/tv/posters/${name}.jpg">`;
    assert.equal(extractPosterUrl(html, `http://www.impawards.com/tv/${name}.html`).toString(), `http://www.impawards.com/tv/posters/${name}.jpg`);
  }
  assert.throws(() => extractPosterUrl('<img src="https://evil.test/tv/posters/a.jpg">','https://www.impawards.com/tv/a.html'), (e) => e.code === 'POSTER_NOT_FOUND');
});
test('resolves links without downloading image and relays image on demand', async () => {
  const seen = []; const fake = async (url) => { seen.push(url); return url.endsWith('.html') ? new Response('<img src="/tv/posters/pitt.jpg">', { headers: { 'Content-Type':'text/html' } }) : new Response(jpeg); };
  const result = await resolvePoster('http://www.impawards.com/tv/pitt.html', fake);
  assert.equal(result, 'http://www.impawards.com/tv/posters/pitt.jpg');
  assert.equal(seen.length, 1);
  const image = await posterImage(result, fake); assert.equal(image.extension, '.jpg'); assert.deepEqual(image.data, jpeg);
  assert.equal(await resolvePoster(result, fake), result); assert.equal(seen.length, 2);
});
test('rejects SSRF, external redirects, non-image data and oversized responses', async () => {
  for (const url of ['http://127.0.0.1/tv/pitt.html', 'http://www.impawards.com.evil.test/tv/pitt.html', 'http://www.impawards.com:8080/tv/pitt.html', 'http://user@www.impawards.com/tv/pitt.html']) assert.throws(() => allowedUrl(url), (e) => e.code === 'POSTER_URL_INVALID');
  let calls = 0;
  await assert.rejects(fetchAllowed('http://www.impawards.com/tv/pitt.html', { maxBytes:1000, fetchFn:async () => { calls++; return new Response(null, { status:302, headers:{location:'http://127.0.0.1/private'} }); } }), (e) => e.code === 'POSTER_URL_INVALID'); assert.equal(calls, 1);
  await assert.rejects(fetchAllowed('http://www.impawards.com/tv/pitt.html', { maxBytes:2, fetchFn:async () => new Response('abc') }), (e) => e.code === 'POSTER_TOO_LARGE');
  await assert.rejects(posterImage('http://www.impawards.com/tv/posters/pitt.jpg', async () => new Response('<script>')), (e) => e.code === 'POSTER_NOT_IMAGE');
  await assert.rejects(posterImage('http://www.impawards.com/tv/pitt.html', async () => new Response(jpeg)), (e) => e.code === 'POSTER_URL_INVALID');
});
