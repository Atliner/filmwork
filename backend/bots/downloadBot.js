'use strict';

const { Telegraf } = require('telegraf');
const { telegramErrorDescription } = require('../lib/telegram');

function safeStop(bot, reason) { try { bot?.stop(reason); } catch { /* not launched */ } }

class DownloadBotService {
  constructor() { this.bot = null; this.started = false; }
  async start() {
    const token = process.env.DOWNLOAD_BOT_TOKEN;
    if (!token) { console.warn('DOWNLOAD_BOT_TOKEN is not configured; the download bot is disabled.'); return false; }
    if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('DOWNLOAD_BOT_TOKEN is invalid.');
    this.bot = new Telegraf(token);
    this.bot.start((ctx) => ctx.reply('سلام! این ربات مخصوص دریافت فایل‌های Filmwork است. برای ورود به سایت از ربات ورود استفاده کنید.'));
    this.bot.catch((error) => console.error('Download bot update failed:', telegramErrorDescription(error)));
    try {
      await this.bot.launch({ dropPendingUpdates: false, allowedUpdates: ['message'] });
      this.started = true;
      console.log('Telegram download bot started.');
      return true;
    } catch (error) {
      safeStop(this.bot, 'startup-failure'); this.bot = null; this.started = false;
      const conflict = /409|terminated by other getUpdates request/i.test(telegramErrorDescription(error));
      throw new Error(conflict ? 'Download bot has another active polling process (Telegram 409).' : `Download bot could not start: ${telegramErrorDescription(error)}`);
    }
  }
  ensureReady() {
    if (!this.bot || !this.started) { const error = new Error('Download bot is not running'); error.code = 'BOT_UNAVAILABLE'; throw error; }
  }
  async copyMedia(chatId, sourceChatId, messageId, caption) {
    this.ensureReady();
    return this.bot.telegram.copyMessage(chatId, sourceChatId, messageId, { protect_content: false, ...(caption ? { caption } : {}) });
  }
  async sendSubtitle(chatId, sourceChatId, messageId) {
    this.ensureReady();
    return this.bot.telegram.copyMessage(chatId, sourceChatId, messageId, { caption: 'زیرنویس مجزای فایل بالا', protect_content: false });
  }
  async sendFallbackLink(chatId, link, caption) {
    this.ensureReady();
    return this.bot.telegram.sendMessage(chatId, caption || 'اگر دریافت خودکار انجام نشد، پیام ذخیره‌شده را باز کنید:', {
      reply_markup: { inline_keyboard: [[{ text: 'باز کردن فایل در تلگرام', url: link }]] }, link_preview_options: { is_disabled: true },
    });
  }
  async stop(reason = 'shutdown') { if (this.bot && this.started) { this.bot.stop(reason); this.started = false; } }
}

const downloadBotService = new DownloadBotService();
module.exports = { DownloadBotService, downloadBotService };
