'use strict';

const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const { query, withTransaction } = require('../config/db');
const { hmacHex, generateOpaqueToken } = require('../lib/security');
const {
  buildTelegramMessageLink,
  mediaFromMessage,
  isSubtitleMessage,
  telegramErrorDescription,
} = require('../lib/telegram');
const { ownerIds } = require('../middleware/auth');

const DIGIT_MAP = Object.freeze({
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
});

function normalizeDigits(value = '') {
  return String(value).replace(/[۰-۹٠-٩]/g, (digit) => DIGIT_MAP[digit] || digit);
}

function cleanLabelValue(value) {
  return String(value || '')
    .replace(/^\s*[:：\-–—|]+\s*/, '')
    .replace(/\s+$/g, '')
    .trim();
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanLabelValue(match[1]);
  }
  return null;
}

/** Parse common Persian/English movie-channel post formats without relying on a single channel. */
function parsePublicPost(rawText) {
  const text = normalizeDigits(rawText).replace(/\r\n?/g, '\n').trim();
  if (!text) return null;

  const title = firstMatch(text, [
    /(?:^|\n)\s*(?:🎬\s*)?(?:title|movie|series|نام\s*(?:فیلم|سریال)|عنوان)\s*[:：\-]\s*([^\n]+)/iu,
    /(?:^|\n)\s*🎬\s*([^\n#]+)/u,
  ]);
  const imdbRaw = firstMatch(text, [
    /(?:imdb(?:\s*rating)?|امتیاز(?:\s*آی[‌\s]?ام[‌\s]?دی[‌\s]?بی)?)\s*[:：\-]?\s*(\d{1,2}(?:\.\d)?)/iu,
  ]);
  const yearRaw = firstMatch(text, [
    /(?:^|\n).*?(?:release\s*year|year|سال\s*(?:انتشار|ساخت)?|محصول)\s*[:：\-]?\s*((?:18|19|20|21)\d{2})/iu,
  ]);
  const genreRaw = firstMatch(text, [
    /(?:^|\n)\s*(?:genre|genres|ژانر)\s*[:：\-]\s*([^\n]+)/iu,
  ]);
  const description = firstMatch(text, [
    /(?:^|\n)\s*(?:description|summary|plot|خلاصه(?:\s*داستان)?|توضیحات)\s*[:：\-]\s*([\s\S]+?)(?=\n\s*(?:imdb|year|genre|country|director|مدت|امتیاز|سال|ژانر|کشور|کارگردان)\s*[:：\-]|$)/iu,
  ]);

  // A metadata post must contain an explicit title and at least one recognizable field.
  if (!title || ![imdbRaw, yearRaw, genreRaw, description].some(Boolean)) return null;

  const imdb = imdbRaw === null ? null : Number.parseFloat(imdbRaw);
  const year = yearRaw === null ? null : Number.parseInt(yearRaw, 10);
  const genres = genreRaw
    ? genreRaw.split(/[,،|/؛]+/u).map((item) => item.trim()).filter(Boolean).slice(0, 12)
    : [];
  const contentType = /(?:series|سریال|فصل|S\d{1,2}\s*[.\-]?\s*E\d{1,3})/iu.test(text)
    ? 'series'
    : 'movie';

  return {
    title: title.slice(0, 255),
    imdbScore: Number.isFinite(imdb) && imdb >= 0 && imdb <= 10 ? imdb : null,
    releaseYear: Number.isInteger(year) && year >= 1888 && year <= 2200 ? year : null,
    genres,
    description: description ? description.slice(0, 20_000) : null,
    contentType,
  };
}

function directiveValue(text, name) {
  const expression = new RegExp(`#${name}(?=\\s)\\s+([\\s\\S]*?)(?=\\s+#(?:اثر|نسخه|نوع|زیرنویس|رزولوشن|سریال|کیفیت|انکودر)(?=\\s|$)|$)`, 'iu');
  return cleanLabelValue(text.match(expression)?.[1] || '');
}

function parseDirectives(rawText) {
  const text = normalizeDigits(rawText).trim();
  if (!/#اثر(?=\s|$)/u.test(text)) return null;
  const assetUuid = directiveValue(text, 'اثر');
  const version = directiveValue(text, 'نسخه');
  const typeRaw = directiveValue(text, 'نوع');
  const subtitleRaw = directiveValue(text, 'زیرنویس');
  const resolution = directiveValue(text, 'رزولوشن');
  const seriesRaw = directiveValue(text, 'سریال');
  const quality = directiveValue(text, 'کیفیت');
  const encoder = directiveValue(text, 'انکودر');

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetUuid)) {
    return { error: 'شناسه #اثر باید یک UUID معتبر باشد.' };
  }
  if (!version || !typeRaw || !subtitleRaw || !resolution) {
    return { error: 'دستور باید شامل #نسخه، #نوع، #زیرنویس و #رزولوشن باشد.' };
  }

  let audioType = 'original';
  if (/دوبله/u.test(typeRaw)) audioType = 'dubbed';
  else if (/هارد\s*ساب|هاردساب/iu.test(typeRaw)) audioType = 'hard_sub';
  else if (/سافت\s*ساب|سافتساب/iu.test(typeRaw)) audioType = 'soft_sub';

  let subtitleType = 'none';
  if (/مجزا|جدا/u.test(subtitleRaw)) subtitleType = 'separate';
  else if (/داخلی|چسبیده|embedded/iu.test(subtitleRaw)) subtitleType = 'embedded';

  let seasonNumber = null;
  let episodeNumber = null;
  if (seriesRaw) {
    const seriesMatch = seriesRaw.match(/S(?:eason)?\s*0*(\d{1,3})\s*[.\-_ ]?\s*E(?:pisode)?\s*0*(\d{1,4})/iu);
    if (!seriesMatch) return { error: 'قالب #سریال باید مانند S01.E01 باشد.' };
    seasonNumber = Number(seriesMatch[1]);
    episodeNumber = Number(seriesMatch[2]);
  }

  return {
    assetUuid: assetUuid.toLowerCase(),
    version: version.slice(0, 120),
    sourceType: typeRaw.slice(0, 80),
    audioType,
    subtitleType,
    resolution: resolution.slice(0, 24),
    quality: (quality || typeRaw).slice(0, 80),
    encoder: encoder ? encoder.slice(0, 100) : null,
    seasonNumber,
    episodeNumber,
  };
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '\u200c', zwj: '\u200d', hellip: '…' };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const numeric = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

async function fetchPublicTelegramPost(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('لینک پست تلگرام معتبر نیست.');
  }
  if (!['t.me', 'telegram.me'].includes(url.hostname.toLowerCase())) {
    throw new Error('فقط لینک عمومی t.me پذیرفته می‌شود.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || ['c', 's', 'joinchat', '+'].includes(parts[0].toLowerCase()) || !/^\d+$/.test(parts[1])) {
    throw new Error('لینک باید به یک پیام کانال عمومی مانند t.me/channel/123 اشاره کند.');
  }
  const username = parts[0].replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('نام کانال عمومی معتبر نیست.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://t.me/${username}/${parts[1]}?embed=1&mode=tme`, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Filmwork-AdminParser/1.0' },
    });
    if (!response.ok) throw new Error(`تلگرام پاسخ HTTP ${response.status} داد.`);
    const html = await response.text();
    const match = html.match(/<div[^>]+class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!match) throw new Error('متن عمومی این پیام قابل دریافت نیست.');
    return decodeHtmlEntities(
      match[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ''),
    ).trim();
  } finally {
    clearTimeout(timer);
  }
}

function slugify(title, suffix) {
  const base = String(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 220) || 'content';
  return `${base}-${suffix.slice(0, 8)}`;
}

function jsonValue(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function storageTargets() {
  const values = [
    ['primary', process.env.TELEGRAM_PRIMARY_CHAT_ID || process.env.ADMIN_SOURCE_CHAT_ID, process.env.TELEGRAM_PRIMARY_USERNAME],
    ['fallback1', process.env.TELEGRAM_FALLBACK_1_CHAT_ID, process.env.TELEGRAM_FALLBACK_1_USERNAME],
    ['fallback2', process.env.TELEGRAM_FALLBACK_2_CHAT_ID, process.env.TELEGRAM_FALLBACK_2_USERNAME],
  ];
  for (const [name, chatId] of values) {
    if (!chatId || !/^-?\d+$/.test(String(chatId))) {
      throw new Error(`Telegram storage target ${name} is not configured with a numeric chat id`);
    }
  }
  return values.map(([name, chatId, username]) => ({
    name,
    chatId: String(chatId),
    username: String(username || ''),
  }));
}

function authorized(ctx) {
  const owners = ownerIds();
  const fromOwner = ctx.from?.id && owners.has(String(ctx.from.id));
  const sourceChat = String(process.env.ADMIN_SOURCE_CHAT_ID || '');
  const trustedChannel = sourceChat && String(ctx.chat?.id || '') === sourceChat;
  return Boolean(fromOwner || trustedChannel);
}

async function safeReply(ctx, message) {
  try {
    await ctx.reply(message, { link_preview_options: { is_disabled: true } });
  } catch (error) {
    console.warn('Admin bot could not post a status reply:', telegramErrorDescription(error));
  }
}

class AdminBotService {
  constructor() {
    this.bot = null;
    this.started = false;
    this.sweeper = null;
    this.finalizeTimers = new Map();
  }

  async start() {
    const token = process.env.ADMIN_BOT_TOKEN;
    if (!token) {
      console.warn('ADMIN_BOT_TOKEN is not configured; private admin bot is disabled.');
      return false;
    }
    if (ownerIds().size === 0) throw new Error('ADMIN_OWNER_IDS must contain at least one Telegram user id');
    storageTargets();

    this.bot = new Telegraf(token);
    this.registerHandlers();
    await this.bot.launch({
      dropPendingUpdates: false,
      allowedUpdates: ['message', 'channel_post'],
    });
    this.started = true;
    this.sweeper = setInterval(() => this.finalizeDueBundles().catch((error) => {
      console.error('Bundle sweeper failed', error);
    }), 5000);
    this.sweeper.unref?.();
    await this.finalizeDueBundles();
    console.log('Private admin bot started.');
    return true;
  }

  registerHandlers() {
    this.bot.command('start', async (ctx) => {
      if (!authorized(ctx) || !ctx.from || !ownerIds().has(String(ctx.from.id))) return;
      await safeReply(ctx, 'ربات خصوصی مدیریت Filmwork فعال است. برای ورود امن /panel را ارسال کنید.');
    });

    this.bot.command('panel', async (ctx) => {
      if (!ctx.from || !ownerIds().has(String(ctx.from.id))) return;
      const appUrl = String(process.env.APP_URL || '').replace(/\/$/, '');
      if (!/^https:\/\//i.test(appUrl) && process.env.NODE_ENV === 'production') {
        await safeReply(ctx, 'APP_URL باید یک نشانی HTTPS معتبر باشد.');
        return;
      }
      const rawToken = generateOpaqueToken(32);
      const tokenHash = hmacHex(rawToken);
      await query(
        `INSERT INTO admin_login_tokens (owner_tg_user_id, token_hash, expires_at)
         VALUES (:ownerId, :tokenHash, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))`,
        { ownerId: ctx.from.id, tokenHash },
      );
      const link = `${appUrl}/api/admin/exchange?token=${encodeURIComponent(rawToken)}`;
      await ctx.reply('این پیوند یک‌بارمصرف است و پنج دقیقه اعتبار دارد:', {
        reply_markup: { inline_keyboard: [[{ text: 'ورود به پنل مالک', url: link }]] },
        link_preview_options: { is_disabled: true },
      });
    });

    const updateHandler = async (ctx) => {
      if (!authorized(ctx)) return;
      const message = ctx.message || ctx.channelPost;
      if (!message) return;
      const text = message.text || message.caption || '';

      const directives = parseDirectives(text);
      if (directives) {
        await this.handleDirectives(ctx, directives);
        return;
      }

      if (mediaFromMessage(message)) {
        await this.handleMedia(ctx, message);
        return;
      }

      const commandBody = text.replace(/^\/parse(?:@\w+)?\s*/iu, '').trim();
      const candidate = commandBody || message.reply_to_message?.text || message.reply_to_message?.caption || text;
      let parsed = parsePublicPost(candidate);
      if (!parsed) {
        const publicLink = candidate.match(/https?:\/\/(?:t\.me|telegram\.me)\/[A-Za-z0-9_]+\/\d+/i)?.[0];
        if (publicLink) parsed = parsePublicPost(await fetchPublicTelegramPost(publicLink));
      }
      if (parsed) await this.insertParsedContent(ctx, parsed, message);
    };

    this.bot.on('message', (ctx) => updateHandler(ctx).catch((error) => this.reportError(ctx, error)));
    this.bot.on('channel_post', (ctx) => updateHandler(ctx).catch((error) => this.reportError(ctx, error)));
    this.bot.catch((error, ctx) => this.reportError(ctx, error));
  }

  async reportError(ctx, error) {
    console.error('Admin bot update failed:', error);
    if (ctx) await safeReply(ctx, `خطا در پردازش: ${telegramErrorDescription(error).slice(0, 350)}`);
  }

  async insertParsedContent(ctx, parsed, message) {
    const assetUuid = crypto.randomUUID();
    await query(
      `INSERT INTO contents
        (asset_uuid, content_type, title, slug, description, imdb_score, release_year, genres,
         source_chat_id, source_message_id, status)
       VALUES
        (:assetUuid, :contentType, :title, :slug, :description, :imdbScore, :releaseYear,
         :genres, :sourceChatId, :sourceMessageId, 'published')`,
      {
        assetUuid,
        contentType: parsed.contentType,
        title: parsed.title,
        slug: slugify(parsed.title, assetUuid),
        description: parsed.description,
        imdbScore: parsed.imdbScore,
        releaseYear: parsed.releaseYear,
        genres: JSON.stringify(parsed.genres),
        sourceChatId: message.chat?.id || ctx.chat?.id || null,
        sourceMessageId: message.message_id || null,
      },
    );
    await safeReply(
      ctx,
      `اثر ثبت شد ✅\n${parsed.title}\nشناسه اثر:\n${assetUuid}\n\nاکنون دستور #اثر را برای فایل بفرستید.`,
    );
  }

  async handleDirectives(ctx, directives) {
    if (directives.error) {
      await safeReply(ctx, directives.error);
      return;
    }
    const contentRows = await query(
      'SELECT id, title FROM contents WHERE asset_uuid = :assetUuid LIMIT 1',
      { assetUuid: directives.assetUuid },
    );
    if (!contentRows[0]) {
      await safeReply(ctx, 'اثری با این UUID پیدا نشد.');
      return;
    }
    const sourceChatId = String(ctx.chat.id);
    const ownerId = ctx.from?.id || [...ownerIds()][0];
    await withTransaction(async (connection) => {
      await connection.execute(
        `UPDATE bot_ingest_sessions SET status = 'expired'
         WHERE source_chat_id = :sourceChatId AND status IN ('waiting_media', 'processing')`,
        { sourceChatId },
      );
      await connection.execute(
        `INSERT INTO bot_ingest_sessions
          (owner_tg_user_id, source_chat_id, content_id, directives, expires_at)
         VALUES (:ownerId, :sourceChatId, :contentId, :directives,
                 DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE))`,
        {
          ownerId,
          sourceChatId,
          contentId: contentRows[0].id,
          directives: JSON.stringify(directives),
        },
      );
    });
    await safeReply(ctx, `دستور ${contentRows[0].title} ثبت شد؛ فایل رسانه را تا ۳۰ دقیقه آینده ارسال کنید.`);
  }

  async activeSession(chatId) {
    const rows = await query(
      `SELECT id, content_id, directives
       FROM bot_ingest_sessions
       WHERE source_chat_id = :chatId AND status = 'waiting_media' AND expires_at > UTC_TIMESTAMP(3)
       ORDER BY id DESC LIMIT 1`,
      { chatId: String(chatId) },
    );
    if (!rows[0]) return null;
    return { ...rows[0], directives: jsonValue(rows[0].directives) };
  }

  async replicateMessage(ctx, message) {
    const fromChatId = String(ctx.chat.id);
    const copies = await Promise.all(storageTargets().map(async (target) => {
      let messageId;
      if (fromChatId === target.chatId) {
        messageId = message.message_id;
      } else {
        const result = await ctx.telegram.copyMessage(target.chatId, fromChatId, message.message_id);
        messageId = result.message_id;
      }
      return {
        chatId: target.chatId,
        messageId,
        link: buildTelegramMessageLink(target.chatId, messageId, target.username),
      };
    }));
    return { primary: copies[0], fallback1: copies[1], fallback2: copies[2] };
  }

  async handleMedia(ctx, message) {
    const session = await this.activeSession(ctx.chat.id);
    if (!session) {
      await safeReply(ctx, 'دستور فعالی برای این فایل وجود ندارد؛ ابتدا پیام #اثر را ارسال کنید.');
      return;
    }

    const metadata = mediaFromMessage(message);
    if (!metadata || metadata.fileSize <= 0) {
      await safeReply(ctx, 'اندازه یا مشخصات فایل از تلگرام دریافت نشد؛ فایل را به‌صورت Video یا Document بفرستید.');
      return;
    }

    if (isSubtitleMessage(message)) {
      if (session.directives.subtitleType !== 'separate') {
        await safeReply(ctx, 'این دستور برای زیرنویس مجزا تنظیم نشده است.');
        return;
      }
      const pending = await query(
        `SELECT id FROM bot_media_bundles
         WHERE session_id = :sessionId AND status = 'waiting_subtitle'
         ORDER BY id DESC LIMIT 1`,
        { sessionId: session.id },
      );
      if (!pending[0]) {
        await safeReply(ctx, 'ابتدا فایل ویدیو را بفرستید؛ مهلت اتصال زیرنویس ده ثانیه است.');
        return;
      }
      const copies = await this.replicateMessage(ctx, message);
      const subtitlePayload = { metadata, copies };
      await query(
        'UPDATE bot_media_bundles SET subtitle_payload = :payload WHERE id = :id AND status = \'waiting_subtitle\'',
        { payload: JSON.stringify(subtitlePayload), id: pending[0].id },
      );
      await safeReply(ctx, 'زیرنویس دریافت شد و در همان کارت دانلود قرار می‌گیرد.');
      return;
    }

    const copies = await this.replicateMessage(ctx, message);
    const videoPayload = { metadata, copies };
    if (session.directives.subtitleType === 'separate') {
      const bundleKey = crypto.randomUUID();
      const result = await query(
        `INSERT INTO bot_media_bundles
          (session_id, bundle_key, video_payload, finalize_after)
         VALUES (:sessionId, :bundleKey, :videoPayload,
                 DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 SECOND))`,
        { sessionId: session.id, bundleKey, videoPayload: JSON.stringify(videoPayload) },
      );
      this.scheduleFinalize(result.insertId, 10_100);
      await safeReply(ctx, 'ویدیو ذخیره شد؛ ۱۰ ثانیه برای ارسال فایل SRT/VTT فرصت دارید.');
      return;
    }

    const ingestIdentity = metadata.uniqueFileId || `${ctx.chat.id}:${message.message_id}`;
    await this.insertMediaLink(
      session,
      videoPayload,
      null,
      `tg:${session.content_id}:${session.directives.seasonNumber || 0}:${session.directives.episodeNumber || 0}:${ingestIdentity}`.slice(0, 190),
    );
    await query('UPDATE bot_ingest_sessions SET status = \'complete\' WHERE id = :id', { id: session.id });
    await safeReply(ctx, 'فایل در هر سه کانال ذخیره و کارت دانلود ایجاد شد ✅');
  }

  scheduleFinalize(bundleId, delayMs) {
    if (this.finalizeTimers.has(bundleId)) clearTimeout(this.finalizeTimers.get(bundleId));
    const timer = setTimeout(() => {
      this.finalizeTimers.delete(bundleId);
      this.finalizeBundle(bundleId).catch((error) => console.error('Bundle finalization failed', error));
    }, delayMs);
    timer.unref?.();
    this.finalizeTimers.set(bundleId, timer);
  }

  async finalizeDueBundles() {
    const bundles = await query(
      `SELECT id FROM bot_media_bundles
       WHERE status = 'waiting_subtitle' AND finalize_after <= UTC_TIMESTAMP(3)
       ORDER BY id ASC LIMIT 50`,
    );
    for (const bundle of bundles) await this.finalizeBundle(bundle.id);
  }

  async finalizeBundle(bundleId) {
    let work;
    await withTransaction(async (connection) => {
      const [rows] = await connection.execute(
        `SELECT b.*, s.content_id, s.directives
         FROM bot_media_bundles b
         JOIN bot_ingest_sessions s ON s.id = b.session_id
         WHERE b.id = :id FOR UPDATE`,
        { id: bundleId },
      );
      if (!rows[0] || rows[0].status !== 'waiting_subtitle') return;
      await connection.execute(
        'UPDATE bot_media_bundles SET status = \'finalizing\' WHERE id = :id',
        { id: bundleId },
      );
      work = {
        bundle: rows[0],
        session: {
          id: rows[0].session_id,
          content_id: rows[0].content_id,
          directives: jsonValue(rows[0].directives),
        },
      };
    });
    if (!work) return;

    try {
      const videoPayload = jsonValue(work.bundle.video_payload);
      const subtitlePayload = jsonValue(work.bundle.subtitle_payload);
      await this.insertMediaLink(work.session, videoPayload, subtitlePayload, `bundle:${work.bundle.bundle_key}`);
      await withTransaction(async (connection) => {
        await connection.execute(
          'UPDATE bot_media_bundles SET status = \'complete\', last_error = NULL WHERE id = :id',
          { id: bundleId },
        );
        await connection.execute(
          'UPDATE bot_ingest_sessions SET status = \'complete\' WHERE id = :id',
          { id: work.session.id },
        );
      });
    } catch (error) {
      await query(
        `UPDATE bot_media_bundles SET status = 'failed', last_error = :error WHERE id = :id`,
        { id: bundleId, error: String(error.message || error).slice(0, 500) },
      );
      throw error;
    }
  }

  async insertMediaLink(session, videoPayload, subtitlePayload, ingestKey) {
    const d = session.directives;
    const v = videoPayload;
    const s = subtitlePayload;
    await query(
      `INSERT INTO media_links (
         public_id, content_id, season_number, episode_number, version_label,
         audio_type, subtitle_type, resolution, quality_label, encoder,
         file_size_bytes, mime_type,
         tg_link_primary, tg_link_fallback_1, tg_link_fallback_2,
         primary_chat_id, primary_message_id, fallback_1_chat_id, fallback_1_message_id,
         fallback_2_chat_id, fallback_2_message_id,
         subtitle_link_primary, subtitle_link_fallback_1, subtitle_link_fallback_2,
         subtitle_primary_message_id, subtitle_fallback_1_message_id, subtitle_fallback_2_message_id,
         subtitle_file_size_bytes, ingest_key
       ) VALUES (
         :publicId, :contentId, :season, :episode, :version,
         :audioType, :subtitleType, :resolution, :quality, :encoder,
         :fileSize, :mimeType,
         :primaryLink, :fallback1Link, :fallback2Link,
         :primaryChatId, :primaryMessageId, :fallback1ChatId, :fallback1MessageId,
         :fallback2ChatId, :fallback2MessageId,
         :subtitlePrimaryLink, :subtitleFallback1Link, :subtitleFallback2Link,
         :subtitlePrimaryMessageId, :subtitleFallback1MessageId, :subtitleFallback2MessageId,
         :subtitleFileSize, :ingestKey
       )`,
      {
        publicId: crypto.randomUUID(),
        contentId: session.content_id,
        season: d.seasonNumber,
        episode: d.episodeNumber,
        version: d.version,
        audioType: d.audioType,
        subtitleType: d.subtitleType,
        resolution: d.resolution,
        quality: d.quality,
        encoder: d.encoder,
        fileSize: v.metadata.fileSize,
        mimeType: v.metadata.mimeType,
        primaryLink: v.copies.primary.link,
        fallback1Link: v.copies.fallback1.link,
        fallback2Link: v.copies.fallback2.link,
        primaryChatId: v.copies.primary.chatId,
        primaryMessageId: v.copies.primary.messageId,
        fallback1ChatId: v.copies.fallback1.chatId,
        fallback1MessageId: v.copies.fallback1.messageId,
        fallback2ChatId: v.copies.fallback2.chatId,
        fallback2MessageId: v.copies.fallback2.messageId,
        subtitlePrimaryLink: s?.copies?.primary?.link || null,
        subtitleFallback1Link: s?.copies?.fallback1?.link || null,
        subtitleFallback2Link: s?.copies?.fallback2?.link || null,
        subtitlePrimaryMessageId: s?.copies?.primary?.messageId || null,
        subtitleFallback1MessageId: s?.copies?.fallback1?.messageId || null,
        subtitleFallback2MessageId: s?.copies?.fallback2?.messageId || null,
        subtitleFileSize: s?.metadata?.fileSize || null,
        ingestKey,
      },
    );
  }

  async stop(reason = 'shutdown') {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const timer of this.finalizeTimers.values()) clearTimeout(timer);
    this.finalizeTimers.clear();
    if (this.bot && this.started) {
      this.bot.stop(reason);
      this.started = false;
    }
  }
}

const adminBotService = new AdminBotService();

module.exports = {
  normalizeDigits,
  parsePublicPost,
  parseDirectives,
  fetchPublicTelegramPost,
  AdminBotService,
  adminBotService,
};
