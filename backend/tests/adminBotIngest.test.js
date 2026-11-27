'use strict';
process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test';
process.env.DB_PASSWORD ||= 'unused';
process.env.ADMIN_OWNER_IDS = '12345';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../config/db');
const calls = [];
db.query = async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 1, insertId: 8 }; };
const { AdminBotService, parseDirectives } = require('../bots/adminBot');
const uuid = '550e8400-e29b-41d4-a716-446655440000';
const fileName = 'The.Pitt.S02.E15.720p.WEB-DL.Doble.mp4';

function setupService() {
  const service = new AdminBotService();
  const directives = parseDirectives(`#اثر ${uuid} #نسخه DigiMovies #نوع دوبله`);
  service.activeSession = async () => ({ id: 1, content_id: 12, directives });
  const copy = { chatId: '-100123', messageId: 7, link: 'https://t.me/c/123/7' };
  service.replicateMessage = async () => ({ primary: copy, fallback1: copy, fallback2: copy });
  return service;
}

test('video ingest saves filename metadata and creates the right episode key', async () => {
  calls.length = 0;
  const service = setupService();
  const replies = [];
  await service.handleMedia({ chat: { id: 123 }, reply: async (text) => replies.push(text) }, {
    message_id: 5, document: { file_id: 'f', file_unique_id: 'u', file_name: fileName, file_size: 50, mime_type: 'video/mp4' },
  });
  const insert = calls.find((call) => call.sql.includes('INSERT INTO media_links'));
  assert.ok(insert);
  assert.equal(insert.params.season, 2);
  assert.equal(insert.params.episode, 15);
  assert.equal(insert.params.resolution, '720p');
  assert.equal(insert.params.quality, 'WEB-DL');
  assert.match(insert.params.ingestKey, /:2:15:u$/);
  assert.match(replies.at(-1), /کارت دانلود/);
});

test('delayed separate-subtitle finalization also resolves filename metadata', async () => {
  calls.length = 0;
  const service = setupService();
  const copy = { chatId: '-100123', messageId: 7, link: 'https://t.me/c/123/7' };
  const d = parseDirectives(`#اثر ${uuid} #نسخه A #نوع سافتساب #زیرنویس مجزا`);
  await service.insertMediaLink({ content_id: 12, directives: d }, {
    metadata: { fileName, fileSize: 100, mimeType: 'video/mp4' },
    copies: { primary: copy, fallback1: copy, fallback2: copy },
  }, { metadata: { fileSize: 4 }, copies: { primary: copy, fallback1: copy, fallback2: copy } }, 'bundle:abc');
  const insert = calls.find((call) => call.sql.includes('INSERT INTO media_links'));
  assert.equal(insert.params.subtitleType, 'separate');
  assert.equal(insert.params.season, 2);
  assert.equal(insert.params.episode, 15);
  assert.equal(insert.params.resolution, '720p');
  assert.equal(insert.params.subtitleFileSize, 4);
});

test('caption directives process the attached video only after successful session creation', async () => {
  const service = setupService();
  const handlers = {};
  service.bot = { command() {}, on(name, fn) { handlers[name] = fn; }, catch() {} };
  const seen = [];
  service.handleDirectives = async (_ctx, directives) => { seen.push('directives'); return !directives.error; };
  service.handleMedia = async () => { seen.push('media'); };
  service.registerHandlers();
  const ctx = { chat: { id: 12345 }, from: { id: 12345 }, message: { caption: `#اثر ${uuid} #نسخه A #نوع دوبله`, document: { file_id: 'f', file_unique_id: 'u', file_name: fileName, file_size: 50 } } };
  handlers.message(ctx);
  await service.updateQueues.get('12345');
  assert.deepEqual(seen, ['directives', 'media']);
  seen.length = 0;
  ctx.message.caption = `#اثر ${uuid} #نسخه A`;
  handlers.message(ctx);
  await service.updateQueues.get('12345');
  assert.deepEqual(seen, ['directives']);
});
