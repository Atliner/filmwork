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
