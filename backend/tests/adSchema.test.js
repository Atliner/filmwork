'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLACEMENT_KEYS, publicPlacementPrices } = require('../services/adSettings');
const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('fresh schema accepts every public ad placement in both tables', () => {
  const schema = read('database/schema.sql');
  for (const table of ['ad_placement_prices', 'ads']) {
    const definition = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\) ENGINE`));
    assert.ok(definition, table);
    const placement = definition[1].match(/placement ENUM\(([^)]*)\)/);
    assert.ok(placement, table);
    for (const key of PLACEMENT_KEYS) assert.ok(placement[1].includes(`'${key}'`), `${table} does not allow ${key}`);
  }
});

test('upgrade widens before copying old post-play campaigns without deleting history', () => {
  const repair = read('database/migrations/2026-11-fix-ad-placement-enums.sql');
  assert.ok(repair.indexOf('MODIFY COLUMN placement') < repair.indexOf("UPDATE ads SET placement = 'timed_banner'"));
  assert.match(repair, /WHERE placement = 'post_play'/);
  assert.doesNotMatch(repair, /DELETE FROM (?:ads|ad_events)/i);
  const original = read('database/migrations/2026-11-ad-settings.sql');
  for (const enumBody of original.matchAll(/MODIFY COLUMN placement ENUM\(([\s\S]*?)\)/g)) {
    assert.match(enumBody[1], /'timed_banner'/);
    assert.match(enumBody[1], /'post_play'/);
  }
});

// Databases upgraded from the legacy spelling may retain the old price for
// auditing. It must not be advertised as an unsupported purchase option.
test('public prices exclude legacy and unknown placements without mutating rows', () => {
  const rows = [{ placement: 'post_play', price: 10 }, { placement: 'timed_banner', price: 20 },
    { placement: 'future_unknown', price: 30 }, { placement: 'pre_roll', price: 40 }];
  assert.deepEqual(publicPlacementPrices(rows), [rows[1], rows[3]]);
  assert.equal(rows.length, 4);
});


test('bot-file placement is offered when enabled', () => {
  assert.deepEqual(publicPlacementPrices([{placement:'link_file_button'}, {placement:'pre_roll'}]), [{placement:'link_file_button'}, {placement:'pre_roll'}]);
});

test('page advertising migration widens storage without deleting balances or history', () => {
  const migration = read('database/migrations/2026-11-page-ads-bidding.sql');
  for (const key of ['banner_home','text_home','banner_detail','text_detail','banner_search','text_search']) assert.ok(migration.includes(`'${key}'`));
  assert.match(migration, /spent DECIMAL\(20,5\)/);
  assert.match(migration, /balance DECIMAL\(20,5\)/);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
  const deletion = read('database/migrations/2026-11-soft-delete-campaigns.sql');
  assert.match(deletion, /deleted_at/); assert.doesNotMatch(deletion, /DELETE\s+FROM/i);
});
