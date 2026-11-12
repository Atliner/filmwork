'use strict';

const { withTransaction } = require('../config/db');
const { AppError, assert } = require('../lib/errors');

async function refundUnspent(connection, ad, reason) {
  const refundable = Math.max(0, Number(ad.budget) - Number(ad.spent));
  if (refundable <= 0) return { refunded: 0 };

  const reference = `campaign-refund:${ad.public_id}`;
  const [existing] = await connection.execute(
    'SELECT id FROM wallet_transactions WHERE reference = :reference LIMIT 1',
    { reference },
  );
  if (existing[0]) return { refunded: 0, alreadyRefunded: true };

  await connection.execute(
    `INSERT INTO advertiser_wallets (user_id, balance)
     VALUES (:userId, 0) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    { userId: ad.advertiser_id },
  );
  const [wallets] = await connection.execute(
    'SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId FOR UPDATE',
    { userId: ad.advertiser_id },
  );
  const balance = Number(wallets[0].balance) + refundable;
  await connection.execute(
    'UPDATE advertiser_wallets SET balance = :balance WHERE user_id = :userId',
    { balance, userId: ad.advertiser_id },
  );
  await connection.execute(
    `INSERT INTO wallet_transactions
      (user_id, ad_id, transaction_type, amount, balance_after, reference)
     VALUES (:userId, :adId, 'refund', :amount, :balance, :reference)`,
    {
      userId: ad.advertiser_id,
      adId: ad.id,
      amount: refundable,
      balance,
      reference,
    },
  );
  return { refunded: refundable, balance, currency: wallets[0].currency, reason };
}

async function changeCampaignStatus(publicId, nextStatus) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      'SELECT * FROM ads WHERE public_id = :publicId FOR UPDATE',
      { publicId },
    );
    const ad = rows[0];
    assert(ad, 404, 'AD_NOT_FOUND', 'تبلیغ پیدا نشد.');
    if (ad.status === nextStatus) return { updated: false, status: ad.status, refunded: 0 };
    if (['rejected', 'completed'].includes(ad.status)) {
      throw new AppError(409, 'CAMPAIGN_TERMINAL', 'کمپین پایان‌یافته یا ردشده دوباره فعال نمی‌شود.');
    }
    if (nextStatus === 'active' && new Date(ad.ends_at).getTime() <= Date.now()) {
      throw new AppError(409, 'CAMPAIGN_EXPIRED', 'زمان پایان کمپین گذشته است.');
    }

    let refund = { refunded: 0 };
    if (nextStatus === 'rejected' || nextStatus === 'completed') {
      refund = await refundUnspent(connection, ad, `owner_${nextStatus}`);
    }
    await connection.execute(
      'UPDATE ads SET status = :status WHERE id = :id',
      { status: nextStatus, id: ad.id },
    );
    return { updated: true, status: nextStatus, ...refund };
  }, { isolationLevel: 'READ COMMITTED' });
}

async function settleExpiredCampaigns(advertiserId = null) {
  return withTransaction(async (connection) => {
    const params = {};
    const advertiserFilter = advertiserId ? 'AND advertiser_id = :advertiserId' : '';
    if (advertiserId) params.advertiserId = advertiserId;
    const [rows] = await connection.execute(
      `SELECT * FROM ads
       WHERE status IN ('pending', 'active', 'paused')
         AND ends_at <= UTC_TIMESTAMP(3) ${advertiserFilter}
       ORDER BY id ASC LIMIT 100 FOR UPDATE`,
      params,
    );
    let settled = 0;
    let refunded = 0;
    for (const ad of rows) {
      const result = await refundUnspent(connection, ad, 'campaign_expired');
      await connection.execute("UPDATE ads SET status = 'completed' WHERE id = :id", { id: ad.id });
      settled += 1;
      refunded += Number(result.refunded || 0);
    }
    return { settled, refunded };
  }, { isolationLevel: 'READ COMMITTED' });
}

module.exports = {
  refundUnspent,
  changeCampaignStatus,
  settleExpiredCampaigns,
};
