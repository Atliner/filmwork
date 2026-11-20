'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { allowedUrl, extractPosterUrl, importPoster, fetchAllowed } = require('../lib/posterImport');

const jpeg = Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0xff,0xd9]);
test('finds the actual poster image in both requested IMPAwards page formats', () => {
  for (const [page, image] of [['pitt','pitt'],['silo_ver5','silo_ver5']]) {
    const html = `<img src="http://www.impawards.com/bootstrap/img/logo.png"><img alt="Poster" src="http://www.impawards.com/tv/posters/${image}.jpg">`;
    assert.equal(extractPosterUrl(html, `http://www.impawards.com/tv/${page}.html`).toString(), `http://www.impawards.com/tv/posters/${image}.jpg`);
  }
  assert.throws(() => extractPosterUrl('<img src="https://evil.test/tv/posters/a.jpg">','https://www.impawards.com/tv/a.html'), (e) => e.code === 'POSTER_NOT_FOUND');
});
test('imports a page and image into a local same-origin image file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poster-test-'));
  const seen = [];
  try {
    const fake = async (url) => {
      seen.push(url);
      if (url.endsWith('.html')) return new Response('<img src="/tv/posters/pitt.jpg">', { headers: { 'Content-Type':'text/html' } });
      return new Response(jpeg, { headers: { 'Content-Type':'image/jpeg' } });
    };
    const result = await importPoster('http://www.impawards.com/tv/pitt.html', dir, fake);
    assert.match(result.path, /^\/uploads\/posters\/[a-f0-9]{64}\.jpg$/);
    assert.deepEqual(await fs.readFile(path.join(dir, path.basename(result.path))), jpeg);
    assert.deepEqual(seen, ['http://www.impawards.com/tv/pitt.html','http://www.impawards.com/tv/posters/pitt.jpg']);
    assert.equal((await importPoster('http://www.impawards.com/tv/posters/pitt.jpg', dir, fake)).path, result.path);
  } finally { await fs.rm(dir, { recursive:true, force:true }); }
});
test('rejects SSRF, external redirects, non-image data and oversized responses', async () => {
  for (const url of ['http://127.0.0.1/tv/pitt.html', 'http://www.impawards.com.evil.test/tv/pitt.html', 'http://www.impawards.com:8080/tv/pitt.html', 'http://user@www.impawards.com/tv/pitt.html']) {
    assert.throws(() => allowedUrl(url), (e) => e.code === 'POSTER_URL_INVALID');
  }
  let calls = 0;
  await assert.rejects(fetchAllowed('http://www.impawards.com/tv/pitt.html', { maxBytes:1000, fetchFn:async () => { calls++; return new Response(null, { status:302, headers:{location:'http://127.0.0.1/private'} }); } }), (e) => e.code === 'POSTER_URL_INVALID');
  assert.equal(calls, 1);
  await assert.rejects(fetchAllowed('http://www.impawards.com/tv/pitt.html', { maxBytes:2, fetchFn:async () => new Response('abc') }), (e) => e.code === 'POSTER_TOO_LARGE');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'poster-test-'));
  try { await assert.rejects(importPoster('http://www.impawards.com/tv/posters/pitt.jpg', dir, async () => new Response('<script>not a picture</script>')), (e) => e.code === 'POSTER_NOT_IMAGE'); }
  finally { await fs.rm(dir, { recursive:true, force:true }); }
});
