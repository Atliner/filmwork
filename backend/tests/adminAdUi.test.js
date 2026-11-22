'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'private/admin.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'private/admin.js'), 'utf8');
async function setup(view = 'adsettings') {
  const dom = new JSDOM(html, {url:`https://film.test/owner-console#/${view}`,runScripts:'outside-only',pretendToBeVisual:true});
  const w = dom.window, requests = [];
  let campaigns = [
    {id:'owner-1',campaignName:'مالک',headline:'مالک',status:'active',ownerCampaign:true,placement:'text_home',group:'banner',assetType:'image'},
    {id:'paid-2',campaignName:'مشتری',headline:'مشتری',status:'pending',ownerCampaign:false,placement:'text_home',group:'banner',assetType:'image',budget:1000},
  ];
  w.scrollTo = () => {};
  w.fetch = async (url, options={}) => {
    requests.push({url, ...options}); let data;
    if (url === '/api/admin/session') data = {csrfToken:'secret-csrf'};
    else if (url === '/api/admin/stats') data = {overview:{totals:{contents:0,pendingAds:1}}};
    else if (url === '/api/admin/ads/settings') data = {settings:{}, placements:[], groups:[], policy:{}};
    else if (url === '/api/admin/ads/dashboard') data = {totals:{},byGroup:[]};
    else if (url === '/api/admin/ads/campaigns') data = {items:campaigns};
    else if (url === '/api/admin/ads') data = {items:campaigns.map(c => ({public_id:c.id,campaign_name:c.campaignName,headline:c.headline,status:c.status,placement:c.placement,budget:c.budget}))};
    else if (String(url).startsWith('/api/admin/ads/campaigns/') && options.method === 'DELETE') {
      campaigns = campaigns.filter(c => c.id !== String(url).split('/').pop()); data = {deleted:true};
    } else if (url === '/api/admin/ads/campaigns/paid-2/review' && options.method === 'POST') {
      const ad=campaigns.find(c=>c.id==='paid-2'); ad.status='rejected'; data={status:'rejected'};
    } else throw new Error(`unexpected ${url}`);
    return {ok:true,status:200,json:async()=>data};
  };
  w.eval(script);
  const wait = async fn => {for (let i=0;i<100;i++){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw new Error('UI did not reach expected state');};
  await wait(()=>view === 'adsettings' ? w.document.querySelector('[data-ad-tab="owner"]') : w.document.querySelector('[data-ad-delete="owner-1"]'));
  return {dom,w,wait,requests};
}

test('owner can cancel and then confirm their campaign deletion in settings', async () => {
  const {dom,w,wait,requests} = await setup();
  w.document.querySelector('[data-ad-tab="owner"]').click();
  w.document.querySelector('[data-ad-delete="owner-1"]').click();
  w.document.querySelector('.modal [data-close]').click();
  await new Promise(r=>setTimeout(r,20));
  assert.ok(!requests.some(r=>r.method==='DELETE'));
  w.document.querySelector('[data-ad-delete="owner-1"]').click();
  w.document.querySelector('.modal [data-confirm]').click();
  const deletion = await wait(()=>requests.find(r=>r.url==='/api/admin/ads/campaigns/owner-1' && r.method==='DELETE'));
  assert.equal(deletion.headers['X-CSRF-Token'],'secret-csrf');
  await wait(()=>!w.document.querySelector('[data-ad-delete="owner-1"]') && w.document.querySelector('[data-ad-tab="owner"]'));
  dom.window.close();
});

test('owner can delete a campaign from the main ads table', async () => {
  const {dom,w,wait,requests} = await setup('ads');
  w.document.querySelector('[data-ad-delete="owner-1"]').click();
  w.document.querySelector('.modal [data-confirm]').click();
  await wait(()=>requests.find(r=>r.url==='/api/admin/ads/campaigns/owner-1' && r.method==='DELETE'));
  await wait(()=>w.document.querySelector('[data-ad-delete="paid-2"]') && !w.document.querySelector('[data-ad-delete="owner-1"]'));
  dom.window.close();
});

test('the shared confirmation dialog permits rejecting a pending advertiser campaign', async () => {
  const {dom,w,wait,requests} = await setup();
  w.document.querySelector('[data-ad-tab="review"]').click();
  w.document.querySelector('[data-ad-review="rejected"]').click();
  w.document.querySelector('.modal [data-confirm]').click();
  const review = await wait(()=>requests.find(r=>r.url==='/api/admin/ads/campaigns/paid-2/review'));
  assert.equal(JSON.parse(review.body).status,'rejected');
  await wait(()=>w.document.querySelector('[data-ad-tab="review"]') && !w.document.querySelector('[data-ad-review="rejected"]'));
  dom.window.close();
});
