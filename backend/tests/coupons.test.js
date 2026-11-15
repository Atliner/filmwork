'use strict';

process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test';
process.env.DB_PASSWORD ||= 'unused';
process.env.DEMO_DATA = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const coupons = require('../services/coupons');

test('coupon credit is limited by total redemptions and only once per user', async () => {
  const coupon = await coupons.createCoupon({ code: 'ONCE-ONLY-7', creditAmount: 25000, usageLimit: 2 });
  const first = await coupons.redeemCoupon('advertiser-a', coupon.code);
  assert.equal(first.added, 25000);
  assert.equal(first.balance, 25000);
  await assert.rejects(() => coupons.redeemCoupon('advertiser-a', coupon.code), { code: 'COUPON_ALREADY_USED' });
  const second = await coupons.redeemCoupon('advertiser-b', coupon.code);
  assert.equal(second.balance, 25000);
  await assert.rejects(() => coupons.redeemCoupon('advertiser-c', coupon.code), { code: 'COUPON_EXHAUSTED' });
});

test('unlimited coupon still allows each advertiser one redemption, and owner can delete it', async () => {
  const coupon = await coupons.createCoupon({ code: 'ALL-USERS-8', creditAmount: 10000, usageLimit: null });
  assert.equal((await coupons.redeemCoupon('advertiser-d', coupon.code)).balance, 10000);
  assert.equal((await coupons.redeemCoupon('advertiser-e', coupon.code)).balance, 10000);
  await coupons.deleteCoupon(coupon.id);
  await assert.rejects(() => coupons.redeemCoupon('advertiser-f', coupon.code), { code: 'COUPON_NOT_FOUND' });
});

test('coupon creation rejects invalid amount and duplicate code', async () => {
  await assert.rejects(() => coupons.createCoupon({ code: 'BAD-AMOUNT', creditAmount: 0, usageLimit: 1 }), { code: 'INVALID_COUPON_AMOUNT' });
  await coupons.createCoupon({ code: 'DUPLICATE-9', creditAmount: 100, usageLimit: 1 });
  await assert.rejects(() => coupons.createCoupon({ code: 'DUPLICATE-9', creditAmount: 200, usageLimit: 1 }), { code: 'COUPON_EXISTS' });
});
