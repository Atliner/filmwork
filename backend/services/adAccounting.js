'use strict';

const { withTransaction } = require('../config/db');
const { AppError, assert } = require('../lib/errors');

async function refundUnspent(connection, ad, reason) {
  if (Number(ad.owner_campaign || 0)) return { refunded: 0 };
  // Calculate and add currency in MySQL DECIMAL, never with floating-point JS.
  const [amounts] = await connection.execute('SELECT CAST(CAST(GREATEST(budget - spent, 0) AS DECIMAL(20,5)) AS CHAR) AS refundable FROM ads WHERE id = :id', { id: ad.id });
  const refundable = amounts[0].refundable;
  if (Number(refundable) <= 0) return { refunded: 0 };

  const reference = `campaign-refund:${ad.public_id}`;
  const [existing] = await connection.execute(
    'SELECT id FROM wallet_transactions WHERE reference = :reference LIMIT 1',
    { reference },
  );
  if (existing[0]) return { refunded: 0, alreadyRefunded: true };
  // An already hidden legacy campaign with no matching refund needs manual
  // reconciliation; never manufacture a second credit during maintenance.
  if (ad.deleted_at) throw new AppError(409, 'LEGACY_REFUND_UNVERIFIED', 'بازپرداخت کمپین قبلاً حذف‌شده قابل تأیید نیست؛ سوابق مالی را بررسی کنید.');

  await connection.execute(
    `INSERT INTO advertiser_wallets (user_id, balance)
     VALUES (:userId, 0) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    { userId: ad.advertiser_id },
  );
  const [wallets] = await connection.execute(
    'SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId FOR UPDATE',
    { userId: ad.advertiser_id },
  );
  await connection.execute(
    'UPDATE advertiser_wallets SET balance = balance + :refundable WHERE user_id = :userId',
    { refundable, userId: ad.advertiser_id },
  );
  const [updatedWallets] = await connection.execute('SELECT CAST(balance AS CHAR) AS balance FROM advertiser_wallets WHERE user_id = :userId', { userId: ad.advertiser_id });
  const balance = updatedWallets[0].balance;
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
  return { refunded: Number(refundable), balance: Number(balance), currency: wallets[0].currency, reason };
}

async function changeCampaignStatus(publicId, nextStatus) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      'SELECT * FROM ads WHERE public_id = :publicId AND deleted_at IS NULL FOR UPDATE',
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
       WHERE status IN ('pending', 'active', 'paused') AND deleted_at IS NULL
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


// Financial snapshot, wallet refund, ledger unlink, event cleanup and campaign
// deletion are one transaction under the same row lock as charging/settlement.
async function deleteCampaignLocked(connection, publicId, advertiserId = null, { includeDeleted = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT * FROM ads WHERE public_id = :publicId ${includeDeleted ? '' : 'AND deleted_at IS NULL'} FOR UPDATE`, { publicId },
  );
  const ad = rows[0];
  assert(ad && (advertiserId === null || (!Number(ad.owner_campaign || 0) && String(ad.advertiser_id) === String(advertiserId))), 404, 'AD_NOT_FOUND', 'کمپین پیدا نشد.');
  const refund = await refundUnspent(connection, ad, 'campaign_deleted');
  await connection.execute(`INSERT INTO ad_financial_archive (campaign_public_id,advertiser_id,owner_campaign,primary_placement,currency,budget,spent,status_at_deletion,created_at,deleted_at)
    SELECT public_id,advertiser_id,owner_campaign,placement,COALESCE((SELECT currency FROM advertiser_wallets WHERE user_id=ads.advertiser_id),(SELECT currency FROM ad_placement_prices WHERE placement=ads.placement),'IRR'),budget,spent,status,created_at,COALESCE(deleted_at,UTC_TIMESTAMP(3)) FROM ads WHERE id=:id`, { id:ad.id });
  await connection.execute(`INSERT INTO ad_financial_placement_rates (campaign_public_id,placement,unit_price,bid_multiplier)
    SELECT :publicId,placement,unit_price,bid_multiplier FROM ad_campaign_placements WHERE ad_id=:id`, { id:ad.id, publicId });
  await connection.execute('UPDATE wallet_transactions SET campaign_public_id=:publicId, ad_id=NULL WHERE ad_id=:id', { id:ad.id, publicId });
  await connection.execute("DELETE FROM admin_events WHERE kind='ad' AND (ad_public_id=:publicId OR detail=:publicId)", {publicId});
  await connection.execute('DELETE FROM ads WHERE id = :id', { id: ad.id });
  return { deleted: true, ...refund, localPath:ad.creative_local_path || null };
}
async function deleteCampaign(publicId, advertiserId = null, options = {}) {
  const {localPath, ...result} = await withTransaction((connection) => deleteCampaignLocked(connection, publicId, advertiserId, options), { isolationLevel: 'READ COMMITTED' });
  if (localPath) await require('./adPlatform').deleteCreativeFile(localPath);
  return result;
}

module.exports = {
  refundUnspent,
  deleteCampaign,
  deleteCampaignLocked,
  changeCampaignStatus,
  settleExpiredCampaigns,
};
