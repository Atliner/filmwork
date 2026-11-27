'use strict';
process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test';
process.env.DB_PASSWORD ||= 'unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleDeletion, processDeletions } = require('../services/telegramDeletion');
const { validate } = require('../services/siteSettings');

test('deletion setting defaults off and validates allowed minutes', () => {
  assert.equal(validate({ 'download.delete_after_minutes': '0' })['download.delete_after_minutes'], '0');
  assert.equal(validate({ 'download.delete_after_minutes': '2760' })['download.delete_after_minutes'], '2760');
  for (const value of ['2761', '-1', '0.5', 'oops']) assert.throws(() => validate({ 'download.delete_after_minutes': value }));
});

test('schedules only the message sent to user and honors disabled setting', async () => {
  const calls = [];
  const deps = { query: async (sql, params) => calls.push({ sql, params }) };
  await scheduleDeletion(1234, { message_id: 90 }, 0, deps);
  assert.equal(calls.length, 0);
  await scheduleDeletion(1234, { message_id: 90 }, 10, deps);
  assert.deepEqual(calls[0].params, { chatId: 1234, messageId: 90, minutes: 10 });
});

test('queue failure attempts immediate deletion of user message', async () => {
  const calls = [];
  await scheduleDeletion(1234, { message_id: 90 }, 10, {
    query: async () => { throw new Error('database offline'); },
    bot: { deleteMessage: async (...args) => calls.push(args) },
  });
  assert.deepEqual(calls, [[1234, 90]]);
});

test('claimed jobs delete user messages, retry errors and retain expired jobs', async () => {
  const queries = [], deleted = [];
  const rows = [
    { id: 1, chat_id: 111, message_id: 1, expires_at: new Date(Date.now() + 3600000) },
    { id: 2, chat_id: 222, message_id: 2, expires_at: new Date(Date.now() + 3600000) },
    { id: 3, chat_id: 333, message_id: 3, expires_at: new Date(Date.now() - 1) },
  ];
  await processDeletions({
    query: async (sql, params) => { queries.push({ sql, params }); return sql.startsWith('SELECT') ? rows : {}; },
    bot: { deleteMessage: async (...args) => { deleted.push(args); if (args[0] === 222) throw new Error('temporary'); } },
  });
  assert.deepEqual(deleted, [[111, 1], [222, 2]]);
  assert.ok(queries.some(({ sql, params }) => sql.startsWith('DELETE') && params.id === 1));
  assert.ok(queries.some(({ sql, params }) => sql.includes('attempts = attempts + 1') && params.id === 2));
  assert.ok(queries.some(({ sql, params }) => sql.includes('failed = TRUE') && params.id === 3));
  assert.equal(new Set(queries.map(({ params }) => params.lease)).size, 1);
});
