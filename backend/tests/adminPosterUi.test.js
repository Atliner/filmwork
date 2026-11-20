'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'private/admin.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'private/admin.js'), 'utf8');
const importedPath = `/uploads/posters/${'a'.repeat(64)}.jpg`;
async function setup() {
  const dom = new JSDOM(html, { url:'https://film.test/owner-console#/edit/asset', runScripts:'outside-only', pretendToBeVisual:true });
  const w = dom.window; w.scrollTo = () => {}; let saved = null; const requests = [];
  w.fetch = async (url, options = {}) => {
    requests.push({ url, ...options }); let data;
    if (url === '/api/admin/session') data = { csrfToken:'test' };
    else if (url === '/api/admin/stats') data = { overview:{totals:{contents:1,pendingAds:0}} };
    else if (url === '/api/admin/contents/asset' && options.method === 'PATCH') { saved = JSON.parse(options.body); data = {}; }
    else if (url === '/api/admin/contents/asset') data = { content:{ id:'asset', type:'series', title:'پیت', originalTitle:'The Pitt', status:'published', releaseYear:2025, lastAirYear:2026, directors:[],cast:[],genres:[],countries:[],posterGallery:[] }, versions:[] };
    else if (url === '/api/admin/import-poster') data = { path:importedPath };
    else throw new Error(`unexpected ${url}`);
    return { ok:true, status:200, json:async () => data };
  };
  w.eval(script);
  const wait = async (fn) => { for (let i=0;i<100;i++) { const result=fn(); if(result) return result; await new Promise((r) => setTimeout(r,5)); } throw new Error('UI did not reach expected state'); };
  await wait(() => w.document.querySelector('[data-poster-input]'));
  return { dom, w, wait, requests, getSaved:() => saved };
}
test('main IMPAwards page is imported to a same-origin URL before content save', async () => {
  const { dom, w, wait, requests, getSaved } = await setup();
  const input = w.document.querySelector('[data-poster-input]'); input.value = 'http://www.impawards.com/tv/pitt.html';
  input.dispatchEvent(new w.Event('input', { bubbles:true }));
  w.document.querySelector('[data-save-content]').click();
  const saved = await wait(getSaved);
  assert.equal(saved.posterUrl, `https://film.test${importedPath}`);
  const request = requests.find((r) => r.url === '/api/admin/import-poster');
  assert.equal(JSON.parse(request.body).url, 'http://www.impawards.com/tv/pitt.html');
  await new Promise((resolve) => setTimeout(resolve, 30)); dom.window.close();
});
test('gallery accepts an IMPAwards page and uses imported URL for preview', async () => {
  const { dom, w, wait } = await setup();
  const input = w.document.querySelector('[data-gallery-input]'); input.value = 'http://www.impawards.com/tv/silo_ver5.html';
  w.document.querySelector('[data-add-gallery]').click();
  const preview = await wait(() => w.document.querySelector('.gallery-tile img'));
  assert.equal(preview.src, `https://film.test${importedPath}`);
  dom.window.close();
});
