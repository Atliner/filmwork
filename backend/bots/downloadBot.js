'use strict';

const { Telegraf } = require('telegraf');
const { startPolling, stopPolling } = require('../lib/botPolling');
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
      if (!await startPolling(this, this.bot, ['message'])) return false;
      console.log('Telegram download bot started.');
      return true;
    } catch (error) {
      safeStop(this.bot, 'startup-failure'); this.bot = null; this.started = false;
      const conflict = /409|terminated by other getUpdates request/i.test(telegramErrorDescription(error));
      throw new Error(conflict ? 'Download bot has another active polling process (Telegram 409).' : `Download bot could not start: ${telegramErrorDescription(error)}`);
    }
  }
  ensureReady() {
    // API delivery works on standby HTTP workers too; only polling is exclusive.
    if (this.bot) return this.bot;
    const token = process.env.DOWNLOAD_BOT_TOKEN;
    if (!token) { const error = new Error('Download bot is not configured'); error.code = 'BOT_UNAVAILABLE'; throw error; }
    if (!this.apiBot) this.apiBot = new Telegraf(token);
    return this.apiBot;
  }
  async copyMedia(chatId, sourceChatId, messageId, caption, adButton = null) {
    const bot = this.ensureReady();
    return bot.telegram.copyMessage(chatId, sourceChatId, messageId, { protect_content: false, ...(caption ? { caption } : {}), ...(adButton ? { reply_markup:{ inline_keyboard:[[adButton]] } } : {}) });
  }
  async sendSubtitle(chatId, sourceChatId, messageId) {
    const bot = this.ensureReady();
    return bot.telegram.copyMessage(chatId, sourceChatId, messageId, { caption: 'زیرنویس مجزای فایل بالا', protect_content: false });
  }
  async sendFallbackLink(chatId, link, caption, adButton = null) {
    const bot = this.ensureReady();
    return bot.telegram.sendMessage(chatId, caption || 'اگر دریافت خودکار انجام نشد، پیام ذخیره‌شده را باز کنید:', {
      reply_markup: { inline_keyboard: [[{ text: 'باز کردن فایل در تلگرام', url: link }], ...(adButton ? [[adButton]] : [])] }, link_preview_options: { is_disabled: true },
    });
  }
  async stop(reason = 'shutdown') { await stopPolling(this, reason); }
}

const downloadBotService = new DownloadBotService();
module.exports = { DownloadBotService, downloadBotService };
