'use strict';
const crypto = require('node:crypto');
const { query, withTransaction } = require('../config/db');
const { createAdSession } = require('../lib/adSession');
const { hmacHex } = require('../lib/security');
const { telegramTarget, trackedOrigin } = require('../lib/telegramAd');

/**
 * One CPM impression = one successful Telegram API send with the button.
 * A row lock serializes budget use. Telegram and MySQL cannot share a transaction:
 * if the send succeeds but commit fails, do not send the file twice; log the
 * reconciliation failure. No attempt is made to count direct-link clicks.
 */
async function deliverWithTelegramAd(userId, send, deps = {}) {
  const getRows = deps.query || query;
  const transact = deps.withTransaction || withTransaction;
  let candidates;
  try {
    candidates = await getRows(`SELECT a.public_id FROM ads a JOIN ad_placement_prices p ON p.placement = a.placement
      WHERE a.placement = 'link_file_button' AND a.deleted_at IS NULL AND a.status = 'active'
        AND p.is_enabled = TRUE AND p.is_active = TRUE AND a.starts_at <= UTC_TIMESTAMP(3) AND a.ends_at > UTC_TIMESTAMP(3)
        AND (a.owner_campaign = TRUE OR a.budget - a.spent >= a.unit_price / 1000)
      ORDER BY a.id`, {});
  } catch (error) { console.error('Could not select Telegram ad; delivering without ad:', error.message); return send(null); }
  // Random circular order is a uniform choice without using a bid multiplier.
  if (candidates.length) {
    const offset = (deps.randomInt || crypto.randomInt)(0, candidates.length);
    candidates = candidates.slice(offset).concat(candidates.slice(0, offset));
  }
  for (const candidate of candidates) {
    let sent = false, sentResult, sendError;
    try {
      const outcome = await transact(async (connection) => {
        const [rows] = await connection.execute(`SELECT a.id, a.public_id, a.headline, a.target_url, a.telegram_click_mode, a.owner_campaign
          FROM ads a JOIN ad_placement_prices p ON p.placement = a.placement
          WHERE a.public_id = :id AND a.placement = 'link_file_button' AND a.deleted_at IS NULL AND a.status = 'active'
            AND p.is_enabled = TRUE AND p.is_active = TRUE AND a.starts_at <= UTC_TIMESTAMP(3) AND a.ends_at > UTC_TIMESTAMP(3)
            AND (a.owner_campaign = TRUE OR a.budget - a.spent >= a.unit_price / 1000) FOR UPDATE`, { id:candidate.public_id });
        const ad = rows[0];
        if (!ad) return { skipped:true };
        let target;
        try { target = telegramTarget(ad.target_url); } catch { return { skipped:true }; }
        const session = createAdSession(ad.public_id, { purpose:'telegram', ttlMs:90 * 86400_000 });
        let link = target;
        if (ad.telegram_click_mode !== 'direct') {
          try { link = `${trackedOrigin()}/api/ads/telegram-click/${encodeURIComponent(ad.public_id)}?session=${encodeURIComponent(session)}`; }
          catch { return { skipped:true }; }
        }
        try { sentResult = await send({ text:String(ad.headline).slice(0, 64), url:link }); sent = true; }
        catch (error) { sendError = error; throw error; }
        const sessionKey = hmacHex(`${ad.public_id}:${session}`);
        await connection.execute(`INSERT INTO ad_events (ad_id,user_id,event_type,session_key,user_agent)
          VALUES (:id,:userId,'impression',:sessionKey,'telegram-delivery')`, { id:ad.id, userId, sessionKey });
        if (!ad.owner_campaign) await connection.execute(`UPDATE ads SET
          status = IF(spent + (unit_price / 1000) >= budget, 'completed', status),
          spent = spent + (unit_price / 1000) WHERE id = :id`, { id:ad.id });
        return { sent:true, result:sentResult };
      }, { isolationLevel:'READ COMMITTED' });
      if (outcome.sent) return outcome.result;
    } catch (error) {
      if (sendError) throw sendError;
      if (sent) { console.error('Telegram ad delivered but accounting failed; reconciliation needed:', error.message); return sentResult; }
      console.error('Telegram ad unavailable; delivering without ad:', error.message);
      return send(null);
    }
  }
  return send(null);
}
module.exports = { deliverWithTelegramAd };
