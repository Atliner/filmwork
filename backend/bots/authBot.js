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

/** Telegraf throws "Bot is not running!" when stop() precedes a successful launch. */
function safeStop(bot, reason) {
  if (!bot) return;
  try {
    bot.stop(reason);
  } catch {
    // Nothing was polling, so there is nothing to stop.
  }
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
    if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      throw new Error('AUTH_BOT_TOKEN does not look like a BotFather token (expected 123456789:AAAA...)');
    }
    this.bot = new Telegraf(token);
    this.registerHandlers();
    try {
      await this.bot.launch({
        dropPendingUpdates: false,
        allowedUpdates: ['message'],
      });
    } catch (error) {
      safeStop(this.bot, 'startup-failure');
      this.bot = null;
      this.started = false;
      const conflict = /409|terminated by other getUpdates request/i.test(telegramErrorDescription(error));
      throw new Error(conflict
        ? 'Public authentication bot cannot poll: another process is already polling AUTH_BOT_TOKEN (Telegram 409). Run a single instance or use a webhook.'
        : `Public authentication bot could not start: ${telegramErrorDescription(error)}`);
    }
    this.started = true;
    console.log('Public authentication bot started.');
    return true;
  }

  registerHandlers() {
    const dispatch = (handler, label) => (ctx) => {
      setImmediate(async () => {
        const startedAt = Date.now();
        try { await handler(ctx); } catch (error) { console.error('Auth bot handler failed:', telegramErrorDescription(error)); }
        finally {
          const durationMs = Date.now() - startedAt;
          if (durationMs > 5000) console.warn(`Auth bot ${label} handler took ${durationMs}ms (chat ${ctx.chat?.id || 'unknown'}).`);
        }
      });
    };
    this.bot.start(dispatch(async (ctx) => {
      await ctx.reply(
        'برای ورود امن به Filmwork، شماره تلگرام خودتان را با دکمه زیر به اشتراک بگذارید. کد ورود فقط پنج دقیقه معتبر است.',
        Markup.keyboard([
          Markup.button.contactRequest('اشتراک شماره و دریافت کد'),
        ]).resize().oneTime(),
      );
    }, 'start'));

    this.bot.command('login', dispatch(async (ctx) => {
      await ctx.reply(
        'برای ساخت کد شش‌رقمی، شماره متعلق به همین حساب را ارسال کنید.',
        Markup.keyboard([
          Markup.button.contactRequest('دریافت کد ورود'),
        ]).resize().oneTime(),
      );
    }, 'login'));

    this.bot.on('contact', (ctx) => {
      // Do not let database work for a contact update block the long-poll queue.
      setImmediate(() => {
      const contactStartedAt = Date.now();
      (async () => {
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
      })().catch((error) => console.error('Auth bot contact task failed:', error)).finally(() => {
        const durationMs = Date.now() - contactStartedAt;
        if (durationMs > 5000) console.warn(`Auth bot contact handler took ${durationMs}ms (chat ${ctx.chat?.id || 'unknown'}).`);
      });
      });
    });

    this.bot.on('message', dispatch(async (ctx) => {
      if (!ctx.message.contact && !ctx.message.text?.startsWith('/')) {
        await ctx.reply('برای دریافت کد، /login را بزنید و دکمه اشتراک شماره را انتخاب کنید.');
      }
    }, 'message'));

    this.bot.catch((error) => {
      console.error('Auth bot update failed:', telegramErrorDescription(error));
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
