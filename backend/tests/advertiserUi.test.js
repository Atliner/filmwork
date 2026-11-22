'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
async function boot({ profileError = false } = {}) {
  const dom = new JSDOM(html, { url:'https://example.com/#/advertiser', runScripts:'outside-only', pretendToBeVisual:true });
  const w = dom.window, requests = []; w.scrollTo = () => {}; w.confirm = () => true;
  w.localStorage.setItem('filmwork_session', 'test-token');
  const placements = [
    { placement:'pre_roll',group:'video',asset:'video',label:'پیش از پخش',cpm:50000,currency:'IRR' },
    { placement:'text_home',group:'banner',asset:'text',label:'متنی صفحه اصلی',cpm:50000,currency:'IRR' },
    { placement:'text_search',group:'banner',asset:'text',label:'متنی جستجو',cpm:40000,currency:'IRR' },
    { placement:'link_file_button',group:'link',asset:'link',label:'دکمه ربات',cpm:50000,currency:'IRR' },
  ];
  let campaigns = [{id:'one',name:'کمپین من',headline:'آگهی',status:'active',budget:1000,spent:50,impressions:2,clicks:1}];
  w.fetch = async (url, options = {}) => {
    requests.push({url:String(url), options}); let data;
    if (url === '/api/config') data = {player:{enabled:true}, placementPrices:placements,maxPriorityMultiplier:4};
    else if (url === '/api/me') data = {user:{id:'1',accountName:'آزمایش'}};
    else if (url === '/api/advertiser/profile' && profileError) return {ok:false,status:503,json:async () => ({error:{message:'ساختار پایگاه دادهٔ تبلیغات کامل نیست',code:'AD_SCHEMA_UNAVAILABLE',requestId:'12345678-1234-4123-8123-123456789abc'}})};
    else if (url === '/api/advertiser/profile') data = {wallet:{balance:1000,currency:'IRR'}, analytics:{},campaigns};
    else if (url === '/api/advertiser/campaigns' && options.method === 'POST') data = {campaign:{id:'new'}};
    else if (url === '/api/advertiser/campaigns/one' && options.method === 'DELETE') { campaigns = []; data = {deleted:true}; }
    else throw Error('Unexpected '+url);
    return {ok:true,status:200,json:async () => data};
  };
  w.eval(script);
  async function wait(fn) { for (let i=0;i<100;i++) { const value = fn(); if (value) return value; await new Promise(r=>setTimeout(r,5)); } throw Error('UI not ready'); }
  await wait(() => profileError ? w.document.body.textContent.includes('شناسه پیگیری') : w.document.querySelector('#campaign-form'));
  return {dom,w,wait,requests};
}
test('advertiser chooses text without a creative URL and can delete their campaign', async () => {
  const {dom,w,wait,requests} = await boot();
  assert.equal(w.document.querySelector('.placement-map'), null);
  const type = w.document.querySelector('[name="creativeType"]');
  type.value = 'text'; type.dispatchEvent(new w.Event('change', {bubbles:true}));
  assert.equal(w.document.querySelector('[data-slot-type="text"]').hidden, false);
  assert.equal(w.document.querySelector('[data-slot-type="video"]').hidden, true);
  assert.equal(w.document.querySelector('[data-creative-field]').hidden, true);
  assert.equal(w.document.querySelector('[name="creativeUrl"]').required, false);
  assert.equal(w.document.querySelector('[name="bidMultiplier"]').max, '4');
  type.value = 'link'; type.dispatchEvent(new w.Event('change', {bubbles:true}));
  assert.equal(w.document.querySelector('[data-telegram-mode]').hidden, false);
  assert.equal(w.document.querySelector('[data-bid-field]').hidden, true);
  assert.equal(w.document.querySelector('[name="targetUrl"]').required, true);
  assert.equal(w.document.querySelector('[data-creative-field]').hidden, true);
  w.document.querySelector('[data-campaign-delete="one"]').click();
  await wait(() => requests.find((req) => req.url === '/api/advertiser/campaigns/one' && req.options.method === 'DELETE'));
  await wait(() => !w.document.querySelector('[data-campaign-delete="one"]') && w.document.querySelector('#campaign-form'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  dom.window.close();
});

test('advertiser sees a safe request identifier for server failures', async () => {
  const {dom,w} = await boot({profileError:true});
  assert.match(w.document.body.textContent, /ساختار پایگاه دادهٔ تبلیغات کامل نیست/);
  assert.match(w.document.body.textContent, /12345678-1234-4123-8123-123456789abc/);
  dom.window.close();
});

test('one form submits multiple compatible placements and a single shared budget, with optional landing page', async () => {
  const {dom,w,wait,requests} = await boot();
  const form = w.document.querySelector('#campaign-form');
  const type = form.querySelector('[name=creativeType]'); type.value='text'; type.dispatchEvent(new w.Event('change',{bubbles:true}));
  form.querySelector('[value=text_home]').checked = true; form.querySelector('[value=text_search]').checked = true;
  const landing=form.querySelector('[name=landingMode]');
  assert.equal(form.querySelector('[data-landing-fields]').hidden, true);
  landing.value='intermediate'; landing.dispatchEvent(new w.Event('change',{bubbles:true}));
  assert.equal(form.querySelector('[data-landing-fields]').hidden, false);
  form.querySelector('[name=campaignName]').value='کمپین آزمایش'; form.querySelector('[name=headline]').value='آگهی آزمایش';
  form.querySelector('[name=budget]').value='100000'; form.querySelector('[name=telegramPostText]').value='صفحهٔ واسط';
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  const req = await wait(()=>requests.find(r=>r.url==='/api/advertiser/campaigns' && r.options.method==='POST'));
  const body=JSON.parse(req.options.body); assert.deepEqual(body.placements,['text_home','text_search']);
  assert.equal(body.budget,'100000'); assert.equal(body.landingMode,'intermediate'); assert.equal(body.telegramPostText,'صفحهٔ واسط');
  await new Promise(resolve=>setTimeout(resolve,30)); dom.window.close();
});
