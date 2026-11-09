'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');

// `DOTENV_CONFIG_PATH` lets a host (or a test) point at another env file.
dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '.env'),
  quiet: true,
});

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const { query, withTransaction, healthCheck, closePool } = require('./config/db');
const { AppError, assert, asyncRoute } = require('./lib/errors');
const {
  hmacHex,
  generateOpaqueToken,
  signUserToken,
  signAdminToken,
  hashIp,
  requireSecret,
  timingSafeHexEqual,
} = require('./lib/security');
const {
  asString,
  asEnum,
  asPositiveNumber,
  asDate,
  asHttpUrl,
  cleanPlainText,
  parsePage,
} = require('./lib/validation');
const {
  requireUser,
  optionalUser,
  requireRole,
  requireAdmin,
  requireAdminCsrf,
  ownerIds,
} = require('./middleware/auth');
const { deliverMedia } = require('./services/mediaDelivery');
const { changeCampaignStatus, settleExpiredCampaigns } = require('./services/adAccounting');
const { authBotService } = require('./bots/authBot');
const { adminBotService } = require('./bots/adminBot');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Numeric env values are frequently pasted with a trailing newline or a stray quote
 * from a control panel. `Number('3000 ')` is NaN, and `app.listen(NaN)` silently picks
 * a random port — the site then answers 503 because nothing listens where the host
 * expects. Parse defensively and fall back to the documented default.
 */
function numberFromEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(process.env[name] ?? '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.warn(`Ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

const port = numberFromEnv('PORT', 3000, { min: 1, max: 65535 });
const frontendDirectory = path.join(__dirname, '..', 'frontend');
const privateDirectory = path.join(__dirname, 'private');
const uploadDirectory = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o750 });

/**
 * Validates the runtime configuration at import time.
 *
 * This runs before the app is exported, so a bad value must not crash the process
 * inside a hosting runtime (Passenger answers 503) — the caller reports it instead.
 */
function validateRuntimeConfiguration() {
  requireSecret('JWT_SECRET');
  requireSecret('AUTH_CODE_PEPPER');
  requireSecret('PHONE_ENCRYPTION_KEY');
  const configuredAppUrl = String(process.env.APP_URL || '').trim();
  if (configuredAppUrl) {
    let parsedAppUrl;
    try {
      parsedAppUrl = new URL(configuredAppUrl);
    } catch {
      throw new Error('APP_URL must be an absolute URL, for example https://stream.example.com');
    }
    if (!['http:', 'https:'].includes(parsedAppUrl.protocol)) {
      throw new Error('APP_URL must use http or https');
    }
    if (isProduction && parsedAppUrl.protocol !== 'https:') {
      throw new Error('APP_URL must use HTTPS in production');
    }
  }
  if (isProduction) {
    for (const name of [
      'APP_URL',
      'AUTH_BOT_TOKEN',
      'AUTH_BOT_USERNAME',
      'ADMIN_BOT_TOKEN',
      'ADMIN_OWNER_IDS',
      'TELEGRAM_PRIMARY_CHAT_ID',
      'TELEGRAM_FALLBACK_1_CHAT_ID',
      'TELEGRAM_FALLBACK_2_CHAT_ID',
    ]) {
      if (!process.env[name]) throw new Error(`${name} is required in production`);
    }
    for (const name of [
      'ADMIN_SOURCE_CHAT_ID',
      'TELEGRAM_PRIMARY_CHAT_ID',
      'TELEGRAM_FALLBACK_1_CHAT_ID',
      'TELEGRAM_FALLBACK_2_CHAT_ID',
    ]) {
      const value = String(process.env[name] || '');
      if (value && !/^-?\d+$/.test(value)) {
        throw new Error(`${name} must be a numeric Telegram chat id (for example -1001234567890)`);
      }
    }
    if (!/^[\d,\s]+$/.test(String(process.env.ADMIN_OWNER_IDS))) {
      throw new Error('ADMIN_OWNER_IDS must be a comma-separated list of numeric Telegram user ids');
    }
  }
}

validateRuntimeConfiguration();

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === undefined
  ? (isProduction ? 1 : 0)
  : numberFromEnv('TRUST_PROXY', isProduction ? 1 : 0, { min: 0, max: 10 }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:', ...(isProduction ? [] : ['http:'])],
      mediaSrc: ["'self'", 'blob:', 'https:', ...(isProduction ? [] : ['http:'])],
      connectSrc: ["'self'", 'https:', ...(isProduction ? [] : ['http:'])],
      upgradeInsecureRequests: isProduction ? [] : null,
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

const allowedOrigins = new Set(
  String(process.env.CORS_ORIGINS || process.env.APP_URL || '')
    .split(',')
    .map((origin) => origin.trim().replace(/^["']|["']$/g, '').replace(/\/$/, ''))
    .filter(Boolean),
);
for (const origin of allowedOrigins) {
  // A path or a trailing slash turns into an origin that never matches, and every
  // cross-origin call then fails with 403 ORIGIN_REJECTED.
  try {
    const parsed = new URL(origin);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      console.warn(`CORS_ORIGINS entry ${JSON.stringify(origin)} contains a path; use only the origin (scheme + host).`);
    }
    if (parsed.origin !== origin) {
      console.warn(`CORS_ORIGINS entry ${JSON.stringify(origin)} should be written as ${JSON.stringify(parsed.origin)}.`);
    }
  } catch {
    console.warn(`CORS_ORIGINS entry ${JSON.stringify(origin)} is not a valid origin.`);
  }
}
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, '')) || (!isProduction && /^https?:\/\/localhost(?::\d+)?$/.test(origin))) {
      return callback(null, true);
    }
    return callback(new AppError(403, 'ORIGIN_REJECTED', 'مبدأ درخواست مجاز نیست.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Ad-Session'],
  maxAge: 86400,
}));
app.use(cookieParser());
app.use(bodyParser.json({ limit: '300kb', strict: true }));
app.use(bodyParser.urlencoded({ extended: false, limit: '100kb' }));

const standardLimiter = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'درخواست‌ها بیش از حد مجاز است.' } },
});
const authLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: { code: 'AUTH_RATE_LIMITED', message: 'تلاش‌های ورود بیش از حد مجاز است.' } },
});
const downloadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'DOWNLOAD_RATE_LIMITED', message: 'کمی صبر کنید و دوباره تلاش کنید.' } },
});
app.use('/api', standardLimiter);
app.use('/api/auth/verify', authLimiter);
app.use('/api/admin/exchange', authLimiter);
app.use('/api/download', downloadLimiter);

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function contentDto(row) {
  return {
    id: row.asset_uuid,
    type: row.content_type,
    title: row.title,
    originalTitle: row.original_title,
    slug: row.slug,
    description: row.description,
    imdbScore: row.imdb_score === null ? null : Number(row.imdb_score),
    releaseYear: row.release_year,
    genres: parseJsonColumn(row.genres, []),
    language: row.language,
    country: row.country,
    ageRating: row.age_rating,
    runtimeMinutes: row.runtime_minutes,
    posterUrl: row.poster_url,
    backdropUrl: row.backdrop_url,
    trailerUrl: row.trailer_url,
    streamUrl: row.stream_url,
    mediaCount: row.media_count === undefined ? undefined : Number(row.media_count),
    createdAt: row.created_at,
  };
}

function mediaDto(row) {
  const audioLabels = {
    dubbed: 'دوبله', hard_sub: 'زیرنویس چسبیده', soft_sub: 'سافت‌ساب', original: 'زبان اصلی',
  };
  return {
    id: row.public_id,
    season: row.season_number,
    episode: row.episode_number,
    episodeTitle: row.episode_title,
    version: row.version_label,
    audioType: row.audio_type,
    audioLabel: audioLabels[row.audio_type] || row.audio_type,
    subtitleType: row.subtitle_type,
    resolution: row.resolution,
    quality: row.quality_label,
    encoder: row.encoder,
    fileSizeBytes: Number(row.file_size_bytes),
    subtitleFileSizeBytes: row.subtitle_file_size_bytes ? Number(row.subtitle_file_size_bytes) : null,
    streamUrl: row.stream_url,
  };
}

function escapeLike(value) {
  return String(value).replace(/[!%_]/g, '!$&');
}

function contentSlug(title, uuid) {
  const base = String(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 220) || 'content';
  return `${base}-${uuid.slice(0, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safePublicUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function createAdSession(adPublicId) {
  const payload = Buffer.from(JSON.stringify({
    ad: adPublicId,
    exp: Date.now() + 2 * 60 * 60_000,
    nonce: generateOpaqueToken(12),
  })).toString('base64url');
  return `${payload}.${hmacHex(payload)}`;
}

function verifyAdSession(session, expectedAdId) {
  const [payload, signature, ...extra] = String(session || '').split('.');
  assert(payload && signature && extra.length === 0, 422, 'INVALID_AD_SESSION', 'شناسه نمایش نامعتبر است.');
  const expectedSignature = hmacHex(payload);
  assert(timingSafeHexEqual(signature, expectedSignature), 422, 'INVALID_AD_SESSION', 'شناسه نمایش نامعتبر است.');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(422, 'INVALID_AD_SESSION', 'شناسه نمایش نامعتبر است.');
  }
  assert(claims.ad === expectedAdId && Number(claims.exp) > Date.now(), 422, 'EXPIRED_AD_SESSION', 'شناسه نمایش منقضی شده است.');
  return claims;
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  let database;
  try {
    database = { ...(await healthCheck()) };
  } catch (error) {
    // A monitoring probe needs a machine-readable answer, not an HTML error page.
    database = { ok: false, error: String(error.code || error.message || 'database_unreachable') };
  }
  const bots = {
    authentication: authBotService.started,
    administration: adminBotService.started,
    status: { ...botStatus },
  };
  const healthy = database.ok === true;
  res.status(healthy ? 200 : 503);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: healthy ? 'ok' : 'degraded',
    database,
    bots,
    timestamp: new Date().toISOString(),
  });
}));

app.get('/api/config', asyncRoute(async (_req, res) => {
  const prices = await query(
    `SELECT placement, display_name_fa, price_per_thousand, minimum_budget, currency
     FROM ad_placement_prices WHERE is_active = TRUE ORDER BY FIELD(placement, 'pre_roll', 'timed_banner', 'pause_overlay')`,
  );
  const username = String(process.env.AUTH_BOT_USERNAME || '').replace(/^@/, '');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    authBotUrl: username ? `https://t.me/${encodeURIComponent(username)}` : null,
    placementPrices: prices.map((price) => ({
      placement: price.placement,
      label: price.display_name_fa,
      cpm: Number(price.price_per_thousand),
      minimumBudget: Number(price.minimum_budget),
      currency: price.currency,
    })),
  });
}));

app.post('/api/auth/verify', asyncRoute(async (req, res) => {
  const code = asString(req.body?.code, 'کد ورود', { min: 6, max: 6 });
  assert(/^\d{6}$/.test(code), 422, 'INVALID_CODE_FORMAT', 'کد ورود باید شش رقم باشد.');
  const codeHash = hmacHex(code);

  const user = await withTransaction(async (connection) => {
    const [codes] = await connection.execute(
      `SELECT lc.id AS code_id, lc.user_id, lc.failed_attempts,
              u.id, u.tg_user_id, u.tg_chat_id, u.account_name, u.tg_username, u.role, u.status, u.created_at
       FROM login_codes lc
       JOIN users u ON u.id = lc.user_id
       WHERE lc.code_hash = :codeHash
         AND lc.consumed_at IS NULL
         AND lc.expires_at > UTC_TIMESTAMP(3)
       ORDER BY lc.id DESC
       LIMIT 1 FOR UPDATE`,
      { codeHash },
    );
    const row = codes[0];
    if (!row || row.failed_attempts >= 5 || row.status !== 'active') {
      throw new AppError(401, 'INVALID_LOGIN_CODE', 'کد ورود نادرست یا منقضی شده است.');
    }
    await connection.execute(
      `UPDATE login_codes
       SET consumed_at = UTC_TIMESTAMP(3), request_ip = INET6_ATON(:ip)
       WHERE id = :id`,
      { id: row.code_id, ip: req.ip },
    );
    await connection.execute(
      'UPDATE users SET last_login_at = UTC_TIMESTAMP(3) WHERE id = :id',
      { id: row.id },
    );
    return row;
  }, { isolationLevel: 'READ COMMITTED' });

  const token = signUserToken(user);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    token,
    user: {
      id: String(user.id),
      accountName: user.account_name,
      role: user.role,
      createdAt: user.created_at,
    },
  });
}));

app.get('/api/me', requireUser, asyncRoute(async (req, res) => {
  let wallet = null;
  if (req.user.role === 'advertiser') {
    const rows = await query(
      'SELECT balance, currency FROM advertiser_wallets WHERE user_id = :id LIMIT 1',
      { id: req.user.id },
    );
    wallet = rows[0] ? { balance: Number(rows[0].balance), currency: rows[0].currency } : { balance: 0, currency: 'IRR' };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    user: {
      id: String(req.user.id),
      accountName: req.user.account_name,
      role: req.user.role,
      createdAt: req.user.created_at,
      wallet,
    },
  });
}));

app.get('/api/me/stats', requireUser, asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT
       (SELECT COUNT(*) FROM favorites f WHERE f.user_id = :userId) AS favorites_count,
       (SELECT COUNT(*) FROM comments cm WHERE cm.user_id = :userId AND cm.status = 'visible') AS comments_count,
       (SELECT COUNT(*) FROM download_history dh WHERE dh.user_id = :userId) AS downloads_count,
       (SELECT COALESCE(SUM(pp.position_seconds), 0) FROM playback_progress pp WHERE pp.user_id = :userId) AS watched_seconds,
       (SELECT COUNT(*) FROM playback_progress pp WHERE pp.user_id = :userId AND pp.completed = TRUE) AS completed_count`,
    { userId: req.user.id },
  );
  const row = rows[0];
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    favorites: Number(row.favorites_count),
    comments: Number(row.comments_count),
    downloads: Number(row.downloads_count),
    watchedSeconds: Number(row.watched_seconds),
    completed: Number(row.completed_count),
  });
}));

app.get('/api/progress', requireUser, asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT pp.position_seconds, pp.duration_seconds, pp.completed, pp.last_watched_at, c.*
     FROM playback_progress pp
     JOIN contents c ON c.id = pp.content_id
     WHERE pp.user_id = :userId AND c.status = 'published'
     ORDER BY pp.last_watched_at DESC LIMIT 30`,
    { userId: req.user.id },
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    items: rows.map((row) => ({
      content: contentDto(row),
      positionSeconds: Number(row.position_seconds),
      durationSeconds: Number(row.duration_seconds),
      completed: Boolean(row.completed),
      lastWatchedAt: row.last_watched_at,
    })),
  });
}));

app.post('/api/contents/:assetId/progress', requireUser, asyncRoute(async (req, res) => {
  const position = Math.floor(asPositiveNumber(req.body?.positionSeconds ?? 0, 'موقعیت پخش', { min: 0, max: 10_000_000 }));
  const duration = Math.floor(asPositiveNumber(req.body?.durationSeconds, 'مدت پخش', { min: 1, max: 10_000_000 }));
  assert(position <= duration + 5, 422, 'INVALID_PROGRESS', 'موقعیت پخش از مدت فایل بیشتر است.');
  const contents = await query(
    "SELECT id FROM contents WHERE asset_uuid = :assetId AND status = 'published' LIMIT 1",
    { assetId: req.params.assetId },
  );
  assert(contents[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
  const boundedPosition = duration > 0 ? Math.min(position, duration) : position;
  const completed = duration > 0 && boundedPosition / duration >= 0.92;
  await query(
    `INSERT INTO playback_progress
      (user_id, content_id, position_seconds, duration_seconds, completed)
     VALUES (:userId, :contentId, :position, :duration, :completed)
     ON DUPLICATE KEY UPDATE
       position_seconds = VALUES(position_seconds),
       duration_seconds = VALUES(duration_seconds),
       completed = VALUES(completed),
       last_watched_at = CURRENT_TIMESTAMP(3)`,
    {
      userId: req.user.id,
      contentId: contents[0].id,
      position: boundedPosition,
      duration,
      completed,
    },
  );
  res.status(202).json({ saved: true, completed });
}));

app.get('/api/downloads', requireUser, asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT dh.id AS download_id, dh.delivery_method, dh.created_at AS downloaded_at,
            ml.public_id AS media_public_id, ml.resolution, ml.version_label, ml.file_size_bytes,
            ml.audio_type, ml.season_number, ml.episode_number, c.*
     FROM download_history dh
     JOIN media_links ml ON ml.id = dh.media_link_id
     JOIN contents c ON c.id = ml.content_id
     WHERE dh.user_id = :userId AND c.status = 'published'
     ORDER BY dh.created_at DESC LIMIT 100`,
    { userId: req.user.id },
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    items: rows.map((row) => ({
      id: String(row.download_id),
      content: contentDto(row),
      media: {
        id: row.media_public_id,
        resolution: row.resolution,
        version: row.version_label,
        fileSizeBytes: Number(row.file_size_bytes),
        audioType: row.audio_type,
        season: row.season_number,
        episode: row.episode_number,
      },
      deliveryMethod: row.delivery_method,
      downloadedAt: row.downloaded_at,
    })),
  });
}));

app.get('/api/contents', asyncRoute(async (req, res) => {
  const { page, limit, offset } = parsePage(req.query);
  const filters = ["c.status = 'published'"];
  const params = { limit, offset };
  if (req.query.type && ['movie', 'series'].includes(req.query.type)) {
    filters.push('c.content_type = :type');
    params.type = req.query.type;
  }
  if (req.query.q) {
    const search = asString(req.query.q, 'جستجو', { min: 1, max: 100 });
    filters.push("(c.title LIKE :search ESCAPE '!' OR c.original_title LIKE :search ESCAPE '!')");
    params.search = `%${escapeLike(search)}%`;
  }
  if (req.query.genre) {
    const genre = asString(req.query.genre, 'ژانر', { min: 1, max: 60 });
    filters.push('JSON_CONTAINS(c.genres, JSON_QUOTE(:genre))');
    params.genre = genre;
  }
  if (req.query.yearFrom) {
    params.yearFrom = Math.round(asPositiveNumber(req.query.yearFrom, 'سال شروع', { min: 1888, max: 2200 }));
    filters.push('c.release_year >= :yearFrom');
  }
  if (req.query.yearTo) {
    params.yearTo = Math.round(asPositiveNumber(req.query.yearTo, 'سال پایان', { min: 1888, max: 2200 }));
    filters.push('c.release_year <= :yearTo');
  }
  if (req.query.minRating) {
    params.minRating = asPositiveNumber(req.query.minRating, 'حداقل امتیاز', { min: 0, max: 10 });
    filters.push('c.imdb_score >= :minRating');
  }
  const where = filters.join(' AND ');
  const order = req.query.sort === 'rating'
    ? 'c.imdb_score DESC, c.created_at DESC'
    : req.query.sort === 'year'
      ? 'c.release_year DESC, c.created_at DESC'
      : 'c.created_at DESC';

  const [rows, counts] = await Promise.all([
    query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM media_links ml WHERE ml.content_id = c.id AND ml.is_active = TRUE) AS media_count
       FROM contents c WHERE ${where}
       ORDER BY ${order} LIMIT :limit OFFSET :offset`,
      params,
    ),
    query(`SELECT COUNT(*) AS total FROM contents c WHERE ${where}`, params),
  ]);
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({
    items: rows.map(contentDto),
    pagination: { page, limit, total: Number(counts[0].total), pages: Math.ceil(Number(counts[0].total) / limit) },
  });
}));

app.get('/api/contents/:assetId', asyncRoute(async (req, res) => {
  const assetId = asString(req.params.assetId, 'شناسه اثر', { min: 36, max: 36 });
  const rows = await query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM media_links ml WHERE ml.content_id = c.id AND ml.is_active = TRUE) AS media_count
     FROM contents c WHERE c.asset_uuid = :assetId AND c.status = 'published' LIMIT 1`,
    { assetId },
  );
  assert(rows[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({ content: contentDto(rows[0]) });
}));

app.get('/api/contents/:assetId/media-options', asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT ml.*
     FROM media_links ml
     JOIN contents c ON c.id = ml.content_id
     WHERE c.asset_uuid = :assetId AND c.status = 'published' AND ml.is_active = TRUE
     ORDER BY COALESCE(ml.season_number, 0), COALESCE(ml.episode_number, 0),
              FIELD(ml.audio_type, 'dubbed', 'hard_sub', 'soft_sub', 'original'),
              CAST(REGEXP_REPLACE(ml.resolution, '[^0-9]', '') AS UNSIGNED) DESC,
              ml.file_size_bytes ASC`,
    { assetId: req.params.assetId },
  );
  res.setHeader('Cache-Control', 'public, max-age=20');
  res.json({ items: rows.map(mediaDto) });
}));

app.get('/api/contents/:assetId/comments', asyncRoute(async (req, res) => {
  const { page, limit, offset } = parsePage({ ...req.query, limit: req.query.limit || 20 });
  const rows = await query(
    `SELECT cm.id, cm.body, cm.created_at, u.account_name
     FROM comments cm
     JOIN users u ON u.id = cm.user_id
     JOIN contents c ON c.id = cm.content_id
     WHERE c.asset_uuid = :assetId AND cm.status = 'visible'
     ORDER BY cm.created_at DESC LIMIT :limit OFFSET :offset`,
    { assetId: req.params.assetId, limit, offset },
  );
  // Deliberately expose only account_name; Telegram id, username and phone never leave the API.
  res.json({
    items: rows.map((row) => ({
      id: String(row.id),
      body: row.body,
      accountName: row.account_name,
      createdAt: row.created_at,
    })),
    pagination: { page, limit },
  });
}));

app.post('/api/contents/:assetId/comments', requireUser, asyncRoute(async (req, res) => {
  const body = cleanPlainText(req.body?.body, 1200);
  const contents = await query(
    "SELECT id FROM contents WHERE asset_uuid = :assetId AND status = 'published' LIMIT 1",
    { assetId: req.params.assetId },
  );
  assert(contents[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
  const result = await query(
    'INSERT INTO comments (content_id, user_id, body) VALUES (:contentId, :userId, :body)',
    { contentId: contents[0].id, userId: req.user.id, body },
  );
  res.status(201).json({
    comment: {
      id: String(result.insertId),
      body,
      accountName: req.user.account_name,
      createdAt: new Date().toISOString(),
    },
  });
}));

app.get('/api/favorites', requireUser, asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT c.* FROM favorites f JOIN contents c ON c.id = f.content_id
     WHERE f.user_id = :userId AND c.status = 'published' ORDER BY f.created_at DESC`,
    { userId: req.user.id },
  );
  res.json({ items: rows.map(contentDto) });
}));

app.post('/api/contents/:assetId/favorite', requireUser, asyncRoute(async (req, res) => {
  const rows = await query(
    "SELECT id FROM contents WHERE asset_uuid = :assetId AND status = 'published' LIMIT 1",
    { assetId: req.params.assetId },
  );
  assert(rows[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
  await query(
    'INSERT IGNORE INTO favorites (user_id, content_id) VALUES (:userId, :contentId)',
    { userId: req.user.id, contentId: rows[0].id },
  );
  res.status(201).json({ favorited: true });
}));

app.delete('/api/contents/:assetId/favorite', requireUser, asyncRoute(async (req, res) => {
  await query(
    `DELETE f FROM favorites f JOIN contents c ON c.id = f.content_id
     WHERE f.user_id = :userId AND c.asset_uuid = :assetId`,
    { userId: req.user.id, assetId: req.params.assetId },
  );
  res.json({ favorited: false });
}));

app.post('/api/download', requireUser, asyncRoute(async (req, res) => {
  const mediaId = asString(req.body?.mediaId, 'شناسه فایل', { min: 36, max: 36 });
  const mediaRows = await query(
    `SELECT ml.id FROM media_links ml
     JOIN contents c ON c.id = ml.content_id
     WHERE ml.public_id = :mediaId AND ml.is_active = TRUE AND c.status = 'published' LIMIT 1`,
    { mediaId },
  );
  assert(mediaRows[0], 404, 'MEDIA_NOT_FOUND', 'فایل پیدا نشد.');
  const result = await deliverMedia(mediaId, req.user);
  await query(
    `INSERT INTO download_history (user_id, media_link_id, delivery_method)
     VALUES (:userId, :mediaLinkId, :deliveryMethod)`,
    {
      userId: req.user.id,
      mediaLinkId: mediaRows[0].id,
      deliveryMethod: result.deliveryMethod,
    },
  ).catch((error) => console.error('Download was delivered but history logging failed', error));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...result,
    message: 'فایل به گفت‌وگوی شما با ربات Filmwork ارسال شد.',
  });
}));

app.get('/api/ads/serve', optionalUser, asyncRoute(async (req, res) => {
  const placement = asEnum(req.query.placement, 'جایگاه', ['pre_roll', 'timed_banner', 'pause_overlay']);
  const rows = await query(
    `SELECT public_id, headline, body, placement, asset_type, creative_url,
            skip_after_seconds, budget, spent
     FROM ads
     WHERE placement = :placement AND status = 'active'
       AND starts_at <= UTC_TIMESTAMP(3) AND ends_at > UTC_TIMESTAMP(3)
       AND spent < budget
     ORDER BY id DESC LIMIT 100`,
    { placement },
  );
  if (!rows.length) return res.json({ ad: null });
  const row = rows[crypto.randomInt(0, rows.length)];
  const adSession = createAdSession(row.public_id);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ad: {
      id: row.public_id,
      headline: row.headline,
      body: row.body,
      placement: row.placement,
      assetType: row.asset_type,
      creativeUrl: row.creative_url,
      tunnelUrl: `/api/ad-tunnel/${encodeURIComponent(row.public_id)}`,
      skipAfterSeconds: row.skip_after_seconds,
      session: adSession,
    },
  });
}));

app.post('/api/ads/:adId/events', optionalUser, asyncRoute(async (req, res) => {
  const eventType = asEnum(req.body?.eventType, 'رویداد', ['impression', 'click', 'skip', 'complete']);
  const session = asString(req.get('x-ad-session') || req.body?.session, 'شناسه نمایش', { min: 40, max: 400 });
  verifyAdSession(session, req.params.adId);
  const sessionKey = hmacHex(`${req.params.adId}:${session}`);
  const accepted = await withTransaction(async (connection) => {
    const [ads] = await connection.execute(
      'SELECT id, unit_price, budget, spent, status FROM ads WHERE public_id = :adId FOR UPDATE',
      { adId: req.params.adId },
    );
    assert(ads[0], 404, 'AD_NOT_FOUND', 'تبلیغ پیدا نشد.');
    const [eventResult] = await connection.execute(
      `INSERT IGNORE INTO ad_events (ad_id, user_id, event_type, session_key, ip_hash, user_agent)
       VALUES (:adId, :userId, :eventType, :sessionKey, :ipHash, :userAgent)`,
      {
        adId: ads[0].id,
        userId: req.user?.id || null,
        eventType,
        sessionKey,
        ipHash: hashIp(req.ip),
        userAgent: String(req.get('user-agent') || '').slice(0, 500) || null,
      },
    );
    if (eventResult.affectedRows === 1 && eventType === 'impression' && ads[0].status === 'active') {
      await connection.execute(
        `UPDATE ads SET
           status = IF(spent + (unit_price / 1000) >= budget, 'completed', status),
           spent = LEAST(budget, spent + (unit_price / 1000))
         WHERE id = :id`,
        { id: ads[0].id },
      );
    }
    return eventResult.affectedRows === 1;
  }, { isolationLevel: 'READ COMMITTED' });
  res.status(202).json({ accepted });
}));

app.get('/api/ad-tunnel/:adId', asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT public_id, headline, body, asset_type, creative_url, target_url,
            telegram_post_text, telegram_buttons
     FROM ads
     WHERE public_id = :adId AND status IN ('active', 'completed') LIMIT 1`,
    { adId: req.params.adId },
  );
  assert(rows[0], 404, 'AD_NOT_FOUND', 'صفحه تبلیغ پیدا نشد.');
  const ad = rows[0];
  const creative = safePublicUrl(ad.creative_url);
  const target = safePublicUrl(ad.target_url);
  const rawButtons = parseJsonColumn(ad.telegram_buttons, []);
  const buttons = Array.isArray(rawButtons)
    ? rawButtons.filter((button) => button && safePublicUrl(button.url)).slice(0, 12)
    : [];
  const media = ad.asset_type === 'video'
    ? `<video controls playsinline preload="metadata" src="${escapeHtml(creative)}"></video>`
    : `<img src="${escapeHtml(creative)}" alt="${escapeHtml(ad.headline)}">`;
  const buttonHtml = buttons.map((button) => (
    `<a class="button secondary" href="${escapeHtml(safePublicUrl(button.url))}" rel="noopener noreferrer">${escapeHtml(button.text || 'مشاهده')}</a>`
  )).join('');
  const targetButton = target
    ? `<a class="button primary" href="${escapeHtml(target)}" rel="noopener noreferrer">مشاهده پیشنهاد</a>`
    : '';
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.type('html').send(`<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(ad.headline)} | Filmwork</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;800&display=swap');
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#000;color:#fff;font-family:Vazirmatn,sans-serif;display:grid;place-items:center;padding:24px}.card{width:min(640px,100%);background:#121214;border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:16px;box-shadow:0 28px 80px rgba(0,0,0,.8)}img,video{width:100%;max-height:60vh;object-fit:cover;border-radius:17px;background:#09090b}.eyebrow{color:#c084fc;font-size:12px;font-weight:800;letter-spacing:.06em;margin:12px 2px 0}.copy{white-space:pre-wrap;color:#d4d4d8;line-height:1.9}.actions{display:grid;gap:10px;margin-top:18px}.button{text-align:center;text-decoration:none;color:#fff;padding:13px 18px;border-radius:999px;font-weight:800;border:1px solid rgba(255,255,255,.12)}.primary{background:linear-gradient(135deg,#e50914,#ff2e63,#9333ea)}.secondary{background:rgba(255,255,255,.07)}small{display:block;text-align:center;color:#71717a;margin-top:16px}</style></head><body><main class="card">${media}<p class="eyebrow">صفحه امن تبلیغ</p><h1>${escapeHtml(ad.headline)}</h1><div class="copy">${escapeHtml(ad.telegram_post_text || ad.body || '')}</div><div class="actions">${targetButton}${buttonHtml}</div><small>این صفحه بدون نیاز به باز کردن پست تلگرام نمایش داده می‌شود.</small></main></body></html>`);
}));

const allowedUploadMimes = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
  ['video/mp4', '.mp4'], ['video/webm', '.webm'],
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDirectory),
    filename: (_req, file, callback) => {
      const extension = allowedUploadMimes.get(file.mimetype) || '';
      callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: Math.max(1, Math.min(100, Number(process.env.MAX_UPLOAD_MB || 25))) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!allowedUploadMimes.has(file.mimetype)) return callback(new AppError(422, 'INVALID_CREATIVE_TYPE', 'فرمت فایل تبلیغ پشتیبانی نمی‌شود.'));
    callback(null, true);
  },
});

// `fallthrough: false` used to let a missing creative fall through to the JSON error
// handler, which replied 500 for a plain 404 file GET (and confused uptime checks).
const creativeFiles = express.static(uploadDirectory, {
  dotfiles: 'deny',
  immutable: true,
  maxAge: '30d',
  setHeaders(response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
  },
});
app.use('/uploads', (req, res, next) => {
  creativeFiles(req, res, (error) => {
    if (error) return next(error);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next(new AppError(404, 'NOT_FOUND', 'مسیر پیدا نشد.'));
    }
    return res.status(404).type('text/plain; charset=utf-8').send('پیدا نشد');
  });
});

app.get('/api/advertiser/profile', requireUser, requireRole('advertiser'), asyncRoute(async (req, res) => {
  await settleExpiredCampaigns(req.user.id);
  const [walletRows, campaignRows, transactionRows] = await Promise.all([
    query('SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId LIMIT 1', { userId: req.user.id }),
    query(
      `SELECT a.public_id, a.campaign_name, a.headline, a.placement, a.asset_type,
              a.creative_url, a.budget, a.spent, a.status, a.starts_at, a.ends_at, a.created_at,
              (SELECT COUNT(*) FROM ad_events ae WHERE ae.ad_id = a.id AND ae.event_type = 'impression') AS impressions,
              (SELECT COUNT(*) FROM ad_events ae WHERE ae.ad_id = a.id AND ae.event_type = 'click') AS clicks
       FROM ads a WHERE a.advertiser_id = :userId ORDER BY a.created_at DESC LIMIT 50`,
      { userId: req.user.id },
    ),
    query(
      `SELECT transaction_type, amount, balance_after, created_at
       FROM wallet_transactions WHERE user_id = :userId ORDER BY created_at DESC LIMIT 20`,
      { userId: req.user.id },
    ),
  ]);
  const analytics = campaignRows.reduce((total, row) => {
    total.impressions += Number(row.impressions || 0);
    total.clicks += Number(row.clicks || 0);
    total.spent += Number(row.spent || 0);
    return total;
  }, { impressions: 0, clicks: 0, spent: 0 });
  analytics.ctr = analytics.impressions > 0
    ? Number(((analytics.clicks / analytics.impressions) * 100).toFixed(2))
    : 0;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    wallet: walletRows[0]
      ? { balance: Number(walletRows[0].balance), currency: walletRows[0].currency }
      : { balance: 0, currency: 'IRR' },
    analytics,
    campaigns: campaignRows.map((row) => ({
      id: row.public_id,
      name: row.campaign_name,
      headline: row.headline,
      placement: row.placement,
      assetType: row.asset_type,
      creativeUrl: row.creative_url,
      budget: Number(row.budget),
      spent: Number(row.spent),
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      status: row.status,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      createdAt: row.created_at,
    })),
    transactions: transactionRows.map((row) => ({
      type: row.transaction_type,
      amount: Number(row.amount),
      balanceAfter: Number(row.balance_after),
      createdAt: row.created_at,
    })),
  });
}));

app.patch('/api/advertiser/campaigns/:adId', requireUser, requireRole('advertiser'), asyncRoute(async (req, res) => {
  const status = asEnum(req.body?.status, 'وضعیت', ['active', 'paused']);
  const result = await query(
    `UPDATE ads SET status = :status
     WHERE public_id = :adId AND advertiser_id = :userId
       AND status IN ('active', 'paused') AND ends_at > UTC_TIMESTAMP(3)`,
    { status, adId: req.params.adId, userId: req.user.id },
  );
  assert(result.affectedRows, 409, 'CAMPAIGN_NOT_CHANGEABLE', 'این کمپین قابل تغییر نیست.');
  res.json({ updated: true, status });
}));

function parseButtons(value) {
  if (!value) return [];
  let buttons;
  try {
    buttons = typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new AppError(422, 'INVALID_BUTTONS', 'ساختار دکمه‌های تبلیغ نامعتبر است.');
  }
  assert(Array.isArray(buttons) && buttons.length <= 12, 422, 'INVALID_BUTTONS', 'حداکثر ۱۲ دکمه مجاز است.');
  return buttons.map((button) => ({
    text: asString(button.text, 'عنوان دکمه', { min: 1, max: 60 }),
    url: asHttpUrl(button.url, 'نشانی دکمه', { httpsOnly: isProduction }),
  }));
}

app.post(
  '/api/advertiser/campaigns',
  requireUser,
  requireRole('advertiser'),
  upload.single('creative'),
  asyncRoute(async (req, res) => {
    let uploadedPath = req.file?.path || null;
    try {
      const placement = asEnum(req.body?.placement, 'جایگاه', ['pre_roll', 'timed_banner', 'pause_overlay']);
      const campaignName = asString(req.body?.campaignName, 'نام کمپین', { min: 3, max: 180 });
      const headline = asString(req.body?.headline, 'عنوان تبلیغ', { min: 3, max: 180 });
      const body = asString(req.body?.body, 'متن تبلیغ', { max: 1000, optional: true });
      const budget = asPositiveNumber(req.body?.budget, 'بودجه', { min: 1, max: 1_000_000_000_000_000 });
      const startsAt = asDate(req.body?.startsAt, 'زمان شروع');
      const endsAt = asDate(req.body?.endsAt, 'زمان پایان');
      assert(endsAt > startsAt, 422, 'INVALID_CAMPAIGN_DATES', 'زمان پایان باید بعد از شروع باشد.');
      assert(startsAt.getTime() >= Date.now() - 5 * 60_000, 422, 'CAMPAIGN_START_IN_PAST', 'زمان شروع نمی‌تواند در گذشته باشد.');
      assert(endsAt.getTime() - startsAt.getTime() <= 180 * 86400_000, 422, 'CAMPAIGN_TOO_LONG', 'مدت کمپین نمی‌تواند بیشتر از ۱۸۰ روز باشد.');
      const skipAfter = Math.round(asPositiveNumber(req.body?.skipAfterSeconds ?? 5, 'زمان رد کردن', { min: 0, max: 30 }));
      const targetUrl = asHttpUrl(req.body?.targetUrl, 'نشانی مقصد', { optional: true, httpsOnly: isProduction });
      const buttons = parseButtons(req.body?.telegramButtons);
      const telegramPostText = asString(req.body?.telegramPostText, 'متن صفحه واسط', { max: 5000, optional: true });

      let creativeUrl;
      let assetType;
      if (req.file) {
        const appUrl = String(process.env.APP_URL || '').replace(/\/$/, '');
        creativeUrl = `${appUrl}/uploads/${encodeURIComponent(req.file.filename)}`;
        assetType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
      } else {
        creativeUrl = asHttpUrl(req.body?.creativeUrl, 'فایل تبلیغ', { httpsOnly: isProduction });
        assetType = asEnum(req.body?.assetType, 'نوع فایل', ['video', 'image']);
      }
      if (placement === 'pre_roll') {
        assert(assetType === 'video', 422, 'VIDEO_REQUIRED', 'جایگاه پیش‌نمایش به فایل ویدیویی نیاز دارد.');
      }

      const publicId = crypto.randomUUID();
      const created = await withTransaction(async (connection) => {
        const [prices] = await connection.execute(
          'SELECT * FROM ad_placement_prices WHERE placement = :placement AND is_active = TRUE FOR UPDATE',
          { placement },
        );
        assert(prices[0], 422, 'PLACEMENT_UNAVAILABLE', 'این جایگاه در حال حاضر فعال نیست.');
        assert(budget >= Number(prices[0].minimum_budget), 422, 'BUDGET_TOO_LOW', `حداقل بودجه این جایگاه ${Number(prices[0].minimum_budget).toLocaleString('fa-IR')} ریال است.`);
        await connection.execute(
          `INSERT INTO advertiser_wallets (user_id, balance)
           VALUES (:userId, 0) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
          { userId: req.user.id },
        );
        const [wallets] = await connection.execute(
          'SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId FOR UPDATE',
          { userId: req.user.id },
        );
        const currentBalance = Number(wallets[0].balance);
        assert(currentBalance >= budget, 409, 'INSUFFICIENT_BALANCE', 'موجودی کیف پول برای این بودجه کافی نیست.');
        const newBalance = currentBalance - budget;
        const [adResult] = await connection.execute(
          `INSERT INTO ads
            (public_id, advertiser_id, campaign_name, headline, body, placement, asset_type,
             creative_url, target_url, telegram_post_text, telegram_buttons, unit_price,
             budget, skip_after_seconds, starts_at, ends_at)
           VALUES
            (:publicId, :userId, :campaignName, :headline, :body, :placement, :assetType,
             :creativeUrl, :targetUrl, :postText, :buttons, :unitPrice,
             :budget, :skipAfter, :startsAt, :endsAt)`,
          {
            publicId,
            userId: req.user.id,
            campaignName,
            headline,
            body,
            placement,
            assetType,
            creativeUrl,
            targetUrl,
            postText: telegramPostText,
            buttons: JSON.stringify(buttons),
            unitPrice: prices[0].price_per_thousand,
            budget,
            skipAfter,
            startsAt,
            endsAt,
          },
        );
        await connection.execute(
          'UPDATE advertiser_wallets SET balance = :balance WHERE user_id = :userId',
          { balance: newBalance, userId: req.user.id },
        );
        await connection.execute(
          `INSERT INTO wallet_transactions
            (user_id, ad_id, transaction_type, amount, balance_after, reference)
           VALUES (:userId, :adId, 'campaign_reserve', :amount, :balance, :reference)`,
          {
            userId: req.user.id,
            adId: adResult.insertId,
            amount: budget,
            balance: newBalance,
            reference: `campaign:${publicId}`,
          },
        );
        return { balance: newBalance, currency: wallets[0].currency };
      }, { isolationLevel: 'READ COMMITTED' });

      uploadedPath = null;
      res.status(201).json({
        campaign: { id: publicId, status: 'pending' },
        wallet: created,
      });
    } finally {
      if (uploadedPath) fs.promises.unlink(uploadedPath).catch(() => {});
    }
  }),
);

app.get('/api/admin/exchange', asyncRoute(async (req, res) => {
  const rawToken = asString(req.query.token, 'توکن', { min: 30, max: 200 });
  const tokenHash = hmacHex(rawToken);
  const ownerId = await withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT id, owner_tg_user_id FROM admin_login_tokens
       WHERE token_hash = :tokenHash AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3)
       LIMIT 1 FOR UPDATE`,
      { tokenHash },
    );
    if (!rows[0] || !ownerIds().has(String(rows[0].owner_tg_user_id))) {
      throw new AppError(404, 'NOT_FOUND', 'صفحه پیدا نشد.');
    }
    await connection.execute(
      'UPDATE admin_login_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE id = :id',
      { id: rows[0].id },
    );
    return rows[0].owner_tg_user_id;
  });
  const csrfToken = generateOpaqueToken(24);
  const session = signAdminToken(ownerId, csrfToken);
  res.cookie('filmwork_admin', session, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 2 * 60 * 60 * 1000,
    path: '/',
  });
  res.redirect(303, '/owner-console');
}));

app.get('/api/admin/session', requireAdmin, asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ownerId: String(req.admin.sub), csrfToken: req.admin.csrf });
}));

app.get('/api/admin/stats', requireAdmin, asyncRoute(async (_req, res) => {
  const [content, users, media, ads, healthEvents] = await Promise.all([
    query('SELECT COUNT(*) AS total, SUM(status = \'published\') AS published FROM contents'),
    query("SELECT COUNT(*) AS total, SUM(role = 'advertiser') AS advertisers FROM users WHERE status = 'active'"),
    query("SELECT COUNT(*) AS total, SUM(health_status = 'unavailable') AS unavailable FROM media_links"),
    query("SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending, SUM(status = 'active') AS active FROM ads"),
    query('SELECT mhe.reason, mhe.created_at, c.title FROM media_health_events mhe JOIN media_links ml ON ml.id = mhe.media_link_id JOIN contents c ON c.id = ml.content_id ORDER BY mhe.created_at DESC LIMIT 20'),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    stats: {
      contents: { total: Number(content[0].total), published: Number(content[0].published || 0) },
      users: { total: Number(users[0].total), advertisers: Number(users[0].advertisers || 0) },
      media: { total: Number(media[0].total), unavailable: Number(media[0].unavailable || 0) },
      ads: { total: Number(ads[0].total), pending: Number(ads[0].pending || 0), active: Number(ads[0].active || 0) },
    },
    healthEvents,
  });
}));

app.post('/api/admin/contents', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const title = asString(req.body?.title, 'عنوان', { min: 1, max: 255 });
  const originalTitle = asString(req.body?.originalTitle, 'عنوان اصلی', { max: 255, optional: true });
  const contentType = asEnum(req.body?.contentType || 'movie', 'نوع اثر', ['movie', 'series']);
  const description = asString(req.body?.description, 'توضیحات', { max: 20_000, optional: true });
  const releaseYear = req.body?.releaseYear
    ? Math.round(asPositiveNumber(req.body.releaseYear, 'سال انتشار', { min: 1888, max: 2200 }))
    : null;
  const imdbScore = req.body?.imdbScore !== undefined && req.body?.imdbScore !== ''
    ? asPositiveNumber(req.body.imdbScore, 'امتیاز IMDb', { min: 0, max: 10 })
    : null;
  const rawGenres = Array.isArray(req.body?.genres) ? req.body.genres : [];
  assert(rawGenres.length <= 12, 422, 'TOO_MANY_GENRES', 'حداکثر ۱۲ ژانر مجاز است.');
  const genres = rawGenres.map((genre) => asString(genre, 'ژانر', { min: 1, max: 60 }));
  const posterUrl = asHttpUrl(req.body?.posterUrl, 'لینک پوستر', { optional: true, httpsOnly: isProduction });
  const backdropUrl = asHttpUrl(req.body?.backdropUrl, 'لینک تصویر پس‌زمینه', { optional: true, httpsOnly: isProduction });
  const streamUrl = asHttpUrl(req.body?.streamUrl, 'لینک پخش', { optional: true, httpsOnly: isProduction });
  const status = asEnum(req.body?.status || 'draft', 'وضعیت', ['draft', 'published']);
  const assetUuid = crypto.randomUUID();
  await query(
    `INSERT INTO contents
      (asset_uuid, content_type, title, original_title, slug, description, imdb_score,
       release_year, genres, poster_url, backdrop_url, stream_url, status)
     VALUES
      (:assetUuid, :contentType, :title, :originalTitle, :slug, :description, :imdbScore,
       :releaseYear, :genres, :posterUrl, :backdropUrl, :streamUrl, :status)`,
    {
      assetUuid,
      contentType,
      title,
      originalTitle,
      slug: contentSlug(originalTitle || title, assetUuid),
      description,
      imdbScore,
      releaseYear,
      genres: JSON.stringify(genres),
      posterUrl,
      backdropUrl,
      streamUrl,
      status,
    },
  );
  res.status(201).json({ content: { id: assetUuid, title, status } });
}));

app.get('/api/admin/contents', requireAdmin, asyncRoute(async (_req, res) => {
  const rows = await query(
    `SELECT asset_uuid, title, content_type, status, created_at,
            (SELECT COUNT(*) FROM media_links ml WHERE ml.content_id = c.id) AS media_count
     FROM contents c ORDER BY created_at DESC LIMIT 200`,
  );
  res.json({ items: rows.map((row) => ({ ...row, media_count: Number(row.media_count) })) });
}));

app.patch('/api/admin/contents/:assetId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const status = asEnum(req.body?.status, 'وضعیت', ['draft', 'published', 'archived']);
  const result = await query(
    'UPDATE contents SET status = :status WHERE asset_uuid = :assetId',
    { status, assetId: req.params.assetId },
  );
  assert(result.affectedRows, 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
  res.json({ updated: true });
}));

app.get('/api/admin/users', requireAdmin, asyncRoute(async (_req, res) => {
  const rows = await query(
    `SELECT u.id, u.account_name, u.tg_username, u.role, u.status, u.created_at,
            COALESCE(w.balance, 0) AS wallet_balance, COALESCE(w.currency, 'IRR') AS wallet_currency
     FROM users u LEFT JOIN advertiser_wallets w ON w.user_id = u.id
     ORDER BY u.created_at DESC LIMIT 200`,
  );
  res.json({ items: rows.map((row) => ({
    id: String(row.id),
    accountName: row.account_name,
    telegramUsername: row.tg_username,
    role: row.role,
    status: row.status,
    walletBalance: Number(row.wallet_balance),
    walletCurrency: row.wallet_currency,
    createdAt: row.created_at,
  })) });
}));

app.patch('/api/admin/users/:userId/role', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  assert(/^\d+$/.test(req.params.userId), 422, 'INVALID_USER_ID', 'شناسه کاربر نامعتبر است.');
  const role = asEnum(req.body?.role, 'نقش', ['user', 'advertiser']);
  const result = await query('UPDATE users SET role = :role WHERE id = :userId AND status != \'deleted\'', {
    role,
    userId: req.params.userId,
  });
  assert(result.affectedRows, 404, 'USER_NOT_FOUND', 'کاربر پیدا نشد.');
  if (role === 'advertiser') {
    await query('INSERT IGNORE INTO advertiser_wallets (user_id, balance) VALUES (:userId, 0)', { userId: req.params.userId });
  }
  res.json({ updated: true });
}));

app.post('/api/admin/users/:userId/wallet-credit', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  assert(/^\d+$/.test(req.params.userId), 422, 'INVALID_USER_ID', 'شناسه کاربر نامعتبر است.');
  const amount = asPositiveNumber(req.body?.amount, 'مبلغ', { min: 1, max: 1_000_000_000_000_000 });
  const referenceSuffix = req.body?.reference
    ? asString(req.body.reference, 'مرجع', { min: 2, max: 100 })
    : generateOpaqueToken(10);
  const result = await withTransaction(async (connection) => {
    const [users] = await connection.execute(
      'SELECT id, role FROM users WHERE id = :userId AND status = \'active\' FOR UPDATE',
      { userId: req.params.userId },
    );
    assert(users[0], 404, 'USER_NOT_FOUND', 'کاربر پیدا نشد.');
    assert(users[0].role === 'advertiser', 409, 'ADVERTISER_REQUIRED', 'ابتدا نقش کاربر را به تبلیغ‌دهنده تغییر دهید.');
    await connection.execute(
      'INSERT INTO advertiser_wallets (user_id, balance) VALUES (:userId, 0) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
      { userId: req.params.userId },
    );
    const [wallets] = await connection.execute(
      'SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId FOR UPDATE',
      { userId: req.params.userId },
    );
    const balance = Number(wallets[0].balance) + amount;
    await connection.execute('UPDATE advertiser_wallets SET balance = :balance WHERE user_id = :userId', {
      balance,
      userId: req.params.userId,
    });
    await connection.execute(
      `INSERT INTO wallet_transactions
        (user_id, transaction_type, amount, balance_after, reference)
       VALUES (:userId, 'credit', :amount, :balance, :reference)`,
      {
        userId: req.params.userId,
        amount,
        balance,
        reference: `owner-credit:${req.params.userId}:${referenceSuffix}`,
      },
    );
    return { balance, currency: wallets[0].currency };
  }, { isolationLevel: 'READ COMMITTED' });
  res.status(201).json({ wallet: result });
}));

app.get('/api/admin/ads', requireAdmin, asyncRoute(async (_req, res) => {
  const rows = await query(
    `SELECT a.public_id, a.campaign_name, a.headline, a.placement, a.budget, a.status,
            a.created_at, u.account_name
     FROM ads a JOIN users u ON u.id = a.advertiser_id
     ORDER BY a.created_at DESC LIMIT 200`,
  );
  res.json({ items: rows.map((row) => ({ ...row, budget: Number(row.budget) })) });
}));

app.patch('/api/admin/ads/:adId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const status = asEnum(req.body?.status, 'وضعیت', ['pending', 'active', 'paused', 'completed', 'rejected']);
  const result = await changeCampaignStatus(req.params.adId, status);
  res.json(result);
}));

app.post('/api/admin/logout', requireAdmin, requireAdminCsrf, (req, res) => {
  res.clearCookie('filmwork_admin', { path: '/', sameSite: 'strict', secure: isProduction });
  res.json({ loggedOut: true });
});

// Owner console assets are outside the public frontend directory and are only
// transmitted after a valid owner-bot session has been verified.
app.get('/owner-console', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(privateDirectory, 'admin.html'));
});
app.get('/owner-console/app.js', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript').sendFile(path.join(privateDirectory, 'admin.js'));
});

app.use(express.static(frontendDirectory, {
  index: false,
  dotfiles: 'deny',
  etag: true,
  maxAge: isProduction ? '1h' : 0,
  setHeaders(res, filename) {
    if (filename.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));
const frontendIndexFile = path.join(frontendDirectory, 'index.html');

/**
 * A submission that only uploads `backend/` is a very common cPanel mistake: the API
 * works but every page request dies on sendFile and returns 500/503. Reply with an
 * actionable page instead.
 */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/owner-console') || req.path.startsWith('/uploads/')) {
    return next(new AppError(404, 'NOT_FOUND', 'مسیر پیدا نشد.'));
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!fs.existsSync(frontendIndexFile)) {
    res.status(500).type('text/html; charset=utf-8').send(
      '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>Filmwork</title>'
      + '<body style="font-family:system-ui;background:#08080a;color:#f4f4f5;padding:32px;line-height:2">'
      + '<h1>پوشه frontend پیدا نشد</h1>'
      + '<p>فایل <code>frontend/index.html</code> کنار پوشه <code>backend</code> قرار نگرفته است. '
      + 'کل مخزن را (نه فقط پوشه backend) روی هاست قرار دهید و سپس Application را Restart کنید.</p></body></html>',
    );
    return;
  }
  res.sendFile(frontendIndexFile);
});

app.use((req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'مسیر پیدا نشد.')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  let normalized = error;
  if (error instanceof multer.MulterError) {
    normalized = new AppError(422, 'UPLOAD_ERROR', error.code === 'LIMIT_FILE_SIZE' ? 'حجم فایل تبلیغ بیش از حد مجاز است.' : 'بارگذاری فایل ناموفق بود.');
  } else if (error?.type === 'entity.parse.failed') {
    normalized = new AppError(400, 'INVALID_JSON', 'بدنه JSON معتبر نیست.');
  } else if (error?.code === 'ER_DUP_ENTRY') {
    normalized = new AppError(409, 'DUPLICATE_RECORD', 'این رکورد پیش‌تر ثبت شده است.');
  }
  const status = normalized instanceof AppError ? normalized.status : 500;
  if (status >= 500) console.error(`[${req.requestId}] Unhandled request error`, error);
  res.status(status).json({
    error: {
      code: normalized.code || 'INTERNAL_ERROR',
      message: normalized instanceof AppError ? normalized.message : 'خطای داخلی سرور رخ داد.',
      requestId: req.requestId,
      ...(normalized.details ? { details: normalized.details } : {}),
      ...(!isProduction && status >= 500 ? { stack: error.stack } : {}),
    },
  });
});

let httpServer;
let campaignSettlementTimer;
// Set by the hosting entry point (app.js) when it already owns the listening port.
const hooks = { listenOnceReady: null };
let botRetryTimer;
let processGuardsInstalled = false;
let shuttingDown = false;
let botsStarting = false;
const botStatus = { authentication: 'pending', administration: 'pending', lastError: null };

/**
 * Bots are started *after* HTTP is already serving, and their failure never takes the
 * website down: a bot token that Telegram rejects (revoked token, host IP blocked,
 * `409 Conflict` from a second polling instance) used to abort `start()` and leave
 * Passenger without a running app, i.e. 503 on the whole domain. The site keeps
 * working and the bots retry in the background instead.
 */
async function startBots() {
  if (botsStarting) return;
  botsStarting = true;
  // Telegram can take several seconds (or hang behind a blocked network); never let
  // that delay the first HTTP response.
  for (const key of ['authentication', 'administration']) {
    if (botStatus[key] === 'pending') botStatus[key] = 'starting';
  }
  try {
    // Only start what is not already polling: launching the same token twice makes
    // Telegram answer 409 Conflict and kills the bot that was working.
    const pending = [];
    if (!authBotService.started && authBotService.bot === null) pending.push(['authentication', authBotService]);
    if (!adminBotService.started && adminBotService.bot === null) pending.push(['administration', adminBotService]);
    if (!pending.length) {
      botStatus.authentication = authBotService.started ? 'started' : botStatus.authentication;
      botStatus.administration = adminBotService.started ? 'started' : botStatus.administration;
      return;
    }
    const results = await Promise.allSettled(pending.map(([, service]) => service.start()));
    let failed = false;
    results.forEach((result, index) => {
      const [key] = pending[index];
      // `start()` returns false when the token is not configured at all.
      if (result.status === 'fulfilled') {
        botStatus[key] = result.value === false ? 'disabled' : 'started';
        return;
      }
      botStatus[key] = 'failed';
      failed = true;
      botStatus.lastError = String(result.reason?.message || result.reason).slice(0, 500);
      console.error(`Telegram bot (${key}) failed to start; the website stays online:`, result.reason);
    });
    if (failed) scheduleBotRetry();
  } finally {
    botsStarting = false;
  }
}

function scheduleBotRetry() {
  if (botRetryTimer || shuttingDown) return;
  const delayMs = Math.max(60_000, Number(process.env.BOT_RETRY_SECONDS || 300) * 1000);
  botRetryTimer = setTimeout(() => {
    botRetryTimer = null;
    startBots().catch((error) => console.error('Telegram bot retry failed:', error));
  }, delayMs);
  botRetryTimer.unref?.();
}

/**
 * Starts the database-dependent services, then binds HTTP.
 *
 * `listen: false` lets a host (app.js while it shows the startup diagnostic page)
 * prepare the app and take over the port itself once `start()` succeeds on a retry.
 */
async function start({ listen = true } = {}) {
  installProcessGuards();
  // The database is the only hard dependency; nothing else can work without it.
  await healthCheck();
  await settleExpiredCampaigns().catch((error) => {
    console.error('Initial campaign settlement failed (continuing):', error);
  });
  if (!campaignSettlementTimer) {
    campaignSettlementTimer = setInterval(() => {
      settleExpiredCampaigns().catch((error) => console.error('Expired campaign settlement failed', error));
    }, 5 * 60_000);
    campaignSettlementTimer.unref?.();
  }
  // Adopt a listener that was opened to show the startup diagnostic page, then hand
  // it the real app: this is how a retried boot takes over the port without a clash.
  if (listen && !httpServer && hooks.listenOnceReady) {
    const adopted = hooks.listenOnceReady();
    if (adopted) {
      httpServer = adopted;
      httpServer.on('error', (error) => {
        console.error(`HTTP server error on port ${port}:`, error);
      });
    }
  }
  if (listen && !httpServer) {
    await new Promise((resolve, reject) => {
      httpServer = app.listen(port, '0.0.0.0', () => {
        console.log(`Filmwork API listening on 0.0.0.0:${port}`);
        resolve();
      });
      httpServer.keepAliveTimeout = 65_000;
      httpServer.headersTimeout = 66_000;
      httpServer.once('error', reject);
    });
    httpServer.on('error', (error) => {
      console.error(`HTTP server error on port ${port}:`, error);
    });
  }
  if (listen) {
    startBots().catch((error) => console.error('Telegram bot startup failed (the website stays online):', error));
  }
  return httpServer || app;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down gracefully.`);
  const forceTimer = setTimeout(() => process.exit(1), 15_000);
  forceTimer.unref();
  if (campaignSettlementTimer) clearInterval(campaignSettlementTimer);
  if (botRetryTimer) clearTimeout(botRetryTimer);
  await Promise.allSettled([
    authBotService.stop(signal),
    adminBotService.stop(signal),
  ]);
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await closePool();
  clearTimeout(forceTimer);
}

// `node server.js` stays supported for PM2/systemd and for `npm run dev`. The
// Passenger/LiteSpeed entry point is `app.js`, which always calls `start()`.

/**
 * A single rejected promise in a background task (Telegram update, media sweeper,
 * campaign settlement) used to crash the process; Passenger then shows 503 until the
 * next request respawns it. Log and keep serving instead — an uncaught exception in a
 * handler is a bug to fix, not a reason to take the whole site offline.
 */
function installProcessGuards() {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection (server keeps running):', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception (server keeps running):', error);
  });
}

if (require.main === module) {
  installProcessGuards();
  start().catch(async (error) => {
    console.error('Filmwork failed to start:', error);
    await shutdown('startup-failure').catch(() => {});
    process.exit(1);
  });
  process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
}

module.exports = { app, start, shutdown, botStatus, numberFromEnv, hooks };
