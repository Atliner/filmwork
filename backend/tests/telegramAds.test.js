'use strict';
process.env.DB_HOST ||= '127.0.0.1'; process.env.DB_NAME ||= 'test'; process.env.DB_USER ||= 'test'; process.env.DB_PASSWORD ||= 'unused'; process.env.AUTH_CODE_PEPPER ||= 'b'.repeat(64); process.env.APP_URL = 'https://film.example';
const test = require('node:test');
const assert = require('node:assert/strict');
const { telegramTarget, trackedOrigin } = require('../lib/telegramAd');
const { verifyAdSession } = require('../lib/adSession');
const { deliverWithTelegramAd } = require('../services/telegramAds');
const { DownloadBotService } = require('../bots/downloadBot');
function fake(mode = 'tracked', owner = 0, commitFails = false) {
  const calls = [];
  const ad = {id:9,public_id:'campaign-1',headline:'تبلیغ کانال',target_url:'https://t.me/my_channel',telegram_click_mode:mode,owner_campaign:owner,unit_price:'1000.00'};
  const conn = {execute:async (sql,params) => { calls.push({sql,params}); return sql.includes('SELECT a.id') ? [[ad]] : [{affectedRows:1}]; }};
  const deps = {query:async () => [{public_id:ad.public_id}], randomInt:() => 0, withTransaction:async (work) => { const result = await work(conn); if (commitFails) throw Error('commit lost'); return result; }};
  return {calls,deps};
}
test('destination and public origin must be safe URLs', () => {
  assert.equal(telegramTarget('https://t.me/example_bot?start=abc'), 'https://t.me/example_bot?start=abc');
  for (const url of ['http://t.me/test','https://t.me.evil.test/test','https://user@t.me/test','https://t.me/']) assert.throws(() => telegramTarget(url), e=>e.code === 'TELEGRAM_AD_URL_INVALID');
  for (const url of ['http://example.com','https://localhost','https://example.com/path']) assert.throws(() => trackedOrigin(url), e=>e.code === 'TELEGRAM_AD_APP_URL');
});
test('tracked button sends signed link, then records and charges one delivered impression', async () => {
  const {calls,deps} = fake(); let button;
  const result = await deliverWithTelegramAd(12, async (b) => { button=b; return 'delivered'; }, deps);
  assert.equal(result, 'delivered'); const url = new URL(button.url);
  assert.equal(url.origin, 'https://film.example'); assert.equal(url.pathname, '/api/ads/telegram-click/campaign-1');
  assert.equal(verifyAdSession(url.searchParams.get('session'), 'campaign-1').purpose, 'telegram');
  assert.equal(calls.filter(c => /INSERT INTO ad_events/.test(c.sql)).length, 1);
  assert.equal(calls.filter(c => /UPDATE ads SET/.test(c.sql)).length, 1);
});
test('direct mode skips the website and owner ads are not charged', async () => {
  const {calls,deps} = fake('direct', 1); let button;
  await deliverWithTelegramAd(12, async (b) => { button=b; }, deps);
  assert.equal(button.url, 'https://t.me/my_channel');
  assert.ok(calls.some(c => /INSERT INTO ad_events/.test(c.sql)));
  assert.ok(!calls.some(c => /UPDATE ads SET/.test(c.sql)));
});
test('failed sends are not billed; successful send followed by DB failure is not sent twice', async () => {
  const failed = fake();
  await assert.rejects(deliverWithTelegramAd(12, async () => {throw Error('telegram failed');}, failed.deps), /telegram failed/);
  assert.ok(!failed.calls.some(c => /INSERT INTO ad_events|UPDATE ads SET/.test(c.sql)));
  const committed = fake('tracked',0,true); let sends=0;
  assert.equal(await deliverWithTelegramAd(12, async () => { sends++; return 42; }, committed.deps), 42); assert.equal(sends,1);
});
test('copy and fallback deliveries attach the ad under the file without losing the file button', async () => {
  const service = new DownloadBotService(); const calls=[]; service.started = true;
  service.bot = {telegram:{copyMessage:async (...args)=>calls.push(args), sendMessage:async (...args)=>calls.push(args)}};
  const ad = {text:'تبلیغ',url:'https://t.me/example'};
  await service.copyMedia(1,2,3,'فیلم',ad); await service.sendFallbackLink(1,'https://t.me/file','فیلم',ad);
  assert.deepEqual(calls[0][3].reply_markup.inline_keyboard, [[ad]]);
  assert.equal(calls[1][2].reply_markup.inline_keyboard[0][0].url, 'https://t.me/file');
  assert.deepEqual(calls[1][2].reply_markup.inline_keyboard[1], [ad]);
});
