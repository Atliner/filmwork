'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { moneyCents } = require('../lib/money');
test('validates currency with integer cents, never floating point', () => {
  assert.equal(moneyCents('123.45'), 12345n);
  assert.equal(moneyCents('9999999999999.99'), 999999999999999n);
  for (const bad of ['1e7','1.001','-1','10000000000000','NaN','']) assert.throws(() => moneyCents(bad), (e) => e.code === 'INVALID_MONEY');
});
