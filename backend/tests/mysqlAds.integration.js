'use strict';
// Runs against the CI MySQL service after applying schema.sql and migrations.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { query, closePool } = require('../config/db');
const { app } = require('../server');
const { signUserToken, signAdminToken } = require('../lib/security');
const { deliverWithTelegramAd } = require('../services/telegramAds');
let server, base, userId, auth;
const assetId = crypto.randomUUID();

test.before(async () => {
  const u = await query("INSERT INTO users (tg_user_id,tg_chat_id,account_name,encrypted_phone,role) VALUES (12345678,12345678,'test','redacted','advertiser')");
  userId = u.insertId; auth = 'Bearer ' + signUserToken({id:userId,role:'advertiser'});
  await query('INSERT INTO advertiser_wallets (user_id,balance) VALUES (:userId,1000)', {userId});
  await query("INSERT INTO contents (asset_uuid,content_type,title,slug,status) VALUES (:id,'series','test',:slug,'published')", {id:assetId, slug:'test-'+assetId});
  await query("UPDATE ad_placement_prices SET is_enabled=1,is_active=1,price_per_thousand=1000,minimum_budget=1 WHERE placement IN ('link_file_button','text_home')");
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise(resolve=>server.close(resolve)); await closePool(); });
async function request(path, method='GET', body, authorization=auth) {
  const response = await fetch(base+path, {method, redirect:'manual',headers:{...(authorization ? {authorization} : {}), ...(body ? {'content-type':'application/json'} : {})},body:body ? JSON.stringify(body) : undefined});
  const data = await response.clone().json().catch(()=>({}));
  return {response,data};
}
async function createCampaign(placement, budget, extra={}) {
  const startsAt = new Date(Date.now()-60000).toISOString(), endsAt = new Date(Date.now()+3600000).toISOString();
  const result = await request('/api/advertiser/campaigns','POST',{placement, campaignName:'Test campaign', headline:'Test ad', body:'test', budget, startsAt, endsAt, targetUrl:'https://t.me/example_bot', ...extra});
  assert.equal(result.response.status,201,JSON.stringify(result.data));
  const id = result.data.campaign.id; await query("UPDATE ads SET status='active' WHERE public_id=:id",{id}); return id;
}

test('concurrent content view retries increment atomically once per visit', async () => {
  const same = crypto.randomUUID();
  const jobs = [...Array(8)].map(()=>request(`/api/contents/${assetId}/views`,'POST',{visitId:same},''));
  const results = await Promise.all(jobs); assert.ok(results.every(r=>r.response.status === 200));
  assert.equal(results.filter(r=>r.data.counted).length,1);
  await Promise.all([...Array(3)].map(()=>request(`/api/contents/${assetId}/views`,'POST',{visitId:crypto.randomUUID()},'')));
  const rows = await query('SELECT view_count FROM contents WHERE asset_uuid=:id',{id:assetId}); assert.equal(Number(rows[0].view_count),4);
});

test('Telegram concurrent delivery respects budget, tracked clicks dedupe, deletion refunds', async () => {
  const id = await createCampaign('link_file_button','2',{telegramClickMode:'tracked'});
  const buttons = [];
  await Promise.all([...Array(5)].map(()=>deliverWithTelegramAd(userId, async button=>{buttons.push(button); return true;})));
  const tracked = buttons.filter(Boolean); assert.equal(tracked.length,2);
  let rows = await query('SELECT spent,status FROM ads WHERE public_id=:id',{id}); assert.equal(Number(rows[0].spent),2); assert.equal(rows[0].status,'completed');
  const link = new URL(tracked[0].url);
  const clicks = await Promise.all([request(link.pathname+link.search,'GET',undefined,''),request(link.pathname+link.search,'GET',undefined,'')]);
  assert.ok(clicks.every(r=>r.response.status===302 && r.response.headers.get('location')==='https://t.me/example_bot'));
  rows = await query("SELECT event_type,COUNT(*) count FROM ad_events e JOIN ads a ON a.id=e.ad_id WHERE a.public_id=:id GROUP BY event_type",{id});
  assert.equal(Number(rows.find(r=>r.event_type==='impression').count),2); assert.equal(Number(rows.find(r=>r.event_type==='click').count),1);
  const directId = await createCampaign('link_file_button','10',{telegramClickMode:'direct'});
  let button; await deliverWithTelegramAd(userId, async (b)=>{button=b;}); assert.equal(button.url,'https://t.me/example_bot');
  const removed = await request(`/api/advertiser/campaigns/${directId}`,'DELETE'); assert.equal(removed.response.status,200,JSON.stringify(removed.data));
  rows = await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}); assert.equal(Number(rows[0].balance),997);
  rows = await query('SELECT status,deleted_at,spent FROM ads WHERE public_id=:id',{id:directId}); assert.ok(rows[0].deleted_at); assert.equal(Number(rows[0].spent),1);
  const again = await request(`/api/advertiser/campaigns/${directId}`,'DELETE'); assert.equal(again.response.status,404);
});

test('text placements bill the selected bid once per view and count click fallback once', async () => {
  const id = await createCampaign('text_home','10',{bidMultiplier:2});
  const served = await request('/api/ads/serve?placement=text_home','GET',undefined,''); assert.equal(served.data.ad.id,id);
  const ad = served.data.ad;
  const events = await Promise.all([...Array(4)].map(()=>request(`/api/ads/${id}/events`,'POST',{eventType:'impression',session:ad.session},'')));
  assert.equal(events.filter(x=>x.data.accepted).length,1);
  const clicks = await Promise.all([request(ad.tunnelUrl,'GET',undefined,''),request(ad.tunnelUrl,'GET',undefined,'')]); assert.ok(clicks.every(x=>x.response.status===200));
  const rows = await query('SELECT spent,unit_price,bid_multiplier FROM ads WHERE public_id=:id',{id});
  assert.equal(Number(rows[0].spent),2); assert.equal(Number(rows[0].unit_price),2000); assert.equal(Number(rows[0].bid_multiplier),2);
  const counts = await query("SELECT event_type,COUNT(*) count FROM ad_events e JOIN ads a ON a.id=e.ad_id WHERE a.public_id=:id GROUP BY event_type",{id});
  assert.equal(Number(counts.find(x=>x.event_type==='click').count),1);
});

test('admin can remove own and advertiser campaigns, preserving ledger and refunding only paid budget', async () => {
  const csrf = 'integration-csrf';
  const cookie = `filmwork_admin=${signAdminToken('123456789', csrf)}`;
  async function admin(path, method = 'GET', body, token = csrf) {
    const response = await fetch(base+path, {method, headers:{cookie, ...(token ? {'x-csrf-token':token} : {}), ...(body ? {'content-type':'application/json'} : {})}, body:body ? JSON.stringify(body) : undefined});
    return {response, data:await response.json().catch(()=>({}))};
  }
  const created = await admin('/api/admin/ads/campaigns', 'POST', {campaignName:'Owner sample',headline:'Owner ad',placement:'text_home',targetUrl:'https://t.me/example_bot'});
  assert.equal(created.response.status,201,JSON.stringify(created.data));
  const ownerId = created.data.campaign.id;
  const balanceBefore = Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance);
  assert.equal((await request(`/api/admin/ads/campaigns/${ownerId}`,'DELETE',undefined,'')).response.status,404);
  assert.equal((await admin(`/api/admin/ads/campaigns/${ownerId}`,'DELETE',undefined,'wrong')).response.status,403);
  const removed = await admin(`/api/admin/ads/campaigns/${ownerId}`,'DELETE');
  assert.equal(removed.response.status,200,JSON.stringify(removed.data)); assert.equal(removed.data.refunded,0);
  assert.equal(Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance),balanceBefore);
  assert.ok((await query('SELECT deleted_at FROM ads WHERE public_id=:id',{id:ownerId}))[0].deleted_at);
  assert.ok(!(await admin('/api/admin/ads/campaigns')).data.items.some(a=>a.id===ownerId));
  assert.ok(!(await admin('/api/admin/ads')).data.items.some(a=>a.public_id===ownerId));
  assert.equal((await admin(`/api/admin/ads/campaigns/${ownerId}`,'DELETE')).response.status,404);

  const paidId = await createCampaign('text_home','10');
  await query('UPDATE ads SET spent=2 WHERE public_id=:id',{id:paidId});
  const paidRemoved = await admin(`/api/admin/ads/campaigns/${paidId}`,'DELETE');
  assert.equal(paidRemoved.response.status,200,JSON.stringify(paidRemoved.data)); assert.equal(paidRemoved.data.refunded,8);
  assert.equal(Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance),balanceBefore-2);
  const ledger = await query('SELECT transaction_type, amount FROM wallet_transactions t JOIN ads a ON a.id=t.ad_id WHERE a.public_id=:id',{id:paidId});
  assert.ok(ledger.some(x=>x.transaction_type==='campaign_reserve' && Number(x.amount)===10));
  assert.ok(ledger.some(x=>x.transaction_type==='refund' && Number(x.amount)===8));
});

test('multiple placements share one reservation and charge their own rates atomically', async () => {
  await query("UPDATE ads SET status='paused' WHERE status='active'");
  await query("UPDATE ad_placement_prices SET is_enabled=1,is_active=1,minimum_budget=1,price_per_thousand=IF(placement='text_home',1000,1500) WHERE placement IN ('text_home','text_search')");
  const balanceBefore=Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance);
  const id = await createCampaign('text_home','7',{placements:['text_home','text_search'],bidMultiplier:2,landingMode:'direct'});
  assert.equal(Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance), balanceBefore-7);
  const slots=await query('SELECT ap.placement,ap.unit_price FROM ad_campaign_placements ap JOIN ads a ON a.id=ap.ad_id WHERE a.public_id=:id ORDER BY ap.placement',{id});
  assert.deepEqual(slots.map(row=>[row.placement,Number(row.unit_price)]),[['text_home',2000],['text_search',3000]]);
  const home=(await request('/api/ads/serve?placement=text_home','GET',undefined,'')).data.ad;
  const search=(await request('/api/ads/serve?placement=text_search','GET',undefined,'')).data.ad;
  assert.equal(home.id,id); assert.equal(search.id,id);
  const events = await Promise.all([...Array(4)].flatMap(()=>[home,search].map(ad=>request(`/api/ads/${id}/events`,'POST',{eventType:'impression',session:ad.session},''))));
  assert.equal(events.filter(e=>e.data.accepted).length,2);
  let rows=await query('SELECT spent,status FROM ads WHERE public_id=:id',{id}); assert.equal(Number(rows[0].spent),5);
  const click=await request(home.tunnelUrl,'GET',undefined,''); assert.equal(click.response.status,302); assert.equal(click.response.headers.get('location'),'https://t.me/example_bot');
  const again=(await request('/api/ads/serve?placement=text_home','GET',undefined,'')).data.ad;
  await request(`/api/ads/${id}/events`,'POST',{eventType:'impression',session:again.session},'');
  rows=await query('SELECT spent,status FROM ads WHERE public_id=:id',{id}); assert.equal(Number(rows[0].spent),7); assert.equal(rows[0].status,'completed');
  assert.equal((await request('/api/ads/serve?placement=text_search','GET',undefined,'')).data.ad,null);
  const counts=await query("SELECT e.placement,COUNT(*) AS count FROM ad_events e JOIN ads a ON a.id=e.ad_id WHERE a.public_id=:id AND e.event_type='impression' GROUP BY e.placement ORDER BY e.placement",{id});
  assert.deepEqual(counts.map(row=>[row.placement,Number(row.count)]),[['text_home',2],['text_search',1]]);
  const ledger=await query("SELECT COUNT(*) AS count FROM wallet_transactions t JOIN ads a ON a.id=t.ad_id WHERE a.public_id=:id AND t.transaction_type='campaign_reserve'",{id}); assert.equal(Number(ledger[0].count),1);
});

test('invalid multi-slot submissions do not reserve funds; owner can publish several slots', async () => {
  const balance=Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance);
  const dates={startsAt:new Date(Date.now()-1000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()};
  const baseBody={campaignName:'Bad slots',headline:'bad ad',budget:'10',targetUrl:'https://t.me/example_bot',...dates};
  for (const placements of [['text_home','pre_roll'],['text_home','banner_home']]) {
    const bad=await request('/api/advertiser/campaigns','POST',{...baseBody,placements}); assert.equal(bad.response.status,422);
  }
  assert.equal(Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance),balance);
  const csrf='integration-csrf'; const cookie=`filmwork_admin=${signAdminToken('123456789',csrf)}`;
  const response=await fetch(`${base}/api/admin/ads/campaigns`, {method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({campaignName:'Owner multi',headline:'owner ad',placements:['text_home','text_search'],landingMode:'intermediate',telegramPostText:'example'})});
  const data=await response.json(); assert.equal(response.status,201,JSON.stringify(data));
  const rows=await query('SELECT ap.placement FROM ad_campaign_placements ap JOIN ads a ON a.id=ap.ad_id WHERE a.public_id=:id ORDER BY ap.placement',{id:data.campaign.id}); assert.deepEqual(rows.map(row=>row.placement),['text_home','text_search']);
  const land=await request(`/api/ad-tunnel/${data.campaign.id}`,'GET',undefined,''); assert.equal(land.response.status,200);
});

// An old deployment that copied JS without applying SQL must be identifiable.
test('missing ad migrations produce actionable errors and owner diagnostics', async () => {
  const cookie = `filmwork_admin=${signAdminToken('123456789', 'integration-csrf')}`;
  async function diagnostics() {
    const response = await fetch(`${base}/api/admin/diagnostics`, {headers:{cookie}});
    assert.equal(response.status,200); return response.json();
  }
  let report = await diagnostics();
  assert.equal(report.migrations.contentViewReceipts,true);
  assert.equal(report.migrations.adSoftDelete,true);
  assert.equal(report.migrations.adPageBidding,true);
  await query('ALTER TABLE ads DROP COLUMN telegram_click_mode');
  try {
    const result = await request('/api/advertiser/profile');
    assert.equal(result.response.status,503,JSON.stringify(result.data));
    assert.equal(result.data.error.code,'AD_SCHEMA_UNAVAILABLE');
    assert.match(result.data.error.message,/پایگاه داده/);
    assert.ok(result.data.error.requestId);
    report = await diagnostics(); assert.equal(report.migrations.adPageBidding,false);
    assert.ok(report.checks.some(c => !c.ok && /2026-11-page-ads-bidding/.test(c.detail || '')));
  } finally {
    await query("ALTER TABLE ads ADD COLUMN telegram_click_mode ENUM('tracked','direct') NOT NULL DEFAULT 'tracked' AFTER target_url");
  }
  await query('ALTER TABLE ads DROP COLUMN deleted_at');
  try {
    const result = await request('/api/advertiser/profile');
    assert.equal(result.response.status,503,JSON.stringify(result.data));
    assert.equal(result.data.error.code,'AD_SCHEMA_UNAVAILABLE');
    report = await diagnostics(); assert.equal(report.migrations.adSoftDelete,false);
    assert.ok(report.checks.some(c => !c.ok && /2026-11-soft-delete/.test(c.detail || '')));
  } finally {
    await query('ALTER TABLE ads ADD COLUMN deleted_at TIMESTAMP(3) NULL AFTER reviewed_at');
  }
});
