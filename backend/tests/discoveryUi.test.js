'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const items = [
  { id:'a', title:'فیلم اول', originalTitle:'First Film', type:'series', imdbScore:9, releaseYear:2020, lastAirYear:2026, posterGallery:['https://m.media-amazon.com/images/M/MV5Babcdef.jpg'], genres:['درام'], directors:['نام فارسی | English Name'], cast:[], description:'یک داستان', countries:['ایران'], hasDub:true, hasSub:true },
  { id:'b', title:'فیلم دوم', originalTitle:'Second Film', type:'movie', imdbScore:6, releaseYear:2022, genres:['درام'], directors:[], cast:[], countries:[] },
];
const facets = { years:{min:2020,max:2022}, ratings:{min:6,max:9}, genres:[{name:'درام',count:2}], countries:['ایران'], ages:['PG'], networks:['Net'] };
async function boot(hash, width = 1100, ads = {}) {
  const dom = new JSDOM(html, { url:`https://example.test/${hash}`, runScripts:'outside-only', pretendToBeVisual:true });
  const w = dom.window; const requests = []; w.scrollTo = () => {}; w.HTMLElement.prototype.getBoundingClientRect = () => ({top:0,left:0,right:100,bottom:100,width:100,height:100}); w.matchMedia = () => ({ matches:width >= 900, addListener(){}, removeListener(){} });
  w.fetch = async (url, options = {}) => {
    const path = String(url); requests.push({path, options}); let data;
    if (path === '/api/config') data = { player:{enabled:true,buttonVisible:true} };
    else if (path === '/api/contents-facets') data = facets;
    else if (/^\/api\/contents\?/.test(path)) data = { items, pagination:{total:2,pages:1} };
    else if (path === '/api/contents/a') data = { content:{...items[0],views:12} };
    else if (path === '/api/contents/a/views') data = { views:13, counted:true };
    else if (path.startsWith('/api/ads/serve?placement=')) data = { ad: ads[path.split('=')[1]] || null };
    else if (/^\/api\/ads\/.+\/events$/.test(path)) data = { accepted:true };
    else if (path.includes('/media-options') || path.includes('/comments')) data = { items:[] };
    else throw Error('Unexpected API: ' + path);
    return { ok:true, status:200, json:async () => data };
  };
  w.eval(script);
  async function wait(selector) {
    for (let i=0;i<40;i++) { const el=w.document.querySelector(selector); if (el) return el; await new Promise((r) => setTimeout(r,5)); }
    throw Error(`Element not rendered: ${selector}; ${w.document.querySelector('#app').textContent}`);
  }
  return { dom, w, wait, requests };
}
test('detail shows both names as one link, with story and facts preceding comments', async () => {
  const { dom, w, wait } = await boot('#/content/a');
  const link = await wait('.detail-credits .name-pair');
  assert.equal(link.querySelectorAll('bdi').length, 2);
  assert.equal(link.textContent.trim(), 'نام فارسی | English Name');
  assert.match(link.getAttribute('href'), /^#\/person\?/);
  assert.equal(link.querySelectorAll('a').length, 0);
  const panels = [...w.document.querySelectorAll('.detail-layout > *')].map((n) => n.className);
  assert.deepEqual(panels, ['detail-story','surface-panel detail-facts','surface-panel detail-comments']);
  dom.window.close();
});
test('optional game starts by choice and gives feedback without extra requests', async () => {
  const { dom, w, wait } = await boot('#/home');
  const start = await wait('[data-game-start]');
  assert.equal(w.document.querySelectorAll('[data-game-answer]').length, 0);
  start.click();
  const answers = w.document.querySelectorAll('[data-game-answer]'); assert.equal(answers.length, 2);
  answers[0].click(); assert.ok(w.document.querySelector('#game-feedback').textContent.includes('چالش بعدی'));
  assert.ok([...answers].every((button) => button.disabled));
  assert.ok(w.document.querySelector('[data-game-next]'));
  w.document.querySelector('[data-game-next]').click(); assert.equal(w.document.querySelectorAll('[data-game-answer]').length, 2);
  dom.window.close();
});
test('mobile search keeps filters accessible, can select and reset', async () => {
  const { dom, w, wait } = await boot('#/search', 390);
  const panel = await wait('.filter-panel'); assert.equal(panel.open, false);
  assert.equal(w.document.querySelectorAll('[data-search-genre]').length, 2);
  panel.open = true;
  const box = w.document.querySelector('[name=country]'); box.checked = true;
  w.document.querySelector('[data-filter-reset]').click(); assert.equal(box.checked, false);
  assert.equal(w.document.querySelector('#search-sort').value, 'recent');
  await new Promise((resolve) => setTimeout(resolve, 20));
  dom.window.close();
});

test('series end year appears on home hero and search card, movies stay single-year', async () => {
  let view = await boot('#/home');
  const hero = await view.wait('.hero-meta'); assert.match(hero.textContent, /2020–2026/);
  view.dom.window.close();
  view = await boot('#/search'); await view.wait('.media-card');
  const cards = view.w.document.querySelectorAll('.media-card'); assert.match(cards[0].textContent, /2020–2026/); assert.match(cards[1].textContent, /2022/); assert.doesNotMatch(cards[1].textContent, /2022–/);
  view.dom.window.close();
});
test('detail displays external poster links from the gallery', async () => {
  const { dom, wait } = await boot('#/content/a');
  const image = await wait('.poster-gallery img'); assert.equal(image.src, 'https://m.media-amazon.com/images/M/MV5Babcdef.jpg');
  dom.window.close();
});

test('detail sends exactly one visit token and displays the acknowledged count', async () => {
  const { dom, w, wait, requests } = await boot('#/content/a');
  await wait('#detail-views');
  for (let i = 0; i < 30 && w.document.querySelector('#detail-views').textContent === '۱۲'; i++) await new Promise((r) => setTimeout(r, 5));
  const views = requests.filter((r) => r.path === '/api/contents/a/views');
  assert.equal(views.length, 1); assert.match(JSON.parse(views[0].options.body).visitId, /^[a-f0-9-]{36}$/);
  assert.equal(w.document.querySelector('#detail-views').textContent, '۱۳');
  dom.window.close();
});
test('home, search and detail show their own text placements and report viewable impressions', async () => {
  for (const [hash, key, selector] of [['#/home','text_home','#ad-text-home'],['#/search','text_search','#ad-text-search'],['#/content/a','text_detail','#ad-text-detail']]) {
    const { dom, w, wait, requests } = await boot(hash, 1100, { [key]:{id:'ad-1', session:'session', tunnelUrl:'/offer', headline:'پیشنهاد ویژه', body:'متن تبلیغ'} });
    await wait(`${selector} .page-ad--text`); await new Promise((r) => setTimeout(r, 20));
    assert.match(w.document.querySelector(selector).textContent, /پیشنهاد ویژه/);
    assert.ok(requests.some((r) => r.path === '/api/ads/ad-1/events' && JSON.parse(r.options.body).eventType === 'impression'));
    dom.window.close();
  }
});
