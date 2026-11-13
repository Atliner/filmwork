'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const { AppError, assert } = require('../lib/errors');

const demo = { items: [], redemptions: [], wallets: new Map() };
const cleanCode = (value) => String(value || '').trim().toUpperCase();
const validCode = (code) => /^[A-Z0-9_-]{4,32}$/.test(code);

async function listCoupons() {
  if (process.env.DEMO_DATA === '1') {
    return demo.items.map((item) => ({ ...item, usedCount: demo.redemptions.filter((r) => r.couponId === item.id).length }));
  }
  return query(`SELECT c.id, c.code, c.credit_amount AS creditAmount, c.usage_limit AS usageLimit,
    c.created_at AS createdAt, COUNT(r.id) AS usedCount
    FROM advertiser_coupons c LEFT JOIN advertiser_coupon_redemptions r ON r.coupon_id = c.id
    GROUP BY c.id ORDER BY c.created_at DESC`);
}

async function createCoupon({ code, creditAmount, usageLimit }) {
  const normalized = cleanCode(code) || crypto.randomBytes(5).toString('hex').toUpperCase();
  const amount = Number(creditAmount);
  const limit = usageLimit === null || usageLimit === '' || usageLimit === undefined ? null : Number(usageLimit);
  assert(validCode(normalized), 422, 'INVALID_COUPON_CODE', 'کد باید ۴ تا ۳۲ حرف انگلیسی، عدد، خط تیره یا زیرخط باشد.');
  assert(Number.isSafeInteger(amount) && amount > 0, 422, 'INVALID_COUPON_AMOUNT', 'مبلغ اعتبار باید عدد صحیح مثبت به ریال باشد.');
  assert(limit === null || (Number.isSafeInteger(limit) && limit > 0), 422, 'INVALID_COUPON_LIMIT', 'تعداد استفاده باید عدد صحیح مثبت باشد.');
  if (process.env.DEMO_DATA === '1') {
    assert(!demo.items.some((item) => item.code === normalized), 409, 'COUPON_EXISTS', 'این کد قبلاً ساخته شده است.');
    const item = { id: crypto.randomUUID(), code: normalized, creditAmount: amount, usageLimit: limit, createdAt: new Date().toISOString() };
    demo.items.unshift(item);
    return { ...item, usedCount: 0 };
  }
  try {
    const result = await query(`INSERT INTO advertiser_coupons (code, credit_amount, usage_limit)
      VALUES (:code, :creditAmount, :usageLimit)`, { code: normalized, creditAmount: amount, usageLimit: limit });
    return { id: String(result.insertId), code: normalized, creditAmount: amount, usageLimit: limit, usedCount: 0, createdAt: new Date().toISOString() };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw new AppError(409, 'COUPON_EXISTS', 'این کد قبلاً ساخته شده است.');
    throw error;
  }
}

async function deleteCoupon(id) {
  if (process.env.DEMO_DATA === '1') {
    const index = demo.items.findIndex((item) => item.id === String(id));
    assert(index >= 0, 404, 'COUPON_NOT_FOUND', 'کد تخفیف پیدا نشد.');
    const [removed] = demo.items.splice(index, 1);
    demo.redemptions = demo.redemptions.filter((r) => r.couponId !== removed.id);
    return { deleted: true };
  }
  const result = await query('DELETE FROM advertiser_coupons WHERE id = :id', { id });
  assert(result.affectedRows, 404, 'COUPON_NOT_FOUND', 'کد تخفیف پیدا نشد.');
  return { deleted: true };
}

async function redeemCoupon(userId, rawCode) {
  const code = cleanCode(rawCode);
  assert(validCode(code), 422, 'INVALID_COUPON_CODE', 'کد تخفیف معتبر نیست.');
  if (process.env.DEMO_DATA === '1') {
    const coupon = demo.items.find((item) => item.code === code);
    assert(coupon, 404, 'COUPON_NOT_FOUND', 'کد تخفیف پیدا نشد یا غیرفعال است.');
    assert(!demo.redemptions.some((r) => r.couponId === coupon.id && r.userId === String(userId)), 409, 'COUPON_ALREADY_USED', 'شما قبلاً از این کد استفاده کرده‌اید.');
    const used = demo.redemptions.filter((r) => r.couponId === coupon.id).length;
    assert(coupon.usageLimit === null || used < coupon.usageLimit, 409, 'COUPON_EXHAUSTED', 'ظرفیت استفاده از این کد تکمیل شده است.');
    demo.redemptions.push({ couponId: coupon.id, userId: String(userId) });
    const balance = (demo.wallets.get(String(userId)) || 0) + coupon.creditAmount;
    demo.wallets.set(String(userId), balance);
    return { added: coupon.creditAmount, balance, currency: 'IRR' };
  }
  return withTransaction(async (connection) => {
    const [coupons] = await connection.execute('SELECT id, credit_amount, usage_limit FROM advertiser_coupons WHERE code = :code FOR UPDATE', { code });
    assert(coupons[0], 404, 'COUPON_NOT_FOUND', 'کد تخفیف پیدا نشد یا غیرفعال است.');
    const coupon = coupons[0];
    const [usedByUser] = await connection.execute('SELECT id FROM advertiser_coupon_redemptions WHERE coupon_id = :couponId AND user_id = :userId LIMIT 1', { couponId: coupon.id, userId });
    assert(!usedByUser.length, 409, 'COUPON_ALREADY_USED', 'شما قبلاً از این کد استفاده کرده‌اید.');
    const [counts] = await connection.execute('SELECT COUNT(*) AS total FROM advertiser_coupon_redemptions WHERE coupon_id = :couponId', { couponId: coupon.id });
    assert(coupon.usage_limit === null || Number(counts[0].total) < Number(coupon.usage_limit), 409, 'COUPON_EXHAUSTED', 'ظرفیت استفاده از این کد تکمیل شده است.');
    await connection.execute('INSERT INTO advertiser_wallets (user_id, balance) VALUES (:userId, 0) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)', { userId });
    const [wallets] = await connection.execute('SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId FOR UPDATE', { userId });
    const amount = Number(coupon.credit_amount);
    const balance = Number(wallets[0].balance) + amount;
    await connection.execute('UPDATE advertiser_wallets SET balance = :balance WHERE user_id = :userId', { balance, userId });
    await connection.execute('INSERT INTO advertiser_coupon_redemptions (coupon_id, user_id, credit_amount) VALUES (:couponId, :userId, :amount)', { couponId: coupon.id, userId, amount });
    await connection.execute(`INSERT INTO wallet_transactions
      (user_id, transaction_type, amount, balance_after, reference)
      VALUES (:userId, 'coupon_credit', :amount, :balance, :reference)`, {
      userId, amount, balance, reference: `coupon:${coupon.id}:user:${userId}`,
    });
    return { added: amount, balance, currency: wallets[0].currency };
  });
}

module.exports = { listCoupons, createCoupon, deleteCoupon, redeemCoupon };
