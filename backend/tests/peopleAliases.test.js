'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAliasIndex, displayCredits, expandAliases } = require('../lib/peopleAliases');
const { normalizeContentPayload } = require('../lib/contentParams');

test('explicit pairs join legacy credits across the archive but never pair by position', () => {
  const index = createAliasIndex([
    { directors: ['نمونه | Example Name'], cast: [] },
    { directors: ['نمونه', 'Example Name', 'سوم', 'Unrelated'], cast: [] },
  ]);
  assert.deepEqual(displayCredits(['نمونه', 'Example Name', 'سوم', 'Unrelated'], index), ['نمونه | Example Name', 'سوم', 'Unrelated']);
  assert.deepEqual(expandAliases(['Example Name'], index), ['نمونه', 'Example Name']);
  assert.deepEqual(expandAliases(['Unrelated'], index), ['Unrelated']);
});
test('conflicting explicit mappings are not silently merged', () => {
  const index = createAliasIndex([{ directors: ['نام | One', 'نام | Two'] }]);
  assert.deepEqual(expandAliases(['نام'], index), ['نام']);
  assert.deepEqual(expandAliases(['One'], index), ['One']);
});
test('single explicit pairs survive string and array input; old lists stay separate', () => {
  const item = normalizeContentPayload({ titleFa: 'اثر', directors: 'نام | Name؛ نام دیگر | Other Name', cast: 'الف، ب | A, B' });
  assert.deepEqual(item.directors, ['نام | Name', 'نام دیگر | Other Name']);
  assert.deepEqual(item.castMembers, ['الف', 'ب', 'A', 'B']);
});
