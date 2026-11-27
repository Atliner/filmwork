'use strict';
// Runs against the CI MySQL service after applying schema.sql and migrations.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const {changeCampaignStatus} = require('../services/adAccounting');
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
  rows = await query('SELECT * FROM ads WHERE public_id=:id',{id:directId}); assert.equal(rows.length,0);
  rows = await query('SELECT spent FROM ad_financial_archive WHERE campaign_public_id=:id',{id:directId}); assert.equal(Number(rows[0].spent),1);
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
  assert.equal((await query('SELECT id FROM ads WHERE public_id=:id',{id:ownerId})).length,0);
  assert.ok(!(await admin('/api/admin/ads/campaigns')).data.items.some(a=>a.id===ownerId));
  assert.ok(!(await admin('/api/admin/ads')).data.items.some(a=>a.public_id===ownerId));
  assert.equal((await admin(`/api/admin/ads/campaigns/${ownerId}`,'DELETE')).response.status,404);

  const paidId = await createCampaign('text_home','10');
  await query('UPDATE ads SET spent=2 WHERE public_id=:id',{id:paidId});
  const internalId=(await query('SELECT id FROM ads WHERE public_id=:id',{id:paidId}))[0].id;
  await query("INSERT INTO ad_events (ad_id,event_type,session_key) VALUES (:adId,'impression',:session)",{adId:internalId,session:'a'.repeat(64)});
  await query("INSERT INTO admin_events (kind,title,ad_public_id) VALUES ('ad','کمپین بررسی شد',:id)",{id:paidId});
  const paidRemoved = await admin(`/api/admin/ads/campaigns/${paidId}`,'DELETE');
  assert.equal(paidRemoved.response.status,200,JSON.stringify(paidRemoved.data)); assert.equal(paidRemoved.data.refunded,8);
  assert.equal(Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance),balanceBefore-2);
  const ledger = await query('SELECT transaction_type, amount, ad_id FROM wallet_transactions WHERE campaign_public_id=:id',{id:paidId});
  assert.ok(ledger.every(row=>row.ad_id === null));
  const archived=await query('SELECT budget,spent FROM ad_financial_archive WHERE campaign_public_id=:id',{id:paidId}); assert.equal(Number(archived[0].budget),10); assert.equal(Number(archived[0].spent),2);
  assert.equal((await query('SELECT id FROM ads WHERE public_id=:id',{id:paidId})).length,0);
  assert.equal((await query('SELECT id FROM ad_events WHERE ad_id=:id',{id:internalId})).length,0);
  assert.equal((await query('SELECT ad_id FROM ad_campaign_placements WHERE ad_id=:id',{id:internalId})).length,0);
  assert.equal((await query('SELECT id FROM admin_events WHERE ad_public_id=:id',{id:paidId})).length,0);
  const rates=await query('SELECT placement,unit_price FROM ad_financial_placement_rates WHERE campaign_public_id=:id',{id:paidId}); assert.equal(rates[0].placement,'text_home');
  assert.ok(ledger.some(x=>x.transaction_type==='campaign_reserve' && Number(x.amount)===10));
  assert.ok(ledger.some(x=>x.transaction_type==='refund' && Number(x.amount)===8));
});

test('admin can toggle a slot repeatedly, including a missing catalogue row', async () => {
  const csrf='integration-csrf'; const cookie=`filmwork_admin=${signAdminToken('123456789',csrf)}`;
  async function admin(path,method='GET',body) { const response=await fetch(base+path,{method,headers:{cookie,'x-csrf-token':csrf,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}); return {response,data:await response.json()}; }
  for (const enabled of [false,true,false,true]) {
    const changed=await admin('/api/admin/ads/placements/banner_player','PATCH',{enabled}); assert.equal(changed.response.status,200,JSON.stringify(changed.data));
    const fresh=await admin('/api/admin/ads/settings'); const row=fresh.data.placements.find(x=>x.placement==='banner_player'); assert.equal(row.enabled,enabled); assert.equal(row.active,enabled);
    const db=(await query("SELECT is_enabled,is_active FROM ad_placement_prices WHERE placement='banner_player'"))[0]; assert.equal(Boolean(db.is_enabled),enabled); assert.equal(Boolean(db.is_active),enabled);
  }
  await query("DELETE FROM ad_placement_prices WHERE placement='banner_search'");
  const inserted=await admin('/api/admin/ads/placements/banner_search','PATCH',{enabled:true}); assert.equal(inserted.response.status,200,JSON.stringify(inserted.data));
  assert.equal((await admin('/api/admin/ads/settings')).data.placements.find(x=>x.placement==='banner_search').enabled,true);
});

test('content deletion cascades all dependent records while another title remains', async () => {
  const csrf='integration-csrf',cookie=`filmwork_admin=${signAdminToken('123456789',csrf)}`;
  const id=crypto.randomUUID(), other=crypto.randomUUID();
  const c=await query("INSERT INTO contents (asset_uuid,content_type,title,slug,status) VALUES (:id,'movie','delete fixture',:id,'published')",{id});
  const otherRow=await query("INSERT INTO contents (asset_uuid,content_type,title,slug,status) VALUES (:id,'movie','other fixture',:id,'published')",{id:other});
  const m=await query("INSERT INTO media_links (public_id,content_id,version_label,resolution,file_size_bytes) VALUES (:id,:contentId,'fixture','720p',100)",{id:crypto.randomUUID(),contentId:c.insertId});
  const v=await query("INSERT INTO content_versions (content_id,kind,title) VALUES (:contentId,'sub','fixture')",{contentId:c.insertId});
  await query("INSERT INTO content_version_links (version_id,media_link_id,stream_url) VALUES (:versionId,:mediaId,'https://example.test/file')",{versionId:v.insertId,mediaId:m.insertId});
  await query("INSERT INTO comments (content_id,user_id,body) VALUES (:id,:userId,'fixture')",{id:c.insertId,userId});
  await query("INSERT INTO favorites (content_id,user_id) VALUES (:id,:userId)",{id:c.insertId,userId});
  await query("INSERT INTO playback_progress (content_id,user_id) VALUES (:id,:userId)",{id:c.insertId,userId});
  await query("INSERT INTO download_history (user_id,media_link_id,delivery_method) VALUES (:userId,:id,'telegram_copy')",{id:m.insertId,userId});
  await query("INSERT INTO media_health_events (media_link_id,reason) VALUES (:id,'fixture')",{id:m.insertId});
  await query("INSERT INTO content_view_receipts (content_id,visit_id) VALUES (:id,:uuid)",{id:c.insertId,uuid:crypto.randomUUID()});
  await query("INSERT INTO admin_events (kind,title,content_asset_id) VALUES ('content','fixture',:id),('content','other',:other)",{id,other});
  const response=await fetch(`${base}/api/admin/contents/${id}`,{method:'DELETE',headers:{cookie,'x-csrf-token':csrf}}); assert.equal(response.status,200,await response.text());
  for (const [table,column,value] of [['contents','id',c.insertId],['media_links','id',m.insertId],['content_versions','id',v.insertId],['content_version_links','version_id',v.insertId],['comments','content_id',c.insertId],['favorites','content_id',c.insertId],['playback_progress','content_id',c.insertId],['download_history','media_link_id',m.insertId],['media_health_events','media_link_id',m.insertId],['content_view_receipts','content_id',c.insertId]]) {
    assert.equal(Number((await query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=:value`,{value}))[0].n),0,table);
  }
  assert.equal((await query('SELECT id FROM admin_events WHERE content_asset_id=:id',{id})).length,0);
  assert.equal((await query('SELECT id FROM admin_events WHERE content_asset_id=:id',{id:other})).length,1);
  assert.equal((await query('SELECT id FROM contents WHERE id=:id',{id:otherRow.insertId})).length,1);
});

test('financial failure rolls back refund and permanent campaign deletion', async () => {
  const id=await createCampaign('text_home','10');
  const before=Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance);
  await query(`INSERT INTO ad_financial_archive (campaign_public_id,advertiser_id,owner_campaign,primary_placement,budget,spent,status_at_deletion,created_at)
    SELECT public_id,advertiser_id,owner_campaign,placement,budget,spent,status,created_at FROM ads WHERE public_id=:id`,{id});
  const failed=await request(`/api/advertiser/campaigns/${id}`,'DELETE'); assert.notEqual(failed.response.status,200);
  assert.equal(Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance),before);
  assert.equal((await query('SELECT id FROM ads WHERE public_id=:id',{id})).length,1);
  assert.equal((await query("SELECT id FROM wallet_transactions WHERE reference=:reference",{reference:`campaign-refund:${id}`})).length,0);
  await query('DELETE FROM ad_financial_archive WHERE campaign_public_id=:id',{id});
  assert.equal((await request(`/api/advertiser/campaigns/${id}`,'DELETE')).response.status,200);
});

test('legacy maintenance refuses unverifiable refunds without deleting anything', async () => {
  const id=await createCampaign('text_home','10');
  await query('UPDATE ads SET deleted_at=UTC_TIMESTAMP(3) WHERE public_id=:id',{id});
  const script=path.join(__dirname,'../scripts/purge-legacy-deletions.js');
  assert.throws(()=>execFileSync(process.execPath,[script,'--execute'],{encoding:'utf8',env:process.env,stdio:'pipe'}));
  assert.equal((await query('SELECT id FROM ads WHERE public_id=:id',{id})).length,1);
  await query('UPDATE ads SET deleted_at=NULL WHERE public_id=:id',{id});
  assert.equal((await request(`/api/advertiser/campaigns/${id}`,'DELETE')).response.status,200);
});

test('maintenance dry-run and approved purge preserve already-refunded finances', async () => {
  const id=await createCampaign('text_home','10');
  await query('UPDATE ads SET spent=2 WHERE public_id=:id',{id});
  await changeCampaignStatus(id,'completed');
  await query('UPDATE ads SET deleted_at=UTC_TIMESTAMP(3) WHERE public_id=:id',{id});
  await query("INSERT INTO admin_events (kind,title) VALUES ('content','legacy activity'),('media','legacy media'),('ad','کمپین مالک ساخته شد'),('ad','تنظیمات تبلیغات ذخیره شد')");
  const before=Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance);
  const script=path.join(__dirname,'../scripts/purge-legacy-deletions.js');
  const dry=execFileSync(process.execPath,[script],{encoding:'utf8',env:process.env}); assert.match(dry,/Dry run/);
  assert.equal((await query('SELECT id FROM ads WHERE public_id=:id',{id})).length,1);
  execFileSync(process.execPath,[script,'--execute'],{encoding:'utf8',env:process.env});
  assert.equal((await query('SELECT id FROM ads WHERE public_id=:id',{id})).length,0);
  assert.equal(Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance),before);
  const ledger=await query('SELECT transaction_type,amount FROM wallet_transactions WHERE campaign_public_id=:id',{id});
  assert.equal(ledger.filter(row=>row.transaction_type==='refund').length,1);
  assert.equal(Number(ledger.find(row=>row.transaction_type==='refund').amount),8);
  assert.equal((await query("SELECT id FROM admin_events WHERE kind IN ('content','media') AND content_asset_id IS NULL")).length,0);
  assert.equal((await query("SELECT id FROM admin_events WHERE kind='ad' AND ad_public_id IS NULL AND title LIKE 'کمپین %'")).length,0);
  assert.ok((await query("SELECT id FROM admin_events WHERE kind='ad' AND title='تنظیمات تبلیغات ذخیره شد'")).length>0);
  assert.equal((await query('SELECT campaign_public_id FROM ad_financial_archive WHERE campaign_public_id=:id',{id})).length,1);
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
  for (const placements of [['text_home','pre_roll'],['text_home','text_detail']]) {
    const bad=await request('/api/advertiser/campaigns','POST',{...baseBody,placements}); assert.equal(bad.response.status,422);
  }
  assert.equal(Number((await query('SELECT balance FROM advertiser_wallets WHERE user_id=:userId',{userId}))[0].balance),balance);
  const csrf='integration-csrf'; const cookie=`filmwork_admin=${signAdminToken('123456789',csrf)}`;
  const response=await fetch(`${base}/api/admin/ads/campaigns`, {method:'POST',headers:{cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({campaignName:'Owner multi',headline:'owner ad',placements:['text_home','text_search'],landingMode:'intermediate',telegramPostText:'example'})});
  const data=await response.json(); assert.equal(response.status,201,JSON.stringify(data));
  const rows=await query('SELECT ap.placement FROM ad_campaign_placements ap JOIN ads a ON a.id=ap.ad_id WHERE a.public_id=:id ORDER BY ap.placement',{id:data.campaign.id}); assert.deepEqual(rows.map(row=>row.placement),['text_home','text_search']);
  const land=await request(`/api/ad-tunnel/${data.campaign.id}`,'GET',undefined,''); assert.equal(land.response.status,200);
});

test('pause only serves image and download video has its own selectable placement', async () => {
  await query("UPDATE ad_placement_prices SET is_enabled=1,is_active=1,price_per_thousand=1000,minimum_budget=1 WHERE placement IN ('banner_pause','video_download','banner_download')");
  const video=await createCampaign('video_download','10',{assetType:'video',creativeUrl:'https://example.com/ad.mp4',bidMultiplier:10});
  const image=await createCampaign('banner_pause','10',{assetType:'image',creativeUrl:'https://example.com/ad.jpg'});
  const banner=await createCampaign('banner_download','10',{assetType:'image',creativeUrl:'https://example.com/download.jpg'});
  for (const [slot,id,type] of [['video_download',video,'video'],['banner_pause',image,'image'],['banner_download',banner,'image']]) {
    const response=await request(`/api/ads/serve?placement=${slot}`,'GET',undefined,''); assert.equal(response.data.ad.id,id); assert.equal(response.data.ad.assetType,type);
  }
  assert.equal((await request('/api/ads/serve?placement=pause_overlay','GET',undefined,'')).data.ad,null);
  const dates={startsAt:new Date(Date.now()-1000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()};
  const bad=await request('/api/advertiser/campaigns','POST',{placement:'banner_pause',campaignName:'Invalid pause',headline:'Invalid',budget:'10',assetType:'video',creativeUrl:'https://example.com/ad.mp4',...dates});
  assert.equal(bad.response.status,422);
});

// An old deployment that copied JS without applying SQL must be identifiable.
test('missing ad migrations produce actionable errors and owner diagnostics', async () => {
  const cookie = `filmwork_admin=${signAdminToken('123456789', 'integration-csrf')}`;
  async function diagnostics() {
    const response = await fetch(`${base}/api/admin/diagnostics`, {headers:{cookie}});
    assert.equal(response.status,200); return response.json();
  }
  let report = await diagnostics();
  assert.equal(report.migrations.contentVersions,true);
  assert.equal(report.migrations.ownerConsoleV2,true);
  assert.ok(report.checks.some(c => c.ok && c.name === 'ساختار پنل نسخه ۲'));
  await query('ALTER TABLE contents DROP COLUMN broadcast_note');
  try {
    report = await diagnostics(); assert.equal(report.migrations.ownerConsoleV2,false);
    assert.ok(report.checks.some(c => !c.ok && (c.detail || '').includes('contents.broadcast_note')));
  } finally { await query('ALTER TABLE contents ADD COLUMN broadcast_note VARCHAR(120) NULL'); }
  assert.equal(report.migrations.contentViewReceipts,true);
  assert.equal(report.migrations.adSoftDelete,true);
  assert.equal(report.migrations.adPageBidding,true);
  assert.equal(report.migrations.pauseBannerDownloadVideo,true);
  await query("DELETE FROM ad_placement_prices WHERE placement='video_download'");
  try { report = await diagnostics(); assert.equal(report.migrations.pauseBannerDownloadVideo,false); assert.ok(report.checks.some(c => !c.ok && /2026-11-pause-banner-download-video/.test(c.detail || ''))); }
  finally { await query("INSERT INTO ad_placement_prices (placement,slot_group,display_name_fa,price_per_thousand,minimum_budget) VALUES ('video_download','video','ویدیو قبل از دانلود',50000,50000)"); }
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

test('database leader lock allows one bot worker and hands over after shutdown', async () => {
  const { pool } = require('../config/db');
  const { BotLeader } = require('../lib/botLeader');
  const name = `filmwork-test:${crypto.randomBytes(8).toString('hex')}`;
  const first = new BotLeader(pool, async () => {}, { name });
  const second = new BotLeader(pool, async () => {}, { name });
  try {
    assert.equal(await first.acquire(), true);
    assert.equal(await second.acquire(), false);
    await first.check();
    assert.ok(first.connection);
    await first.close();
    assert.equal(await second.acquire(), true);
  } finally { await first.close(); await second.close(); }
});

test('admin bot persists a dubbed file without a subtitle tag in real SQL', async () => {
  const { AdminBotService, parseDirectives } = require('../bots/adminBot');
  const content = await query('SELECT id FROM contents WHERE asset_uuid=:assetId', { assetId });
  const directives = parseDirectives(`#اثر ${assetId} #نسخه Kingmovie #نوع دوبله`);
  const copy = { chatId: '-100123', messageId: 10, link: 'https://t.me/c/123/10' };
  const key = `integration:${crypto.randomUUID()}`;
  await new AdminBotService().insertMediaLink({ content_id: content[0].id, directives }, {
    metadata: { fileName: 'The.Pitt.S01E02.720p.WEB-DL.KIMO.DUBLE.mkv', fileSize: 50, mimeType: 'video/x-matroska' },
    copies: { primary: copy, fallback1: copy, fallback2: copy },
  }, null, key);
  const rows = await query('SELECT subtitle_type,resolution,season_number,episode_number FROM media_links WHERE ingest_key=:key', { key });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subtitle_type, 'none');
  assert.equal(rows[0].resolution, '720p');
  assert.equal(Number(rows[0].season_number), 1);
  assert.equal(Number(rows[0].episode_number), 2);
  await query('DELETE FROM media_links WHERE ingest_key=:key', { key });
});

test('one admin directive accepts multiple files until a new directive replaces it', async () => {
  const { AdminBotService, parseDirectives } = require('../bots/adminBot');
  const service = new AdminBotService();
  const chatId = -1009988776655;
  const messages = [];
  const ctx = { chat: { id: chatId }, from: { id: 123456789 }, reply: async (text) => messages.push(text) };
  const copy = { chatId: '-100123', messageId: 10, link: 'https://t.me/c/123/10' };
  service.replicateMessage = async () => ({ primary: copy, fallback1: copy, fallback2: copy });
  const directives = parseDirectives(`#اثر ${assetId} #نسخه Kingmovie #نوع دوبله`);
  assert.equal(await service.handleDirectives(ctx, directives), true);
  const firstSession = await service.activeSession(chatId);
  assert.equal(firstSession.directives.persistent, true);
  // Permanent sessions remain usable beyond the old 30-minute deadline.
  await query('UPDATE bot_ingest_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) WHERE id=:id', { id: firstSession.id });
  const sendVideo = async (episode, quality) => service.handleMedia(ctx, {
    message_id: episode, document: { file_id: `file-${episode}`, file_unique_id: `unique-${episode}`, file_name: `The.Pitt.S01E0${episode}.${quality}.WEB-DL.mkv`, file_size: 100, mime_type: 'video/x-matroska' },
  });
  await sendVideo(1, '1080p'); await sendVideo(2, '720p'); await sendVideo(3, '480p');
  assert.equal((await service.activeSession(chatId)).id, firstSession.id);
  const content = await query('SELECT id FROM contents WHERE asset_uuid=:assetId', { assetId });
  const rows = await query('SELECT season_number,episode_number,resolution,subtitle_type FROM media_links WHERE content_id=:id AND ingest_key LIKE :prefix ORDER BY episode_number', { id: content[0].id, prefix: `tg:${content[0].id}:%` });
  assert.deepEqual(rows.map(r => [Number(r.episode_number), r.resolution, r.subtitle_type]), [[1, '1080p', 'none'], [2, '720p', 'none'], [3, '480p', 'none']]);
  const other = crypto.randomUUID();
  await query("INSERT INTO contents (asset_uuid,content_type,title,slug,status) VALUES (:id,'series','other',:slug,'published')", { id: other, slug: `other-${other}` });
  try {
    assert.equal(await service.handleDirectives(ctx, parseDirectives(`#اثر ${other} #نسخه A #نوع دوبله`)), true);
    const active = await service.activeSession(chatId);
    assert.notEqual(active.id, firstSession.id);
    assert.equal((await query('SELECT status FROM bot_ingest_sessions WHERE id=:id', { id: firstSession.id }))[0].status, 'expired');
    await sendVideo(4, '720p');
    assert.equal(Number((await query('SELECT COUNT(*) AS total FROM media_links ml JOIN contents c ON c.id=ml.content_id WHERE c.asset_uuid=:id AND ml.episode_number=4', { id: other }))[0].total), 1);
    // An expired pre-upgrade session without the persistent marker is not revived.
    await query("UPDATE bot_ingest_sessions SET directives='{}',expires_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) WHERE id=:id", { id: active.id });
    assert.equal(await service.activeSession(chatId), null);
  } finally {
    await query('DELETE FROM bot_ingest_sessions WHERE source_chat_id=:chatId', { chatId });
    await query('DELETE FROM contents WHERE asset_uuid=:id', { id: other });
    await query('DELETE FROM media_links WHERE content_id=:id AND ingest_key LIKE :prefix', { id: content[0].id, prefix: `tg:${content[0].id}:%` });
  }
});

test('separate subtitles attach once in order and old bundle completion does not close a new session', async () => {
  const { AdminBotService, parseDirectives } = require('../bots/adminBot');
  const service = new AdminBotService();
  const chatId = -1009988776656;
  const ctx = { chat: { id: chatId }, from: { id: 123456789 }, reply: async () => {} };
  const copy = { chatId: '-100123', messageId: 10, link: 'https://t.me/c/123/10' };
  service.replicateMessage = async () => ({ primary: copy, fallback1: copy, fallback2: copy });
  service.scheduleFinalize = () => {};
  await service.handleDirectives(ctx, parseDirectives(`#اثر ${assetId} #نسخه A #نوع سافتساب #زیرنویس مجزا`));
  const old = await service.activeSession(chatId);
  for (let i = 1; i <= 2; i++) await service.handleMedia(ctx, { message_id: i, document: { file_id: `f${i}`, file_unique_id: `u${i}`, file_name: `Show.S01E0${i}.720p.mkv`, file_size: 100 } });
  for (let i = 1; i <= 2; i++) await service.handleMedia(ctx, { message_id: 10 + i, document: { file_id: `s${i}`, file_unique_id: `su${i}`, file_name: `sub${i}.srt`, file_size: 10, mime_type: 'application/x-subrip' } });
  const bundles = await query('SELECT id,subtitle_payload FROM bot_media_bundles WHERE session_id=:id ORDER BY id', { id: old.id });
  assert.equal(bundles.length, 2);
  for (let i = 0; i < 2; i++) {
    const payload = typeof bundles[i].subtitle_payload === 'string' ? JSON.parse(bundles[i].subtitle_payload) : bundles[i].subtitle_payload;
    assert.equal(payload.metadata.fileName, `sub${i + 1}.srt`);
  }
  await service.handleDirectives(ctx, parseDirectives(`#اثر ${assetId} #نسخه B #نوع دوبله`));
  const newer = await service.activeSession(chatId);
  for (const bundle of bundles) await service.finalizeBundle(bundle.id);
  assert.equal((await service.activeSession(chatId)).id, newer.id);
  const completed = await query('SELECT COUNT(*) AS n FROM bot_media_bundles WHERE session_id=:id AND status=\'complete\'', { id: old.id });
  assert.equal(Number(completed[0].n), 2);
  await query('DELETE FROM media_links WHERE ingest_key IN (:one, :two)', { one: `bundle:${(await query('SELECT bundle_key FROM bot_media_bundles WHERE id=:id', {id:bundles[0].id}))[0].bundle_key}`, two: `bundle:${(await query('SELECT bundle_key FROM bot_media_bundles WHERE id=:id', {id:bundles[1].id}))[0].bundle_key}` });
  await query('DELETE FROM bot_ingest_sessions WHERE source_chat_id=:chatId', { chatId });
});

test('download API exposes the bot link rather than the stored-channel link', async () => {
  const { downloadBotService } = require('../bots/downloadBot');
  const { ensureReady, copyMedia } = downloadBotService;
  const oldUsername = process.env.DOWNLOAD_BOT_USERNAME;
  process.env.DOWNLOAD_BOT_USERNAME = '@example_download_bot';
  downloadBotService.ensureReady = () => ({});
  downloadBotService.copyMedia = async () => ({ message_id: 1 });
  const id = crypto.randomUUID();
  const content = await query('SELECT id FROM contents WHERE asset_uuid=:assetId', {assetId});
  const inserted = await query("INSERT INTO media_links (public_id,content_id,version_label,resolution,file_size_bytes,tg_link_primary,primary_chat_id,primary_message_id) VALUES (:id,:content,'test','720p',100,'https://t.me/c/123/456',-100123,10)", { id, content: content[0].id });
  try {
    const result = await request('/api/download','POST',{mediaId:id});
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.telegramLink, 'https://t.me/example_download_bot');
    assert.equal(result.data.downloadBotUrl, 'https://t.me/example_download_bot');
    assert.equal(JSON.stringify(result.data).includes('t.me/c/123/456'), false);
  } finally {
    downloadBotService.ensureReady = ensureReady; downloadBotService.copyMedia = copyMedia;
    if (oldUsername === undefined) delete process.env.DOWNLOAD_BOT_USERNAME; else process.env.DOWNLOAD_BOT_USERNAME = oldUsername;
    await query('DELETE FROM media_links WHERE id=:id', { id: inserted.insertId });
  }
});

test('persistent Telegram deletion queue claims due work once across workers and recovers stale leases', async () => {
  const { scheduleDeletion, processDeletions } = require('../services/telegramDeletion');
  const messages = [];
  const bot = { deleteMessage: async (chat, id) => { messages.push([Number(chat), Number(id)]); } };
  await scheduleDeletion(777001, { message_id: 1001 }, 1, { bot });
  await scheduleDeletion(777001, { message_id: 1002 }, 1, { bot });
  await query("UPDATE telegram_deletion_queue SET delete_after = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE), lease_token = 'stale', lease_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE chat_id = 777001");
  await Promise.all([processDeletions({ bot }), processDeletions({ bot })]);
  assert.deepEqual(messages.sort((a,b) => a[1]-b[1]), [[777001,1001],[777001,1002]]);
  assert.equal((await query('SELECT id FROM telegram_deletion_queue WHERE chat_id = 777001')).length, 0);
});

test('admin detail automatically lists active bot media and all replica data without modifying it', async () => {
  const contentId = (await query('SELECT id FROM contents WHERE asset_uuid = :assetId', {assetId}))[0].id;
  const id = crypto.randomUUID();
  const added = await query(`INSERT INTO media_links (public_id, content_id, season_number, episode_number, version_label, audio_type,
    subtitle_type, resolution, quality_label, encoder, file_size_bytes, tg_link_primary, tg_link_fallback_1, tg_link_fallback_2,
    primary_chat_id, primary_message_id, subtitle_link_primary, subtitle_primary_message_id)
    VALUES (:id, :contentId, 1, 2, 'Sample', 'soft_sub', 'separate', '720p', 'WEB-DL', 'encoder', 123456,
    'https://t.me/c/123/10', 'https://t.me/c/456/20', 'https://t.me/c/789/30', -100123, 10, 'https://t.me/c/123/11', 11)`, {id, contentId});
  try {
    const { store } = require('../services/contentStore');
    const detail = await store.getContent(assetId);
    const media = detail.botMedia.find(item => item.public_id === id);
    assert.ok(media);
    assert.equal(media.tg_link_fallback_2, 'https://t.me/c/789/30');
    assert.equal(Number(media.subtitle_primary_message_id), 11);
    assert.equal(media.encoder, 'encoder');
    assert.equal(Number(media.file_size_bytes), 123456);
    assert.equal((await query('SELECT id FROM content_version_links WHERE media_link_id = :id', {id: added.insertId})).length, 0);
    await query('UPDATE media_links SET is_active = FALSE WHERE id = :id', {id: added.insertId});
    assert.ok(!(await store.getContent(assetId)).botMedia.some(item => item.public_id === id));
  } finally { await query('DELETE FROM media_links WHERE id = :id', {id: added.insertId}); }
});
