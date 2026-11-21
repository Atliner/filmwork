'use strict';
process.env.DB_HOST ||= '127.0.0.1'; process.env.DB_NAME ||= 'test'; process.env.DB_USER ||= 'test'; process.env.DB_PASSWORD ||= 'unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteCampaignLocked } = require('../services/adAccounting');

function fakeDb(campaign) {
  const calls = [];
  const connection = { execute: async (sql, params) => {
    calls.push({sql, params});
    if (sql.startsWith('SELECT * FROM ads')) return [[campaign].filter(Boolean)];
    if (sql.startsWith('SELECT CAST')) return [[{refundable:'600.50'}]];
    if (sql.startsWith('SELECT id FROM wallet_transactions')) return [[]];
    if (sql.startsWith('SELECT balance, currency')) return [[{balance:'123456789123.12',currency:'IRR'}]];
    if (sql.startsWith('SELECT CAST(balance AS CHAR)')) return [[{balance:'123456789723.62'}]];
    return [{affectedRows:1}];
  }};
  return {connection, calls};
}
const paid = {id:5, public_id:'ad-5', advertiser_id:42, owner_campaign:0};
test('advertiser can only delete their own non-owner campaign', async () => {
  for (const [ad, user] of [[paid, 41], [{...paid, owner_campaign:1}, 42], [null, 42]]) {
    const db = fakeDb(ad);
    await assert.rejects(deleteCampaignLocked(db.connection, 'ad-5', user), (e) => e.code === 'AD_NOT_FOUND');
    assert.equal(db.calls.length, 1);
  }
});
test('paid delete returns unspent balance in decimal SQL and preserves audit records', async () => {
  const db = fakeDb(paid); const result = await deleteCampaignLocked(db.connection, 'ad-5', 42);
  assert.equal(result.refunded, 600.5); assert.equal(result.deleted, true);
  assert.ok(db.calls.some((call) => call.sql.includes('balance = balance + :refundable') && call.params.refundable === '600.50'));
  assert.ok(db.calls.some((call) => call.sql.includes('INSERT INTO wallet_transactions') && call.params.amount === '600.50'));
  assert.ok(db.calls.some((call) => call.sql.includes('deleted_at = UTC_TIMESTAMP')));
  assert.ok(!db.calls.some((call) => /DELETE FROM (ads|ad_events|wallet_transactions)/i.test(call.sql)));
});
test('owner campaign is deleted without crediting an unreserved wallet', async () => {
  const db = fakeDb({...paid, owner_campaign:1}); const result = await deleteCampaignLocked(db.connection, 'ad-5');
  assert.equal(result.refunded, 0); assert.ok(!db.calls.some((call) => call.sql.includes('advertiser_wallets')));
  assert.ok(db.calls.some((call) => call.sql.includes('deleted_at = UTC_TIMESTAMP')));
});
