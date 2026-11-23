'use strict';

/**
 * Owner-facing ad platform operations for the MySQL store: settings, placement
 * toggles/prices, review queue, owner campaigns and creative cleanup.
 */

const fs = require('fs');
const path = require('path');
const { query, withTransaction } = require('../config/db');
const { AppError, assert } = require('../lib/errors');
const {
  PLACEMENTS,
  GROUPS,
  DEFAULTS,
  mergeSettings,
  adPolicy,
  placementMeta,
  placementGroup,
  buildSettingsUpdate,
} = require('./adSettings');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

async function readSettings() {
  const rows = await query('SELECT setting_key, setting_value FROM app_settings');
  return mergeSettings(rows);
}

async function writeSettings(payload) {
  const updates = buildSettingsUpdate(payload);
  assert(updates.length, 422, 'NO_SETTINGS', 'مقداری برای ذخیره فرستاده نشد.');
  for (const entry of updates) {
    await query(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES (:key, :value)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      entry,
    );
  }
  return readSettings();
}

async function readPlacements() {
  const rows = await query(
    `SELECT placement, slot_group, display_name_fa, price_per_thousand, default_duration_seconds,
            minimum_budget, currency, is_active, is_enabled, display_order
     FROM ad_placement_prices`,
  );
  const byKey = new Map(rows.map((row) => [row.placement, row]));
  return PLACEMENTS.map((meta) => {
    const row = byKey.get(meta.placement) || {};
    return {
      placement: meta.placement,
      group: row.slot_group || meta.group,
      label: row.display_name_fa || meta.label,
      asset: meta.asset,
      order: Number(row.display_order || meta.order),
      enabled: row.is_enabled === undefined ? false : Boolean(row.is_enabled),
      active: row.is_active === undefined ? false : Boolean(row.is_active),
      cpm: Number(row.price_per_thousand || 0),
      minBudget: Number(row.minimum_budget || 0),
      durationSeconds: Number(row.default_duration_seconds || 0),
      currency: row.currency || 'IRR',
    };
  }).sort((a, b) => a.order - b.order);
}

async function updatePlacement(placement, patch = {}) {
  const meta = placementMeta(placement);
  assert(meta, 422, 'INVALID_PLACEMENT', 'جایگاه نامعتبر است.');
  if (patch.enabled !== undefined) assert(typeof patch.enabled === 'boolean', 422, 'INVALID_PLACEMENT_STATE', 'وضعیت جایگاه معتبر نیست.');
  // If an older installation has a missing catalogue row, create only that
  // row with safe configured defaults; never overwrite an existing price.
  const existsBefore = await query('SELECT placement FROM ad_placement_prices WHERE placement = :placement', { placement });
  if (!existsBefore.length) {
    const policy = adPolicy(await readSettings());
    await query(`INSERT INTO ad_placement_prices
      (placement,slot_group,display_name_fa,price_per_thousand,default_duration_seconds,minimum_budget,currency,is_enabled,is_active,display_order)
      VALUES (:placement,:groupName,:label,:cpm,:duration,:minimum,'IRR',FALSE,FALSE,:orderValue)
      ON DUPLICATE KEY UPDATE placement=VALUES(placement)`, {
      placement, groupName:meta.group, label:meta.label,
      cpm:Math.max(1, policy.cpm[meta.group] || 50000), minimum:Math.max(1000, policy.minBudget),
      duration:meta.group === 'video' ? policy.defaultVideoDuration : meta.group === 'banner' ? policy.defaultBannerDuration : 0,
      orderValue:meta.order,
    });
  }
  const fields = [];
  const params = { placement };
  if (patch.enabled !== undefined) {
    fields.push('is_enabled = :enabled', 'is_active = :enabled');
    params.enabled = patch.enabled ? 1 : 0;
  }
  if (patch.pricePerThousand !== undefined) {
    params.cpm = Math.max(0, Number(patch.pricePerThousand) || 0);
    fields.push('price_per_thousand = :cpm');
  }
  if (patch.minimumBudget !== undefined) {
    params.minBudget = Math.max(0, Number(patch.minimumBudget) || 0);
    fields.push('minimum_budget = :minBudget');
  }
  if (patch.durationSeconds !== undefined) {
    params.duration = Math.max(0, Math.round(Number(patch.durationSeconds) || 0));
    fields.push('default_duration_seconds = :duration');
  }
  if (patch.label !== undefined && String(patch.label).trim()) {
    params.label = String(patch.label).trim().slice(0, 80);
    fields.push('display_name_fa = :label');
  }
  assert(fields.length, 422, 'NO_PLACEMENT_CHANGES', 'تغییری برای ذخیره وجود ندارد.');
  const result = await query(`UPDATE ad_placement_prices SET ${fields.join(', ')} WHERE placement = :placement`, params);
  // An absent placement row must not silently produce a success toast.
  const placements = await readPlacements();
  const selected = placements.find((slot) => slot.placement === placement);
  if (!result.affectedRows) {
    const exists = await query('SELECT placement FROM ad_placement_prices WHERE placement = :placement', { placement });
    assert(exists.length, 409, 'PLACEMENT_MISSING', 'رکورد این جایگاه در دیتابیس موجود نیست؛ migration مربوط به تبلیغات را بررسی کنید.');
  }
  if (patch.enabled !== undefined) assert(selected && selected.enabled === Boolean(patch.enabled) && selected.active === Boolean(patch.enabled), 409, 'PLACEMENT_NOT_SAVED', 'وضعیت جایگاه ذخیره نشد؛ ساختار دیتابیس و دسترسی نوشتن را بررسی کنید.');
  return placements;
}

/** Review queue: pending campaigns with their advertiser and creative. */
async function listCampaigns({ status = '', owner = '', limit = 200 } = {}) {
  const where = ['a.deleted_at IS NULL'];
  const params = { limit: Math.min(500, Math.max(1, Number(limit) || 200)) };
  if (status && ['pending', 'active', 'paused', 'completed', 'rejected'].includes(status)) {
    where.push('a.status = :status');
    params.status = status;
  }
  if (owner === 'owner') where.push('a.owner_campaign = TRUE');
  if (owner === 'users') where.push('a.owner_campaign = FALSE');
  const rows = await query(
    `SELECT a.public_id, a.campaign_name, a.headline, a.body, a.placement, a.asset_type,
            a.creative_url, a.creative_local_path, a.target_url, a.telegram_click_mode, a.landing_mode, a.budget, a.spent, a.status,
            a.owner_campaign, a.review_note, a.reviewed_at, a.duration_seconds, a.skip_after_seconds,
            a.starts_at, a.ends_at, a.created_at,
            (SELECT GROUP_CONCAT(ap.placement ORDER BY ap.placement SEPARATOR ',') FROM ad_campaign_placements ap WHERE ap.ad_id = a.id) AS placements,
            u.account_name, u.tg_username,
            (SELECT COUNT(*) FROM ad_events e WHERE e.ad_id = a.id AND e.event_type = 'impression') AS impressions,
            (SELECT COUNT(*) FROM ad_events e WHERE e.ad_id = a.id AND e.event_type = 'click') AS clicks
     FROM ads a JOIN users u ON u.id = a.advertiser_id
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(a.status, 'pending', 'active', 'paused', 'rejected', 'completed'), a.created_at DESC
     LIMIT :limit`,
    params,
  );
  return rows.map((row) => ({
    id: row.public_id,
    campaignName: row.campaign_name,
    headline: row.headline,
    body: row.body,
    placement: row.placement,
    placements: row.placements ? row.placements.split(',') : [row.placement],
    landingMode: row.landing_mode,
    group: placementGroup(row.placement),
    assetType: row.asset_type,
    creativeUrl: row.creative_url,
    localUpload: Boolean(row.creative_local_path),
    targetUrl: row.target_url,
    telegramClickMode: row.telegram_click_mode,
    budget: Number(row.budget),
    spent: Number(row.spent),
    status: row.status,
    ownerCampaign: Boolean(row.owner_campaign),
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    durationSeconds: row.duration_seconds,
    skipAfterSeconds: row.skip_after_seconds,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    advertiser: row.account_name,
    advertiserUsername: row.tg_username,
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
  }));
}

async function deleteCreativeFile(localPath) {
  if (!localPath) return;
  const resolved = path.resolve(UPLOAD_DIR, path.basename(String(localPath)));
  if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) return;
  await fs.promises.unlink(resolved).catch(() => {});
}

/**
 * Approve / reject / pause a campaign. Rejection refunds the unspent budget and —
 * per the owner's rule — removes an uploaded creative from the host entirely.
 * `changeCampaignStatus` lives in adAccounting because the advertiser side uses it.
 */
async function reviewCampaign(publicId, { status, note }) {
  const { changeCampaignStatus } = require('./adAccounting');
  const result = await changeCampaignStatus(publicId, status);
  const rows = await query('SELECT id, creative_local_path FROM ads WHERE public_id = :publicId', { publicId });
  const row = rows[0];
  assert(row, 404, 'AD_NOT_FOUND', 'تبلیغ پیدا نشد.');
  await query(
    'UPDATE ads SET review_note = :note, reviewed_at = UTC_TIMESTAMP(3) WHERE id = :id',
    { note: note ? String(note).slice(0, 255) : null, id: row.id },
  );
  if (status === 'rejected') await deleteCreativeFile(row.creative_local_path);
  return { ...result, creativePurged: status === 'rejected' && Boolean(row.creative_local_path) };
}

/** Owner campaigns skip the wallet: the owner is the platform. */
async function createOwnerCampaign(payload) {
  const crypto = require('crypto');
  const { asString, asEnum, asPositiveNumber, asDate, asHttpUrl } = require('../lib/validation');
  const { parsePlacements } = require('./adPlacements');
  const { normalizeBid } = require('./adCompetition');
  const { telegramTarget, trackedOrigin } = require('../lib/telegramAd');
  const policy = adPolicy(await readSettings());
  const placements = parsePlacements(payload);
  const placement = placements[0], meta = placementMeta(placement);
  const bid = normalizeBid(payload.bidMultiplier, placement, policy.maxPriorityMultiplier);
  const campaignName = asString(payload.campaignName, 'نام کمپین', { min:3, max:180 });
  const headline = asString(payload.headline, 'عنوان تبلیغ', { min:3, max:180 });
  const body = asString(payload.body, 'متن تبلیغ', { max:1000, optional:true });
  let targetUrl = asHttpUrl(payload.targetUrl, 'نشانی مقصد', { optional:placement !== 'link_file_button' });
  const clickMode = placement === 'link_file_button' ? asEnum(payload.telegramClickMode || 'tracked', 'شیوهٔ هدایت', ['tracked','direct']) : 'tracked';
  const landingMode = placement === 'link_file_button' ? 'intermediate' : asEnum(payload.landingMode || 'intermediate', 'شیوهٔ هدایت', ['intermediate','direct']);
  if (landingMode === 'direct') assert(targetUrl, 422, 'TARGET_REQUIRED', 'برای هدایت مستقیم نشانی مقصد لازم است.');
  if (placement === 'link_file_button') { targetUrl = telegramTarget(targetUrl); if (clickMode === 'tracked') trackedOrigin(); assert(headline.length <= 64, 422, 'BUTTON_TEXT_TOO_LONG', 'عنوان دکمه حداکثر ۶۴ نویسه است.'); }
  const startsAt = payload.startsAt ? asDate(payload.startsAt, 'زمان شروع') : new Date();
  const endsAt = payload.endsAt ? asDate(payload.endsAt, 'زمان پایان') : new Date(Date.now() + 30 * 86400_000);
  assert(endsAt > startsAt, 422, 'INVALID_CAMPAIGN_DATES', 'زمان پایان باید بعد از شروع باشد.');
  const creativeUrl = payload.creativeUrl ? asHttpUrl(payload.creativeUrl, 'فایل تبلیغ') : '';
  assert(['text','link'].includes(meta.asset) || creativeUrl || payload.creativeLocalPath, 422, 'CREATIVE_REQUIRED', 'فایل یا لینک تبلیغ لازم است.');
  const duration = payload.durationSeconds !== undefined ? Math.max(0, Math.round(Number(payload.durationSeconds) || 0)) : (meta.group === 'banner' ? policy.defaultBannerDuration : policy.defaultVideoDuration);
  const budget = payload.budget ? asPositiveNumber(payload.budget, 'بودجه', { min:1000 }) : 1000;
  const postText = asString(payload.telegramPostText, 'متن صفحه واسط', { max:5000, optional:true });
  const publicId = crypto.randomUUID();
  await withTransaction(async (connection) => {
    const prices = new Map();
    for (const key of [...placements].sort()) {
      const [rows] = await connection.execute('SELECT CAST(price_per_thousand AS CHAR) AS price FROM ad_placement_prices WHERE placement = :placement AND is_active = TRUE AND is_enabled = TRUE FOR UPDATE', {placement:key});
      assert(rows[0], 422, 'PLACEMENT_UNAVAILABLE', 'یکی از جایگاه‌های انتخاب‌شده فعال نیست.');
      prices.set(key, rows[0].price);
    }
    const [owners] = await connection.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id ASC LIMIT 1");
    assert(owners[0], 409, 'OWNER_ACCOUNT_REQUIRED', 'برای ثبت تبلیغ مالک، حداقل یک حساب کاربری لازم است.');
    const [result] = await connection.execute(`INSERT INTO ads
      (public_id, advertiser_id, owner_campaign, campaign_name, headline, body, placement, asset_type,
       creative_url, creative_local_path, target_url, telegram_click_mode, landing_mode, telegram_post_text, unit_price, bid_multiplier, budget, spent, duration_seconds,
       skip_after_seconds, starts_at, ends_at, status)
     VALUES (:publicId, :ownerId, TRUE, :campaignName, :headline, :body, :placement, :assetType,
       :creativeUrl, :localPath, :targetUrl, :clickMode, :landingMode, :postText, ROUND(:basePrice * :bid,2), :bid, :budget, 0, :duration,
       :skipAfter, :startsAt, :endsAt, 'active')`,
      { publicId, ownerId:owners[0].id, campaignName, headline, body, placement, assetType:meta.asset === 'video' ? 'video' : 'image',
        creativeUrl, localPath:payload.creativeLocalPath || null, targetUrl, clickMode, landingMode, postText, basePrice:prices.get(placement), bid, budget, duration, skipAfter:policy.skipAfterSeconds, startsAt, endsAt });
    for (const key of placements) await connection.execute(`INSERT INTO ad_campaign_placements (ad_id, placement, unit_price, bid_multiplier)
      VALUES (:adId, :placement, ROUND(:basePrice * :bid, 2), :bid)`, {adId:result.insertId, placement:key, basePrice:prices.get(key), bid});
  }, {isolationLevel:'READ COMMITTED'});
  return { id:publicId, status:'active', ownerCampaign:true, placements };
}

/**
 * Housekeeping: a rejected campaign keeps no file on the host. The review action
 * deletes immediately; this sweeper catches anything left behind (a crash between
 * status change and unlink, or campaigns rejected straight in the database).
 */
async function purgeRejectedCreatives() {
  const minutes = Number(await (async () => {
    const settings = await readSettings().catch(() => ({}));
    return settings['ads.reject_purge_minutes'] || 60;
  })());
  const rows = await query(
    `SELECT id, public_id, creative_local_path FROM ads
     WHERE status = 'rejected' AND creative_local_path IS NOT NULL
       AND reviewed_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL :minutes MINUTE)`,
    { minutes: Math.max(0, Math.round(minutes)) },
  ).catch(() => []);
  let purged = 0;
  for (const row of rows) {
    await deleteCreativeFile(row.creative_local_path);
    await query('UPDATE ads SET creative_local_path = NULL WHERE id = :id', { id: row.id });
    purged += 1;
  }
  return { purged };
}

/** Advertising dashboard numbers for the settings page. */
async function adDashboard() {
  const [totals] = await query(
    `SELECT COUNT(*) AS campaigns,
            SUM(status = 'pending') AS pending,
            SUM(status = 'active') AS active,
            SUM(owner_campaign = TRUE) AS ownerCampaigns,
            COALESCE(SUM(spent), 0) + (SELECT COALESCE(SUM(spent),0) FROM ad_financial_archive) AS spent
     FROM ads`,
  );
  const [events] = await query(
    `SELECT SUM(event_type = 'impression') AS impressions,
            SUM(event_type = 'click') AS clicks,
            SUM(event_type = 'complete') AS completes,
            SUM(event_type = 'skip') AS skips
     FROM ad_events WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)`,
  );
  const [wallets] = await query('SELECT COALESCE(SUM(balance), 0) AS balance FROM advertiser_wallets');
  const byGroup = await query(
    `SELECT p.slot_group AS grp,
            COUNT(a.id) AS campaigns,
            COALESCE(SUM(a.budget), 0) AS budget,
            COALESCE(SUM(a.spent), 0) AS spent,
            SUM(a.status = 'active') AS active
     FROM ad_placement_prices p LEFT JOIN ads a ON a.placement = p.placement
     GROUP BY p.slot_group`,
  );
  const archivedByGroup = await query(`SELECT p.slot_group AS grp, SUM(f.budget) AS budget, SUM(f.spent) AS spent
    FROM ad_financial_archive f JOIN ad_placement_prices p ON p.placement=f.primary_placement GROUP BY p.slot_group`);
  return {
    totals: {
      campaigns: Number(totals.campaigns || 0),
      pending: Number(totals.pending || 0),
      active: Number(totals.active || 0),
      ownerCampaigns: Number(totals.ownerCampaigns || 0),
      spent: Number(totals.spent || 0),
      impressions: Number(events.impressions || 0),
      clicks: Number(events.clicks || 0),
      completes: Number(events.completes || 0),
      skips: Number(events.skips || 0),
      walletBalance: Number(wallets.balance || 0),
    },
    byGroup: GROUPS.map((group) => {
      const row = byGroup.find((item) => item.grp === group.group) || {};
      const archived = archivedByGroup.find((item) => item.grp === group.group) || {};
      return {
        group: group.group,
        label: group.label,
        campaigns: Number(row.campaigns || 0),
        active: Number(row.active || 0),
        budget: Number(row.budget || 0) + Number(archived.budget || 0),
        spent: Number(row.spent || 0) + Number(archived.spent || 0),
      };
    }),
  };
}

module.exports = {
  readSettings,
  writeSettings,
  readPlacements,
  updatePlacement,
  listCampaigns,
  reviewCampaign,
  createOwnerCampaign,
  adDashboard,
  purgeRejectedCreatives,
  deleteCreativeFile,
  DEFAULTS,
  UPLOAD_DIR,
};
