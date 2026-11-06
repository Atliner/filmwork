'use strict';

const { query, withTransaction } = require('../config/db');
const { AppError } = require('../lib/errors');
const {
  isTelegramDeletionError,
  telegramErrorDescription,
  probeTelegramLink,
} = require('../lib/telegram');
const { authBotService } = require('../bots/authBot');

async function getMedia(publicId) {
  const rows = await query(
    `SELECT ml.*, c.asset_uuid, c.title
     FROM media_links ml
     JOIN contents c ON c.id = ml.content_id
     WHERE ml.public_id = :publicId AND ml.is_active = TRUE AND c.status = 'published'
     LIMIT 1`,
    { publicId },
  );
  return rows[0] || null;
}

async function markHealthy(id) {
  await query(
    `UPDATE media_links
     SET health_status = 'healthy', last_checked_at = UTC_TIMESTAMP(3)
     WHERE id = :id`,
    { id },
  );
}

async function promoteFallback(mediaId, expectedPrimaryMessageId, expectedPrimaryLink, reason) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      'SELECT * FROM media_links WHERE id = :id FOR UPDATE',
      { id: mediaId },
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'MEDIA_NOT_FOUND', 'فایل پیدا نشد.');

    // Another request may already have repaired the row while this request was probing it.
    if (
      String(row.primary_message_id || '') !== String(expectedPrimaryMessageId || '') ||
      String(row.tg_link_primary || '') !== String(expectedPrimaryLink || '')
    ) {
      return { promoted: true, concurrently: true, available: Boolean(row.tg_link_primary) };
    }

    const promotedUrl = row.tg_link_fallback_1;
    await connection.execute(
      `UPDATE media_links SET
         tg_link_primary = tg_link_fallback_1,
         tg_link_fallback_1 = tg_link_fallback_2,
         tg_link_fallback_2 = NULL,
         primary_chat_id = fallback_1_chat_id,
         primary_message_id = fallback_1_message_id,
         fallback_1_chat_id = fallback_2_chat_id,
         fallback_1_message_id = fallback_2_message_id,
         fallback_2_chat_id = NULL,
         fallback_2_message_id = NULL,
         subtitle_link_primary = subtitle_link_fallback_1,
         subtitle_link_fallback_1 = subtitle_link_fallback_2,
         subtitle_link_fallback_2 = NULL,
         subtitle_primary_message_id = subtitle_fallback_1_message_id,
         subtitle_fallback_1_message_id = subtitle_fallback_2_message_id,
         subtitle_fallback_2_message_id = NULL,
         health_status = IF(:promotedUrl IS NULL, 'unavailable', 'promoted'),
         failure_count = failure_count + 1,
         last_checked_at = UTC_TIMESTAMP(3),
         is_active = (:promotedUrl IS NOT NULL)
       WHERE id = :id`,
      { id: mediaId, promotedUrl },
    );
    await connection.execute(
      `INSERT INTO media_health_events (media_link_id, failed_url, reason, promoted_url)
       VALUES (:id, :failedUrl, :reason, :promotedUrl)`,
      {
        id: mediaId,
        failedUrl: row.tg_link_primary,
        reason: String(reason || 'unknown').slice(0, 255),
        promotedUrl,
      },
    );
    return { promoted: Boolean(promotedUrl), concurrently: false, available: Boolean(promotedUrl) };
  }, { isolationLevel: 'READ COMMITTED' });
}

async function deliverSubtitleBestEffort(user, media) {
  if (!media.subtitle_primary_message_id || !media.primary_chat_id) return false;
  const attempts = [
    [media.primary_chat_id, media.subtitle_primary_message_id],
    [media.fallback_1_chat_id, media.subtitle_fallback_1_message_id],
    [media.fallback_2_chat_id, media.subtitle_fallback_2_message_id],
  ].filter((pair) => pair[0] && pair[1]);
  for (const [chatId, messageId] of attempts) {
    try {
      await authBotService.sendSubtitle(user.tg_chat_id, chatId, messageId);
      return true;
    } catch (error) {
      console.warn('Subtitle copy failed; trying next replica:', telegramErrorDescription(error));
    }
  }
  return false;
}

/**
 * Delivers through Telegram and repairs stale primary replicas atomically. A Bot API
 * copy is the authoritative check for private channel messages; public links also
 * receive a lightweight HTTP deletion-marker probe before copying.
 */
async function deliverMedia(publicId, user) {
  try {
    await authBotService.sendDownloadNotice(user.tg_chat_id);
  } catch (error) {
    console.error('Could not open the user delivery chat:', telegramErrorDescription(error));
    throw new AppError(
      503,
      'DELIVERY_BOT_UNAVAILABLE',
      'ربات تحویل در دسترس نیست؛ ابتدا گفت‌وگوی ربات را باز کنید و /start را بزنید.',
    );
  }
  const timeout = Math.max(1000, Math.min(15_000, Number(process.env.TELEGRAM_LINK_CHECK_TIMEOUT_MS || 5000)));

  for (let replicaAttempt = 0; replicaAttempt < 3; replicaAttempt += 1) {
    const media = await getMedia(publicId);
    if (!media || !media.tg_link_primary) {
      throw new AppError(410, 'MEDIA_UNAVAILABLE', 'نسخه‌های ذخیره‌شده این فایل در دسترس نیستند.');
    }

    const probe = await probeTelegramLink(media.tg_link_primary, timeout);
    if (!probe.healthy && probe.definitive) {
      await promoteFallback(
        media.id,
        media.primary_message_id,
        media.tg_link_primary,
        probe.reason,
      );
      continue;
    }

    // Older/manual rows can contain only a link. Deliver that link without pretending
    // that Bot API copying was possible.
    if (!media.primary_chat_id || !media.primary_message_id) {
      await authBotService.sendFallbackLink(user.tg_chat_id, media.tg_link_primary);
      await markHealthy(media.id);
      return {
        delivered: true,
        deliveryMethod: 'telegram_link',
        telegramLink: media.tg_link_primary,
        subtitleDelivered: false,
      };
    }

    try {
      await authBotService.copyMedia(user.tg_chat_id, media.primary_chat_id, media.primary_message_id);
      const subtitleDelivered = await deliverSubtitleBestEffort(user, media);
      await markHealthy(media.id);
      return {
        delivered: true,
        deliveryMethod: 'telegram_copy',
        telegramLink: media.tg_link_primary,
        subtitleDelivered,
      };
    } catch (error) {
      if (!isTelegramDeletionError(error)) {
        console.error('Telegram delivery failed without a deletion signal:', error);
        throw new AppError(
          503,
          'TELEGRAM_TEMPORARY_FAILURE',
          'ارتباط با تلگرام موقتاً برقرار نشد؛ کمی بعد دوباره تلاش کنید.',
        );
      }
      await promoteFallback(
        media.id,
        media.primary_message_id,
        media.tg_link_primary,
        telegramErrorDescription(error),
      );
    }
  }

  throw new AppError(410, 'MEDIA_UNAVAILABLE', 'هر سه نسخه ذخیره‌شده این فایل حذف شده‌اند.');
}

module.exports = {
  getMedia,
  markHealthy,
  promoteFallback,
  deliverMedia,
};
