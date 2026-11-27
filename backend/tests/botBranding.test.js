'use strict';
process.env.DB_HOST ||= '127.0.0.1'; process.env.DB_NAME ||= 'filmwork_test'; process.env.DB_USER ||= 'filmwork_test'; process.env.DB_PASSWORD ||= 'unused';
process.env.DEMO_DATA = '1'; process.env.ADMIN_OWNER_IDS = '12345';
process.env.AUTH_CODE_PEPPER ||= 'b'.repeat(64); process.env.PHONE_ENCRYPTION_KEY ||= 'c'.repeat(64);
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../config/db');
let dbFailure = false;
db.query = async () => { if (dbFailure) throw new Error('offline'); return [{total:0}]; };
db.withTransaction = async (work) => work({ execute:async (sql) => sql.includes('SELECT id, status FROM users') ? [[{id:1,status:'active'}]] : [{affectedRows:1}] });
const settings = require('../services/siteSettings');
const { formatDownloadCaption } = require('../lib/botBranding');
const { AuthBotService } = require('../bots/authBot');
const { AdminBotService } = require('../bots/adminBot');
const { DownloadBotService } = require('../bots/downloadBot');

function register(service) {
  const handlers = {};
  service.bot = { start:fn => { handlers.start=fn; }, command:(name,fn)=>{handlers[name]=fn;}, on:(name,fn)=>{handlers[name]=fn;}, catch:()=>{} };
  service.registerHandlers();
  return handlers;
}
function invoke(handler, ctx = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bot reply timed out')), 3000);
    handler({ chat:{id:12345,type:'private'}, from:{id:12345,first_name:'Test'}, ...ctx,
      reply:async (message, extra) => { clearTimeout(timer); resolve({message,extra}); } });
  });
}

test('three bot replies and login code use the latest panel site name without restart', async () => {
  const auth=register(new AuthBotService()), admin=register(new AdminBotService()), download=register(new DownloadBotService());
  await settings.write({'site.name':'سینمای آبی'});
  for (const handler of [auth.start,admin.start,download.start]) {
    const {message} = await invoke(handler); assert.match(message,/سینمای آبی/); assert.doesNotMatch(message,/Filmwork|Vizosten/);
  }
  const {message:code} = await invoke(auth.contact, {message:{contact:{user_id:12345,phone_number:'+12345678901'}}});
  assert.match(code,/کد ورود سینمای آبی شما/); assert.match(code,/\d{6}/);
  await settings.write({'site.name':'سینمای طلایی'});
  for (const handler of [auth.start,admin.start,download.start]) {
    const {message} = await invoke(handler); assert.match(message,/سینمای طلایی/); assert.doesNotMatch(message,/سینمای آبی/);
  }
});

test('old custom brand converts to a live token without altering URLs and usernames', async () => {
  await settings.write({'site.name':'سینمای آبی','download.caption':'سینمای آبی | Filmwork | @Vizosten | https://example.com/Vizosten | {title}'});
  await settings.write({'site.name':'سینمای طلایی'});
  const values = await settings.read();
  assert.equal(values['download.caption'],'{site_name} | {site_name} | @Vizosten | https://example.com/Vizosten | {title}');
  const result=formatDownloadCaption(values['download.caption'],{siteName:values['site.name'],title:'پیت',version:'نسخه'});
  assert.equal(result,'سینمای طلایی | سینمای طلایی | @Vizosten | https://example.com/Vizosten | پیت');
  assert.equal(settings.captionAsTemplate('سینمای آبی و سینمای آبی‌تر', ['سینمای آبی']), '{site_name} و سینمای آبی‌تر');
  assert.equal(settings.captionAsTemplate('A.B و AXB و {title}', ['A.B']), '{site_name} و AXB و {title}');
});

test('token expansion is nonrecursive and supports both download paths', () => {
  assert.equal(formatDownloadCaption('{site_name} {title} {version}',{siteName:'{title}',title:'{version}',version:'720p'}),'{title} {version} 720p');
  assert.ok(formatDownloadCaption('{site_name}',{siteName:'x'.repeat(1200)}).length <= 900);
});

test('unavailable settings uses neutral branding instead of a stale name', async () => {
  const original = process.env.DEMO_DATA;
  process.env.DEMO_DATA = '0';
  dbFailure = true;
  try { assert.equal(await settings.getSiteName(), 'سایت'); }
  finally { process.env.DEMO_DATA = original; dbFailure = false; }
});
