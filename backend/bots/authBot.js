'use strict';

const { Telegraf, Markup } = require('telegraf');
const { query, withTransaction } = require('../config/db');
const {
  generateLoginCode,
  hmacHex,
  encryptPhone,
} = require('../lib/security');
const { telegramErrorDescription } = require('../lib/telegram');

function normalizePhone(phone) {
  const cleaned = String(phone || '').replace(/[^\d+]/g, '');
  if (!/^\+?\d{7,15}$/.test(cleaned)) throw new Error('شماره تلفن معتبر نیست.');
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

function accountName(from) {
  return [from.first_name, from.last_name]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 160) || 'کاربر تلگرام';
}

class AuthBotService {
  constructor() {
    this.bot = null;
    this.started = false;
  }

  async start() {
    const token = process.env.AUTH_BOT_TOKEN;
    if (!token) {
      console.warn('AUTH_BOT_TOKEN is not configured; login and file delivery bot is disabled.');
      return false;
    }
    this.bot = new Telegraf(token);
    this.registerHandlers();
    await this.bot.launch({
      dropPendingUpdates: false,
      allowedUpdates: ['message'],
    });
    this.started = true;
    console.log('Public authentication bot started.');
    return true;
  }

  registerHandlers() {
    this.bot.start(async (ctx) => {
      await ctx.reply(
        'برای ورود امن به Filmwork، شماره تلگرام خودتان را با دکمه زیر به اشتراک بگذارید. کد ورود فقط پنج دقیقه معتبر است.',
        Markup.keyboard([
          Markup.button.contactRequest('اشتراک شماره و دریافت کد'),
        ]).resize().oneTime(),
      );
    });

    this.bot.command('login', async (ctx) => {
      await ctx.reply(
        'برای ساخت کد شش‌رقمی، شماره متعلق به همین حساب را ارسال کنید.',
        Markup.keyboard([
          Markup.button.contactRequest('دریافت کد ورود'),
        ]).resize().oneTime(),
      );
    });

    this.bot.on('contact', async (ctx) => {
      const contact = ctx.message.contact;
      if (ctx.chat?.type !== 'private') {
        await ctx.reply('ورود فقط در گفت‌وگوی خصوصی با ربات انجام می‌شود.');
        return;
      }
      if (Number(contact.user_id) !== Number(ctx.from.id)) {
        await ctx.reply('فقط شماره متعلق به حساب خودتان پذیرفته می‌شود.');
        return;
      }

      try {
        const recentRows = await query(
          `SELECT COUNT(*) AS total
           FROM login_codes lc
           JOIN users u ON u.id = lc.user_id
           WHERE u.tg_user_id = :tgUserId
             AND lc.created_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 HOUR)`,
          { tgUserId: ctx.from.id },
        );
        if (Number(recentRows[0].total) >= 10) {
          await ctx.reply('تعداد درخواست‌ها بیش از حد مجاز است. یک ساعت دیگر دوباره تلاش کنید.');
          return;
        }

        const phone = normalizePhone(contact.phone_number);
        const ttl = Math.max(2, Math.min(15, Number(process.env.AUTH_CODE_TTL_MINUTES || 5)));
        let code = null;

        // code_hash is globally unique so a six-digit code can identify one active
        // login without asking for a phone number. Expired hashes are removed and a
        // rare collision with another active login is retried atomically.
        for (let attempt = 0; attempt < 12 && !code; attempt += 1) {
          const candidate = generateLoginCode();
          const codeHash = hmacHex(candidate);
          try {
            await withTransaction(async (connection) => {
              await connection.execute(
                'DELETE FROM login_codes WHERE code_hash = :codeHash AND (consumed_at IS NOT NULL OR expires_at <= UTC_TIMESTAMP(3))',
                { codeHash },
              );
              await connection.execute(
                `INSERT INTO users
                  (tg_user_id, tg_chat_id, account_name, tg_username, encrypted_phone, phone_last4)
                 VALUES (:tgUserId, :tgChatId, :accountName, :username, :phone, :last4)
                 ON DUPLICATE KEY UPDATE
                   tg_chat_id = VALUES(tg_chat_id),
                   account_name = VALUES(account_name),
                   tg_username = VALUES(tg_username),
                   encrypted_phone = VALUES(encrypted_phone),
                   phone_last4 = VALUES(phone_last4),
                   updated_at = CURRENT_TIMESTAMP(3)`,
                {
                  tgUserId: ctx.from.id,
                  tgChatId: ctx.chat.id,
                  accountName: accountName(ctx.from),
                  username: ctx.from.username || null,
                  phone: encryptPhone(phone),
                  last4: phone.slice(-4),
                },
              );
              const [users] = await connection.execute(
                'SELECT id, status FROM users WHERE tg_user_id = :tgUserId FOR UPDATE',
                { tgUserId: ctx.from.id },
              );
              if (!users[0] || users[0].status !== 'active') throw new Error('این حساب فعال نیست.');
              await connection.execute(
                `UPDATE login_codes
                 SET consumed_at = UTC_TIMESTAMP(3)
                 WHERE user_id = :userId AND consumed_at IS NULL`,
                { userId: users[0].id },
              );
              await connection.execute(
                `INSERT INTO login_codes (user_id, code_hash, expires_at)
                 VALUES (:userId, :codeHash, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${ttl} MINUTE))`,
                { userId: users[0].id, codeHash },
              );
            });
            code = candidate;
          } catch (error) {
            if (error.code !== 'ER_DUP_ENTRY') throw error;
          }
        }
        if (!code) throw new Error('ساخت کد یکتا ممکن نشد؛ دوباره تلاش کنید.');

        await ctx.reply(
          `کد ورود Filmwork شما:\n\n${code}\n\nاین کد را در وب‌سایت وارد کنید. کد را در اختیار دیگران نگذارید.`,
          Markup.removeKeyboard(),
        );
      } catch (error) {
        console.error('Auth bot contact handling failed:', error);
        await ctx.reply(`صدور کد ممکن نشد: ${String(error.message || error).slice(0, 250)}`, Markup.removeKeyboard());
      }
    });

    this.bot.on('message', async (ctx) => {
      if (!ctx.message.contact && !ctx.message.text?.startsWith('/')) {
        await ctx.reply('برای دریافت کد، /login را بزنید و دکمه اشتراک شماره را انتخاب کنید.');
      }
    });

    this.bot.catch((error) => {
      console.error('Auth bot update failed:', telegramErrorDescription(error));
    });
  }

  ensureReady() {
    if (!this.bot || !this.started) {
      const error = new Error('Authentication bot is not running');
      error.code = 'BOT_UNAVAILABLE';
      throw error;
    }
  }

  async sendDownloadNotice(chatId) {
    this.ensureReady();
    await this.bot.telegram.sendMessage(
      chatId,
      'کاربر گرامی، برای دریافت فایل حتما فیلترشکن یا پروکسی تلگرام خود را روشن کنید.',
    );
  }

  async copyMedia(chatId, sourceChatId, messageId) {
    this.ensureReady();
    return this.bot.telegram.copyMessage(chatId, sourceChatId, messageId, {
      protect_content: false,
    });
  }

  async sendSubtitle(chatId, sourceChatId, messageId) {
    this.ensureReady();
    return this.bot.telegram.copyMessage(chatId, sourceChatId, messageId, {
      caption: 'زیرنویس مجزای فایل بالا',
      protect_content: false,
    });
  }

  async sendFallbackLink(chatId, link) {
    this.ensureReady();
    return this.bot.telegram.sendMessage(chatId, 'اگر دریافت خودکار انجام نشد، پیام ذخیره‌شده را از این پیوند باز کنید:', {
      reply_markup: { inline_keyboard: [[{ text: 'باز کردن فایل در تلگرام', url: link }]] },
      link_preview_options: { is_disabled: true },
    });
  }

  async stop(reason = 'shutdown') {
    if (this.bot && this.started) {
      this.bot.stop(reason);
      this.started = false;
    }
  }
}

const authBotService = new AuthBotService();

module.exports = {
  normalizePhone,
  accountName,
  AuthBotService,
  authBotService,
};
