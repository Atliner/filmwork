'use strict';
const { AppError } = require('../lib/errors');
const { telegramErrorDescription, isTelegramDeletionError } = require('../lib/telegram');
const { parseTelegramMessage, resolveLink } = require('./mediaAdmin');
const { downloadBotService } = require('../bots/downloadBot');
const { deliverWithTelegramAd } = require('./telegramAds');
const { scheduleDeletion } = require('./telegramDeletion');
const { formatDownloadCaption } = require('../lib/botBranding');

async function deliverManual(row, user, settings = {}) {
  let bot;
  try { bot = downloadBotService.ensureReady(); }
  catch { throw new AppError(503, 'DELIVERY_BOT_UNAVAILABLE', 'ربات دریافت فایل روی هاست هنوز پیکربندی نشده است.'); }
  const resolve = (name) => bot.telegram.getChat(name);
  const target = await resolveLink(row.telegram_url, null, null, resolve);
  const caption = formatDownloadCaption(settings['download.caption'], { siteName:settings['site.name'], title:row.content_title, version:row.version_title });
  let sent;
  try {
    sent = await deliverWithTelegramAd(user.id, button => downloadBotService.copyMedia(user.tg_chat_id, target.chatId, target.messageId, caption, button));
  } catch (error) {
    const message = telegramErrorDescription(error);
    if (/bot was blocked by the user|chat not found|bot can't initiate conversation/i.test(message)) throw new AppError(503, 'DELIVERY_BOT_START_REQUIRED', 'ابتدا ربات دریافت را باز کنید و /start بزنید و دسترسی ربات به کانال را بررسی کنید.');
    if (isTelegramDeletionError(error)) throw new AppError(410, 'MEDIA_UNAVAILABLE', 'پیام فایل در تلگرام در دسترس نیست.');
    throw new AppError(503, 'TELEGRAM_TEMPORARY_FAILURE', 'ارسال فایل ممکن نشد؛ دسترسی ربات به کانال و پیام را بررسی کنید.');
  }
  if (!await scheduleDeletion(user.tg_chat_id, sent, settings['download.delete_after_minutes'])) {
    throw new AppError(503, 'DELETION_QUEUE_UNAVAILABLE', 'ثبت زمان حذف پیام ممکن نشد؛ پیام ارسال‌شده ممکن است فوراً حذف شده باشد.');
  }
  let subtitleDelivered = false;
  if (row.subtitle_url) {
    try {
      parseTelegramMessage(row.subtitle_url);
      const sub = await resolveLink(row.subtitle_url, null, null, resolve);
      const sentSubtitle = await downloadBotService.sendSubtitle(user.tg_chat_id, sub.chatId, sub.messageId);
      subtitleDelivered = await scheduleDeletion(user.tg_chat_id, sentSubtitle, settings['download.delete_after_minutes']);
    } catch (error) { console.warn('Manual subtitle delivery failed:', telegramErrorDescription(error)); }
  }
  return { delivered:true, deliveryMethod:'telegram_copy', subtitleDelivered };
}
module.exports = { deliverManual };
