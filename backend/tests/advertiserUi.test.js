'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
async function boot() {
  const dom = new JSDOM(html, { url:'https://example.com/#/advertiser', runScripts:'outside-only', pretendToBeVisual:true });
  const w = dom.window, requests = []; w.scrollTo = () => {}; w.confirm = () => true;
  w.localStorage.setItem('filmwork_session', 'test-token');
  const placements = [
    { placement:'pre_roll',group:'video',asset:'video',label:'پیش از پخش',cpm:50000,currency:'IRR' },
    { placement:'text_home',group:'banner',asset:'text',label:'متنی صفحه اصلی',cpm:50000,currency:'IRR' },
    { placement:'link_file_button',group:'link',asset:'link',label:'دکمه ربات',cpm:50000,currency:'IRR' },
  ];
  let campaigns = [{id:'one',name:'کمپین من',headline:'آگهی',status:'active',budget:1000,spent:50,impressions:2,clicks:1}];
  w.fetch = async (url, options = {}) => {
    requests.push({url:String(url), options}); let data;
    if (url === '/api/config') data = {player:{enabled:true}, placementPrices:placements,maxPriorityMultiplier:4};
    else if (url === '/api/me') data = {user:{id:'1',accountName:'آزمایش'}};
    else if (url === '/api/advertiser/profile') data = {wallet:{balance:1000,currency:'IRR'}, analytics:{},campaigns};
    else if (url === '/api/advertiser/campaigns/one' && options.method === 'DELETE') { campaigns = []; data = {deleted:true}; }
    else throw Error('Unexpected '+url);
    return {ok:true,status:200,json:async () => data};
  };
  w.eval(script);
  async function wait(fn) { for (let i=0;i<100;i++) { const value = fn(); if (value) return value; await new Promise(r=>setTimeout(r,5)); } throw Error('UI not ready'); }
  await wait(() => w.document.querySelector('#campaign-form'));
  return {dom,w,wait,requests};
}
test('advertiser chooses text without a creative URL and can delete their campaign', async () => {
  const {dom,w,wait,requests} = await boot();
  assert.equal(w.document.querySelector('.placement-map'), null);
  w.document.querySelector('[data-placement="text_home"]').click();
  assert.equal(w.document.querySelector('[name="assetType"]').value, 'text');
  assert.equal(w.document.querySelector('[data-creative-field]').hidden, true);
  assert.equal(w.document.querySelector('[name="creativeUrl"]').required, false);
  assert.equal(w.document.querySelector('[name="bidMultiplier"]').max, '4');
  w.document.querySelector('[data-placement="link_file_button"]').click();
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
