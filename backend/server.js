'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const fsp = fs.promises;
const { spawn } = require('child_process');
const crypto = require('crypto');
const botRuntimeFiles = ['server.js', 'bots/authBot.js', 'bots/adminBot.js', 'bots/downloadBot.js', 'lib/botPolling.js', 'lib/botLeader.js', 'lib/botBranding.js', 'services/siteSettings.js'];
function botSourceFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of botRuntimeFiles) {
    hash.update(file);
    try { hash.update(fs.readFileSync(path.join(__dirname, file))); } catch { hash.update('<missing>'); }
  }
  return hash.digest('hex');
}
const runningBotFingerprint = botSourceFingerprint();
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

const { pool, query, withTransaction, healthCheck, closePool } = require('./config/db');
const { BotLeader } = require('./lib/botLeader');
const { telegramBotUrl } = require('./lib/telegram');
const { requestPassengerRestart } = require('./lib/deployRestart');
const { AppError, assert, asyncRoute } = require('./lib/errors');
const { parseCatalogFilters, catalogFacets } = require('./lib/catalogFilters');
const { createAliasIndex, expandAliases, displayCredits } = require('./lib/peopleAliases');
const { resolvePoster, posterImage } = require('./lib/posterImport');
const { imdbPosters } = require('./lib/imdbPosters');
const {
  hmacHex,
  generateOpaqueToken,
  signUserToken,
  signAdminToken,
  hashIp,
  requireSecret,
  timingSafeHexEqual,
  decryptPhone,
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
const { deliverManual } = require('./services/manualDelivery');
const mediaAdmin = require('./services/mediaAdmin');
const { processDeletions } = require('./services/telegramDeletion');
const { checkDownloadAllowance } = require('./services/downloadPolicy');
const { changeCampaignStatus, settleExpiredCampaigns, deleteCampaign } = require('./services/adAccounting');
const { eventDecision, shouldChargeImpression } = require('./services/adEventRules');
const { normalizeBid, chooseAd } = require('./services/adCompetition');
const { createAdSession, verifyAdSession } = require('./lib/adSession');
const { parsePlacements } = require('./services/adPlacements');
const { telegramTarget, trackedOrigin } = require('./lib/telegramAd');
const { moneyCents } = require('./lib/money');
const { buildParseDraft, normalizeContentPayload, updateContentPayload } = require('./lib/contentParams');
const { contentStore } = require('./services/contentStoreIndex');
const siteSettings = require('./services/siteSettings');
const couponService = require('./services/coupons');
const { authBotService } = require('./bots/authBot');
const { adminBotService } = require('./bots/adminBot');
const { downloadBotService } = require('./bots/downloadBot');

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
      'TELEGRAM_FALLBACK_3_CHAT_ID',
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
    lastAirYear: row.last_air_year ?? null,
    genres: parseJsonColumn(row.genres, []),
    directors: parseJsonColumn(row.directors, []),
    cast: parseJsonColumn(row.cast_members, []),
    language: row.language,
    country: row.country,
    countries: row.country ? String(row.country).split(/[,،]\s*/).filter(Boolean) : [],
    network: row.network,
    ageRating: row.age_rating,
    runtimeMinutes: row.runtime_minutes,
    posterUrl: row.poster_url,
    backdropUrl: row.backdrop_url,
    trailerUrl: row.trailer_url,
    streamUrl: row.stream_url,
    mediaCount: row.media_count === undefined ? undefined : Number(row.media_count),
    hasDub: row.has_dub === undefined ? undefined : Boolean(row.has_dub),
    hasSub: row.has_sub === undefined ? undefined : Boolean(row.has_sub),
    network: row.network,
    currentSeason: row.current_season,
    seriesRunning: row.series_running === undefined ? undefined : Boolean(row.series_running),
    episodeCount: row.episode_count,
    seasonCount: row.season_count,
    posterGallery: parseJsonColumn(row.poster_gallery, []),
    featuredHero: row.featured_hero === undefined ? undefined : Boolean(row.featured_hero),
    views: Number(row.view_count || 0),
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

app.get('/api/health', asyncRoute(async (_req, res) => {
  const demoMode = process.env.DEMO_DATA === '1';
  let database;
  try {
    database = { ...(await healthCheck()) };
  } catch (error) {
    // DEMO_DATA runs on the in-memory store on purpose; report it as healthy.
    if (demoMode) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ status: 'ok', mode: 'demo', database: { ok: true, demo: true }, timestamp: new Date().toISOString() });
      return;
    }
    // A monitoring probe needs a machine-readable answer, not an HTML error page.
    database = { ok: false, error: String(error.code || error.message || 'database_unreachable') };
  }
  const bots = {
    authentication: authBotService.started,
    administration: adminBotService.started,
    download: downloadBotService.started,
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
  // Only placements the owner has switched on are offered to advertisers.
  const prices = await query(
    `SELECT placement, slot_group, display_name_fa, price_per_thousand, minimum_budget,
            default_duration_seconds, currency
     FROM ad_placement_prices
     WHERE is_active = TRUE AND is_enabled = TRUE
     ORDER BY display_order, placement`,
  ).catch(() => []);
  const username = String(process.env.AUTH_BOT_USERNAME || '').replace(/^@/, '');
  const publicSettings = await siteSettings.read().catch(() => siteSettings.DEFAULTS);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    site: { name: publicSettings['site.name'], tagline: publicSettings['site.tagline'] },
    player: { enabled: publicSettings['player.enabled'] === '1', buttonVisible: publicSettings['player.button_visible'] === '1' },
    authBotUrl: username ? `https://t.me/${encodeURIComponent(username)}` : null,
    downloadBotUrl: telegramBotUrl(process.env.DOWNLOAD_BOT_USERNAME),
    maxPriorityMultiplier: adSettingsLib.adPolicy(await adPlatform.readSettings().catch(() => ({ ...adSettingsLib.DEFAULTS }))).maxPriorityMultiplier,
    placementPrices: adSettingsLib.publicPlacementPrices(prices).map((price) => ({
      placement: price.placement,
      asset: adSettingsLib.placementMeta(price.placement)?.asset,
      group: price.slot_group || 'video',
      label: price.display_name_fa,
      cpm: Number(price.price_per_thousand),
      minimumBudget: Number(price.minimum_budget),
      durationSeconds: Number(price.default_duration_seconds || 0),
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
      role: 'user',
      isAdvertiser: true,
      createdAt: user.created_at,
    },
  });
}));

app.get('/api/me', requireUser, asyncRoute(async (req, res) => {
  const rows = await query(
    'SELECT balance, currency FROM advertiser_wallets WHERE user_id = :id LIMIT 1',
    { id: req.user.id },
  );
  const wallet = rows[0] ? { balance: Number(rows[0].balance), currency: rows[0].currency } : { balance: 0, currency: 'IRR' };
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    user: {
      id: String(req.user.id),
      accountName: req.user.account_name,
      role: 'user',
      isAdvertiser: true,
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
            COALESCE(ml.public_id,vcl.public_id) AS media_public_id,
            COALESCE(ml.resolution,cv.resolution) AS resolution, COALESCE(ml.version_label,cv.title) AS version_label,
            ml.file_size_bytes, COALESCE(ml.audio_type, IF(cv.kind='dub','dubbed','soft_sub')) AS audio_type,
            COALESCE(ml.season_number,vcl.season_number) AS season_number, COALESCE(ml.episode_number,vcl.episode_number) AS episode_number, c.*
     FROM download_history dh
     LEFT JOIN media_links ml ON ml.id=dh.media_link_id
     LEFT JOIN content_version_links vcl ON vcl.id=dh.manual_version_link_id
     LEFT JOIN content_versions cv ON cv.id=vcl.version_id
     JOIN contents c ON c.id=COALESCE(ml.content_id,cv.content_id)
     WHERE dh.user_id=:userId AND c.status='published'
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

/**
 * Serves the public catalog from the in-memory store when DEMO_DATA is on, so the
 * storefront and the owner console always show the same library during a preview.
 */
// Only people/detail requests build this small in-memory index; catalog, home and
// playback requests do not. Coalesce concurrent builds and invalidate after edits.
let peopleCache = null;
let peopleRevision = 0;
function invalidatePeopleCache() { peopleRevision += 1; peopleCache = null; }
async function peopleIndex() {
  if (peopleCache && peopleCache.expires > Date.now()) return peopleCache.promise;
  const revision = peopleRevision;
  const promise = (async () => {
    const store = contentStore();
    const rows = store.kind === 'demo' ? await store.getPublishedCredits() : await query(
      "SELECT directors, cast_members FROM contents WHERE status = 'published' AND (directors IS NOT NULL OR cast_members IS NOT NULL)",
    );
    return createAliasIndex(rows);
  })();
  peopleCache = { promise, expires: Date.now() + 30_000 };
  try { return await promise; } catch (error) { if (peopleRevision === revision) peopleCache = null; throw error; }
}
async function enrichCredits(content) {
  const index = await peopleIndex();
  return { ...content, directors: displayCredits(content.directors, index), cast: displayCredits(content.cast, index) };
}

async function publicContentList(queryParams) {
  const store = contentStore();
  const extra = parseCatalogFilters(queryParams);
  if (extra.aliases.length) extra.aliases = expandAliases(extra.aliases, await peopleIndex());
  const { page, limit } = parsePage(queryParams);
  const result = await store.listContents({
    page,
    limit,
    q: typeof queryParams.q === 'string' ? queryParams.q.slice(0, 100) : '',
    type: queryParams.type,
    status: 'published',
    sort: queryParams.sort,
    genre: queryParams.genre,
    yearFrom: queryParams.yearFrom,
    yearTo: queryParams.yearTo,
    ...extra,
    running: extra.running ? '1' : '',
  });
  return {
    items: result.items.filter((item) => item.status === 'published').map(contentFromStoreItem),
    pagination: result.pagination,
  };
}

function contentFromStoreItem(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    originalTitle: item.originalTitle,
    description: item.description,
    imdbScore: item.imdbScore,
    releaseYear: item.releaseYear,
    lastAirYear: item.lastAirYear,
    genres: item.genres || [],
    directors: item.directors || [],
    cast: item.cast || [],
    countries: item.countries || [],
    network: item.network || null,
    ageRating: item.ageRating || null,
    runtimeMinutes: item.runtimeMinutes || null,
    seasonCount: item.seasons,
    episodeCount: item.episodes,
    currentSeason: item.currentSeason,
    seriesRunning: Boolean(item.seriesRunning),
    hasDub: Boolean(item.hasDub),
    hasSub: Boolean(item.hasSub),
    posterUrl: item.posterUrl,
    posterGallery: item.posterGallery || [],
    featuredHero: Boolean(item.featuredHero),
    views: Number(item.views || 0),
    mediaCount: item.mediaCount,
    createdAt: item.createdAt,
  };
}

app.get('/api/contents', asyncRoute(async (req, res) => {
  if (contentStore().kind === 'demo') {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await publicContentList(req.query));
    return;
  }
  const { page, limit, offset } = parsePage(req.query);
  const selected = parseCatalogFilters(req.query);
  if (selected.aliases.length) selected.aliases = expandAliases(selected.aliases, await peopleIndex());
  const filters = ["c.status = 'published'"];
  const params = { limit, offset };
  if (req.query.type && ['movie', 'series'].includes(req.query.type)) {
    filters.push('c.content_type = :type');
    params.type = req.query.type;
  }
  if (req.query.q) {
    const search = asString(req.query.q, 'جستجو', { min: 1, max: 100 });
    // The same box must find a Persian title, its English original title, a director
    // or actor in either script, a genre, a network or a country.
    const jsonTerm = `%${search.replace(/[%_\\]/g, '')}%`;
    filters.push(`(
      c.title LIKE :search ESCAPE '!'
      OR c.original_title LIKE :search ESCAPE '!'
      OR c.country LIKE :search ESCAPE '!'
      OR c.network LIKE :search ESCAPE '!'
      OR c.age_rating LIKE :search ESCAPE '!'
      OR JSON_SEARCH(c.directors, 'one', :jsonTerm) IS NOT NULL
      OR JSON_SEARCH(c.cast_members, 'one', :jsonTerm) IS NOT NULL
      OR JSON_SEARCH(c.genres, 'one', :jsonTerm) IS NOT NULL
    )`);
    params.search = `%${escapeLike(search)}%`;
    params.jsonTerm = jsonTerm;
  }
  if (req.query.genre) {
    const genre = asString(req.query.genre, 'ژانر', { min: 1, max: 60 });
    filters.push('JSON_CONTAINS(c.genres, JSON_QUOTE(:genre))');
    params.genre = genre;
  }
  if (selected.yearFrom !== null) { params.yearFrom = selected.yearFrom; filters.push('c.release_year >= :yearFrom'); }
  if (selected.yearTo !== null) { params.yearTo = selected.yearTo; filters.push('c.release_year <= :yearTo'); }
  if (selected.minRating !== null) { params.minRating = selected.minRating; filters.push('c.imdb_score >= :minRating'); }
  if (selected.maxRating !== null) { params.maxRating = selected.maxRating; filters.push('c.imdb_score <= :maxRating'); }
  function group(values, prefix, expression) {
    if (!values.length) return;
    filters.push('(' + values.map((value, index) => {
      const key = prefix + index; params[key] = value; return expression(key);
    }).join(' OR ') + ')');
  }
  group(selected.countries, 'country', (key) => `FIND_IN_SET(REPLACE(:${key}, ' ', ''), REPLACE(REPLACE(c.country, '،', ','), ' ', '')) > 0`);
  group(selected.ages, 'age', (key) => `c.age_rating = :${key}`);
  group(selected.networks, 'network', (key) => `c.network = :${key}`);
  if (selected.running) filters.push("c.content_type = 'series' AND c.series_running = TRUE");
  if (selected.audio === 'dub' || selected.audio === 'both') filters.push('c.has_dub = TRUE');
  if (selected.audio === 'sub' || selected.audio === 'both') filters.push('c.has_sub = TRUE');
  if (selected.aliases.length) {
    const columns = selected.role === 'director' ? ['c.directors'] : selected.role === 'cast' ? ['c.cast_members'] : ['c.directors', 'c.cast_members'];
    const matches = [];
    selected.aliases.forEach((name, index) => {
      const escaped = name.replace(/[!%_]/g, (ch) => '!' + ch);
      for (const [suffix, value] of [['exact', escaped], ['left', escaped + ' | %'], ['right', '% | ' + escaped]]) {
        const key = `person${index}${suffix}`; params[key] = value;
        for (const column of columns) matches.push(`JSON_SEARCH(${column}, 'one', :${key}, '!') IS NOT NULL`);
      }
    });
    filters.push('(' + matches.join(' OR ') + ')');
  }
  const where = filters.join(' AND ');
  const order = req.query.sort === 'title'
    ? 'c.title ASC, c.id ASC'
    : req.query.sort === 'rating'
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

app.get('/api/contents-facets', asyncRoute(async (req, res) => {
  const store = contentStore();
  const facets = store.kind === 'demo' ? await store.getCatalogFacets() : catalogFacets(await query(
    "SELECT genres, country, network, age_rating, release_year, imdb_score FROM contents WHERE status = 'published'",
  ));
  res.setHeader('Cache-Control', 'no-store');
  res.json(facets);
}));

app.get('/api/contents/:assetId', asyncRoute(async (req, res) => {
  const assetId = asString(req.params.assetId, 'شناسه اثر', { min: 36, max: 36 });
  if (contentStore().kind === 'demo') {
    const detail = await contentStore().getContent(assetId);
    if (detail.content.status !== 'published') throw new AppError(404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ content: await enrichCredits(contentFromStoreItem({ ...detail.content, genres: detail.content.genres || [] })) });
    return;
  }
  const rows = await query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM media_links ml WHERE ml.content_id = c.id AND ml.is_active = TRUE) AS media_count
     FROM contents c WHERE c.asset_uuid = :assetId AND c.status = 'published' LIMIT 1`,
    { assetId },
  );
  assert(rows[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.json({ content: await enrichCredits(contentDto(rows[0])) });
}));

// A detail-page navigation has one UUID. A retry after a lost response must not
// increment twice; row locking and the receipt are committed with the counter.
app.post('/api/contents/:assetId/views', asyncRoute(async (req, res) => {
  const assetId = asString(req.params.assetId, 'شناسه اثر', { min: 36, max: 36 });
  const visitId = asString(req.body?.visitId, 'شناسه بازدید', { min: 36, max: 36 }).toLowerCase();
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(visitId), 422, 'INVALID_VISIT', 'شناسه بازدید معتبر نیست.');
  let result;
  if (contentStore().kind === 'demo') result = await contentStore().recordContentView(assetId, visitId);
  else result = await withTransaction(async (connection) => {
    const [rows] = await connection.execute("SELECT id, view_count FROM contents WHERE asset_uuid = :assetId AND status = 'published' FOR UPDATE", { assetId });
    assert(rows[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
    const [receipt] = await connection.execute('INSERT IGNORE INTO content_view_receipts (content_id, visit_id) VALUES (:id, :visitId)', { id: rows[0].id, visitId });
    if (receipt.affectedRows) await connection.execute('UPDATE contents SET view_count = view_count + 1, last_viewed_at = UTC_TIMESTAMP(3) WHERE id = :id', { id: rows[0].id });
    return { views: Number(rows[0].view_count) + (receipt.affectedRows ? 1 : 0), counted: Boolean(receipt.affectedRows) };
  }, { isolationLevel: 'READ COMMITTED' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
}));

// Only playback URLs are public here; Telegram delivery links and owner data stay private.
app.get('/api/contents/:assetId/player-sources', asyncRoute(async (req, res) => {
  const assetId = asString(req.params.assetId, 'شناسه اثر', { min: 36, max: 36 });
  const detail = await contentStore().getContent(assetId);
  if (detail.content.status !== 'published') throw new AppError(404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
  const sources = (detail.versions || []).flatMap((version) => (version.links || [])
    .filter((link) => link.streamUrl)
    .map((link) => ({
      id: link.id, season: link.season ?? null, episode: link.episode ?? null,
      episodeTitle: link.title || null, version: version.title || null,
      resolution: version.resolution || null, quality: link.label || null,
      audioLabel: version.kind === 'dub' ? 'دوبله' : 'سافت‌ساب',
      streamUrl: link.streamUrl, subtitleUrl: link.subtitleUrl || null, audioUrl: link.dubUrl || null,
    })));
  for (const item of detail.botMedia || []) {
    if (!item.is_active || !item.stream_url) continue;
    sources.push({ id: item.public_id, season: item.season_number, episode: item.episode_number,
      episodeTitle: item.episode_title, version: item.version_label, resolution: item.resolution,
      quality: item.quality_label, audioLabel: item.audio_type === 'dubbed' ? 'دوبله' : 'زیرنویس',
      streamUrl: item.stream_url, subtitleUrl: null, audioUrl: null });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ sources });
}));

app.get('/api/contents/:assetId/media-options', asyncRoute(async (req, res) => {
  if (contentStore().kind === 'demo') {
    const detail = await contentStore().getContent(req.params.assetId).catch(() => null);
    const items = detail ? detail.versions.flatMap((version) => version.links.map((link) => ({
      id: link.id,
      season: link.season,
      episode: link.episode,
      episodeTitle: link.title,
      version: version.title,
      audioType: version.kind === 'dub' ? 'dubbed' : 'soft_sub',
      audioLabel: version.kind === 'dub' ? 'دوبله' : 'سافت‌ساب',
      subtitleType: version.kind === 'dub' ? 'none' : 'separate',
      resolution: version.resolution || version.title,
      quality: link.label,
      encoder: null,
      fileSizeBytes: 0,
      subtitleFileSizeBytes: null,
      streamUrl: link.streamUrl,
    }))) : [];
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items });
    return;
  }
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
  const manualRows = await query(`SELECT vcl.*, cv.title AS version_title, cv.kind, cv.resolution
    FROM content_version_links vcl JOIN content_versions cv ON cv.id=vcl.version_id
    JOIN contents c ON c.id=cv.content_id
    WHERE c.asset_uuid=:assetId AND c.status='published' AND vcl.media_link_id IS NULL
      AND vcl.public_id IS NOT NULL AND vcl.telegram_url IS NOT NULL`, { assetId:req.params.assetId });
  const knownLinks = new Set(rows.flatMap(row => [row.tg_link_primary, row.tg_link_fallback_1, row.tg_link_fallback_2, row.tg_link_fallback_3]).filter(Boolean));
  const manual = manualRows.filter(row => {
    if (knownLinks.has(row.telegram_url)) return false;
    try { mediaAdmin.parseTelegramMessage(row.telegram_url); return true; } catch { return false; }
  }).map(row => ({ id:row.public_id, season:row.season_number, episode:row.episode_number,
    episodeTitle:row.episode_title, version:row.version_title, audioType:row.kind === 'dub' ? 'dubbed' : 'soft_sub',
    audioLabel:row.kind === 'dub' ? 'دوبله' : 'سافت‌ساب', subtitleType:row.subtitle_url ? 'separate' : 'none',
    resolution:row.resolution || row.version_title, quality:row.label, encoder:null, fileSizeBytes:0,
    sizeText:row.size_text, subtitleFileSizeBytes:null, streamUrl:row.stream_url }));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: [...rows.map(mediaDto), ...manual] });
}));

app.get('/api/contents/:assetId/comments', asyncRoute(async (req, res) => {
  const { page, limit, offset } = parsePage({ ...req.query, limit: req.query.limit || 20 });
  if (contentStore().kind === 'demo') {
    // The demo store has no user accounts, so the thread starts empty.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: [], pagination: { page, limit, total: 0 } });
    return;
  }
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
    `SELECT ml.id FROM media_links ml JOIN contents c ON c.id = ml.content_id
     WHERE ml.public_id = :mediaId AND ml.is_active = TRUE AND c.status = 'published' LIMIT 1`, { mediaId });
  const manualRows = mediaRows.length ? [] : await query(
    `SELECT vcl.*, cv.title AS version_title, c.title AS content_title FROM content_version_links vcl
     JOIN content_versions cv ON cv.id=vcl.version_id JOIN contents c ON c.id=cv.content_id
     WHERE vcl.public_id=:mediaId AND vcl.media_link_id IS NULL AND vcl.telegram_url IS NOT NULL AND c.status='published' LIMIT 1`, { mediaId });
  assert(mediaRows[0] || manualRows[0], 404, 'MEDIA_NOT_FOUND', 'فایل پیدا نشد.');
  const isOwner = new Set(String(process.env.ADMIN_OWNER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)).has(String(req.user.tg_user_id));
  const settings = isOwner ? await siteSettings.read() : (await checkDownloadAllowance(req.user.id)).settings;
  const result = mediaRows[0] ? await deliverMedia(mediaId, req.user, settings) : await deliverManual(manualRows[0], req.user, settings);
  await query(
    `INSERT INTO download_history (user_id, media_link_id, manual_version_link_id, delivery_method)
     VALUES (:userId, :mediaLinkId, :manualLinkId, :deliveryMethod)`,
    { userId:req.user.id, mediaLinkId:mediaRows[0]?.id || null, manualLinkId:manualRows[0]?.id || null, deliveryMethod:result.deliveryMethod },
  ).catch((error) => console.error('Download was delivered but history logging failed', error));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...result,
    // Never send the storage-channel URL as the UI's open-in-Telegram link.
    // Keep the old field for cached clients, but make it point to the bot too.
    telegramLink: telegramBotUrl(process.env.DOWNLOAD_BOT_USERNAME),
    downloadBotUrl: telegramBotUrl(process.env.DOWNLOAD_BOT_USERNAME),
    message: result.deliveryMethod === 'telegram_link'
      ? `لینک فایل به گفت‌وگوی شما با ربات ${settings['site.name'] || 'سایت'} ارسال شد.`
      : `فایل به گفت‌وگوی شما با ربات ${settings['site.name'] || 'سایت'} ارسال شد.`,
  });
}));

app.get('/api/ads/serve', optionalUser, asyncRoute(async (req, res) => {
  // Old clients can still ask for the retired video pause slot. Never serve it.
  if (req.query.placement === 'pause_overlay') return res.json({ ad: null });
  const placement = asEnum(req.query.placement, 'جایگاه', adSettingsLib.PLACEMENT_KEYS);
  if (placement === 'link_file_button') return res.json({ ad:null }); // Served only with Telegram deliveries.
  const settings = await adPlatform.readSettings().catch(() => ({ ...adSettingsLib.DEFAULTS }));
  const policy = adSettingsLib.adPolicy(settings);
  const slot = await query(
    'SELECT is_enabled, is_active FROM ad_placement_prices WHERE placement = :placement LIMIT 1',
    { placement },
  ).catch(() => []);
  if (!slot[0] || !slot[0].is_enabled || !slot[0].is_active) return res.json({ ad: null });
  const rows = await query(
    `SELECT a.public_id, a.headline, a.body, ap.placement, a.asset_type, a.creative_url,
            a.target_url, a.skip_after_seconds, a.duration_seconds, a.budget, a.spent,
            a.owner_campaign, ap.bid_multiplier
     FROM ad_campaign_placements ap JOIN ads a ON a.id = ap.ad_id
     WHERE ap.placement = :placement AND a.status = 'active' AND a.deleted_at IS NULL
       AND a.starts_at <= UTC_TIMESTAMP(3) AND a.ends_at > UTC_TIMESTAMP(3)
       AND (a.owner_campaign = TRUE OR a.spent < a.budget)
     ORDER BY a.id DESC`,
    { placement },
  );
  if (!rows.length) return res.json({ ad: null });
  const row = chooseAd(rows);
  const adSession = createAdSession(row.public_id, { placement });
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ad: {
      id: row.public_id,
      headline: row.headline,
      body: row.body,
      placement: row.placement,
      assetType: row.asset_type,
      creativeUrl: row.creative_url,
      tunnelUrl: `/api/ad-tunnel/${encodeURIComponent(row.public_id)}?session=${encodeURIComponent(adSession)}`,
      skipAfterSeconds: Number(row.skip_after_seconds ?? policy.skipAfterSeconds),
      durationSeconds: Number(row.duration_seconds || policy.defaultVideoDuration),
      targetUrl: row.target_url || null,
      session: adSession,
    },
  });
}));

async function recordAdEvent(req, adId, session, eventType, { requireImpression = false } = {}) {
  const claims = verifyAdSession(session, adId);
  const sessionKey = hmacHex(`${adId}:${session}`);
  const accepted = await withTransaction(async (connection) => {
    const [ads] = await connection.execute(
      'SELECT id, placement, unit_price, budget, spent, status, owner_campaign FROM ads WHERE public_id = :adId AND deleted_at IS NULL FOR UPDATE',
      { adId: adId },
    );
    assert(ads[0], 404, 'AD_NOT_FOUND', 'تبلیغ پیدا نشد.');
    const eventPlacement = claims.placement || ads[0].placement;
    const [slots] = await connection.execute('SELECT CAST(unit_price AS CHAR) AS unit_price FROM ad_campaign_placements WHERE ad_id = :id AND placement = :placement', { id:ads[0].id, placement:eventPlacement });
    assert(slots[0], 422, 'INVALID_AD_SESSION', 'جایگاه نمایش نامعتبر است.');
    // Serialise transitions on the campaign row. The unique key alone prevents
    // duplicate event types but cannot prevent both skip and complete for a session.
    const [prior] = await connection.execute(
      'SELECT event_type FROM ad_events WHERE ad_id = :adId AND session_key = :sessionKey',
      { adId: ads[0].id, sessionKey },
    );
    if (requireImpression && !prior.some((event) => event.event_type === 'impression')) return false;
    const decision = eventDecision(eventType, prior.map((event) => event.event_type));
    if (decision !== 'accept') return false;
    const [eventResult] = await connection.execute(
      `INSERT IGNORE INTO ad_events (ad_id, user_id, event_type, placement, session_key, ip_hash, user_agent)
       VALUES (:adId, :userId, :eventType, :placement, :sessionKey, :ipHash, :userAgent)`,
      {
        adId: ads[0].id,
        userId: req.user?.id || null,
        eventType,
        placement: eventPlacement,
        sessionKey,
        ipHash: hashIp(req.ip),
        userAgent: String(req.get('user-agent') || '').slice(0, 500) || null,
      },
    );
    if (shouldChargeImpression(eventType, eventResult.affectedRows === 1, ads[0])) {
      await connection.execute(
        `UPDATE ads SET
           status = IF(spent + (:unitPrice / 1000) >= budget, 'completed', status),
           spent = LEAST(budget, spent + (:unitPrice / 1000))
         WHERE id = :id`,
        { id: ads[0].id, unitPrice: slots[0].unit_price },
      );
    }
    return eventResult.affectedRows === 1;
  }, { isolationLevel: 'READ COMMITTED' });
  return accepted;
}

app.post('/api/ads/:adId/events', optionalUser, asyncRoute(async (req, res) => {
  const eventType = asEnum(req.body?.eventType, 'رویداد', ['impression', 'click', 'skip', 'complete']);
  const session = asString(req.get('x-ad-session') || req.body?.session, 'شناسه نمایش', { min: 40, max: 400 });
  const claims = verifyAdSession(session, req.params.adId);
  assert(!claims.purpose || claims.purpose === 'web', 422, 'INVALID_AD_SESSION', 'شناسه نمایش نامعتبر است.');
  const accepted = await recordAdEvent(req, req.params.adId, session, eventType);
  res.status(202).json({ accepted });
}));

// A tracked bot link counts at most one click per delivered message. Direct
// links bypass the site completely and never report clicks.
app.get('/api/ads/telegram-click/:adId', asyncRoute(async (req, res) => {
  const session = asString(req.query.session, 'شناسه نمایش', { min:40, max:400 });
  const claims = verifyAdSession(session, req.params.adId, { allowExpired:true });
  assert(claims.purpose === 'telegram', 422, 'INVALID_AD_SESSION', 'شناسه نمایش نامعتبر است.');
  const rows = await query("SELECT target_url FROM ads WHERE public_id = :id AND placement = 'link_file_button' AND telegram_click_mode = 'tracked' AND deleted_at IS NULL AND status IN ('active','paused','completed') LIMIT 1", { id:req.params.adId });
  assert(rows[0], 404, 'AD_NOT_FOUND', 'تبلیغ پیدا نشد.');
  const target = telegramTarget(rows[0].target_url);
  if (Number(claims.exp) > Date.now()) await recordAdEvent(req, req.params.adId, session, 'click', { requireImpression:true });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(302, target);
}));

app.get('/api/ad-tunnel/:adId', asyncRoute(async (req, res) => {
  const rows = await query(
    `SELECT public_id, headline, body, asset_type, creative_url, target_url,
            telegram_post_text, telegram_buttons, landing_mode
     FROM ads
     WHERE public_id = :adId AND deleted_at IS NULL AND status IN ('active', 'completed') LIMIT 1`,
    { adId: req.params.adId },
  );
  assert(rows[0], 404, 'AD_NOT_FOUND', 'صفحه تبلیغ پیدا نشد.');
  if (req.query.session) {
    const session = asString(req.query.session, 'شناسه نمایش', { min: 40, max: 400 });
    // Navigation is a fallback when a browser is closed before the click POST.
    // The same session/type is idempotent with the POST and transactionally locked.
    await recordAdEvent(req, req.params.adId, session, 'click');
  }
  const ad = rows[0];
  const creative = safePublicUrl(ad.creative_url);
  const target = safePublicUrl(ad.target_url);
  if (ad.landing_mode === 'direct' && target) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, target);
  }
  const rawButtons = parseJsonColumn(ad.telegram_buttons, []);
  const buttons = Array.isArray(rawButtons)
    ? rawButtons.filter((button) => button && safePublicUrl(button.url)).slice(0, 12)
    : [];
  const media = !creative ? '' : ad.asset_type === 'video'
    ? `<video controls playsinline preload="metadata" src="${escapeHtml(creative)}"></video>`
    : `<img src="${escapeHtml(creative)}" alt="${escapeHtml(ad.headline)}">`;
  const buttonHtml = buttons.map((button) => (
    `<a class="button secondary" href="${escapeHtml(safePublicUrl(button.url))}" rel="noopener noreferrer">${escapeHtml(button.text || 'مشاهده')}</a>`
  )).join('');
  const targetButton = target
    ? `<a class="button primary" href="${escapeHtml(target)}" rel="noopener noreferrer">مشاهده پیشنهاد</a>`
    : '';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
  const [walletRows, campaignRows, transactionRows, analyticsRows] = await Promise.all([
    query('SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId LIMIT 1', { userId: req.user.id }),
    query(
      `SELECT a.public_id, a.campaign_name, a.headline, a.placement, a.asset_type,
              a.creative_url, a.telegram_click_mode, a.landing_mode, a.budget, a.spent, a.status, a.starts_at, a.ends_at, a.created_at,
              (SELECT GROUP_CONCAT(ap.placement ORDER BY ap.placement SEPARATOR ',') FROM ad_campaign_placements ap WHERE ap.ad_id = a.id) AS placements,
              (SELECT COUNT(*) FROM ad_events ae WHERE ae.ad_id = a.id AND ae.event_type = 'impression') AS impressions,
              (SELECT COUNT(*) FROM ad_events ae WHERE ae.ad_id = a.id AND ae.event_type = 'click') AS clicks,
              (SELECT COUNT(*) FROM ad_events ae WHERE ae.ad_id = a.id AND ae.event_type = 'complete') AS completes,
              (SELECT COUNT(*) FROM ad_events ae WHERE ae.ad_id = a.id AND ae.event_type = 'skip') AS skips
       FROM ads a WHERE a.advertiser_id = :userId AND a.deleted_at IS NULL AND a.owner_campaign = FALSE ORDER BY a.created_at DESC LIMIT 50`,
      { userId: req.user.id },
    ),
    query(
      `SELECT transaction_type, amount, balance_after, created_at
       FROM wallet_transactions WHERE user_id = :userId ORDER BY created_at DESC LIMIT 20`,
      { userId: req.user.id },
    ),
    query(`SELECT
      (SELECT COUNT(*) FROM ad_events e JOIN ads a ON a.id = e.ad_id WHERE a.advertiser_id = :userId AND a.owner_campaign = FALSE AND e.event_type = 'impression') AS impressions,
      (SELECT COUNT(*) FROM ad_events e JOIN ads a ON a.id = e.ad_id WHERE a.advertiser_id = :userId AND a.owner_campaign = FALSE AND e.event_type = 'click') AS clicks,
      (SELECT COUNT(*) FROM ad_events e JOIN ads a ON a.id = e.ad_id WHERE a.advertiser_id = :userId AND a.owner_campaign = FALSE AND e.event_type = 'complete') AS completes,
      (SELECT COUNT(*) FROM ad_events e JOIN ads a ON a.id = e.ad_id WHERE a.advertiser_id = :userId AND a.owner_campaign = FALSE AND e.event_type = 'skip') AS skips,
      ((SELECT COALESCE(SUM(spent), 0) FROM ads WHERE advertiser_id = :userId AND owner_campaign = FALSE) + (SELECT COALESCE(SUM(spent), 0) FROM ad_financial_archive WHERE advertiser_id = :userId AND owner_campaign = FALSE)) AS spent`,
      { userId: req.user.id }),
  ]);
  const totals = analyticsRows[0] || {};
  const analytics = Object.fromEntries(['impressions', 'clicks', 'completes', 'skips', 'spent'].map((key) => [key, Number(totals[key] || 0)]));
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
      placements: row.placements ? row.placements.split(',') : [row.placement],
      landingMode: row.landing_mode,
      assetType: row.asset_type,
      creativeUrl: row.creative_url,
      telegramClickMode: row.telegram_click_mode,
      budget: Number(row.budget),
      spent: Number(row.spent),
      impressions: Number(row.impressions || 0),
      clicks: Number(row.clicks || 0),
      completes: Number(row.completes || 0),
      skips: Number(row.skips || 0),
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
     WHERE public_id = :adId AND advertiser_id = :userId AND owner_campaign = FALSE AND deleted_at IS NULL
       AND status IN ('active', 'paused') AND ends_at > UTC_TIMESTAMP(3)`,
    { status, adId: req.params.adId, userId: req.user.id },
  );
  assert(result.affectedRows, 409, 'CAMPAIGN_NOT_CHANGEABLE', 'این کمپین قابل تغییر نیست.');
  res.json({ updated: true, status });
}));

app.delete('/api/advertiser/campaigns/:adId', requireUser, requireRole('advertiser'), asyncRoute(async (req, res) => {
  const result = await deleteCampaign(req.params.adId, req.user.id);
  res.json(result);
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
      const placements = parsePlacements(req.body || {});
      const placement = placements[0];
      const adPolicy = adSettingsLib.adPolicy(await adPlatform.readSettings().catch(() => ({ ...adSettingsLib.DEFAULTS })));
      const campaignName = asString(req.body?.campaignName, 'نام کمپین', { min: 3, max: 180 });
      const headline = asString(req.body?.headline, 'عنوان تبلیغ', { min: 3, max: 180 });
      const body = asString(req.body?.body, 'متن تبلیغ', { max: 1000, optional: true });
      const budget = String(req.body?.budget ?? '').trim();
      const budgetCents = moneyCents(budget);
      assert(budgetCents >= 100n, 422, 'BUDGET_TOO_LOW', 'حداقل بودجه یک ریال است.');
      const startsAt = asDate(req.body?.startsAt, 'زمان شروع');
      const endsAt = asDate(req.body?.endsAt, 'زمان پایان');
      assert(endsAt > startsAt, 422, 'INVALID_CAMPAIGN_DATES', 'زمان پایان باید بعد از شروع باشد.');
      assert(startsAt.getTime() >= Date.now() - 5 * 60_000, 422, 'CAMPAIGN_START_IN_PAST', 'زمان شروع نمی‌تواند در گذشته باشد.');
      assert(endsAt.getTime() - startsAt.getTime() <= 180 * 86400_000, 422, 'CAMPAIGN_TOO_LONG', 'مدت کمپین نمی‌تواند بیشتر از ۱۸۰ روز باشد.');
      const skipAfter = Math.round(asPositiveNumber(req.body?.skipAfterSeconds ?? 5, 'زمان رد کردن', { min: 0, max: 30 }));
      let targetUrl = asHttpUrl(req.body?.targetUrl, 'نشانی مقصد', { optional: placement !== 'link_file_button', httpsOnly: isProduction });
      const clickMode = placement === 'link_file_button' ? asEnum(req.body?.telegramClickMode || 'tracked', 'شیوهٔ هدایت', ['tracked','direct']) : 'tracked';
      const landingMode = placement === 'link_file_button' ? 'intermediate' : asEnum(req.body?.landingMode || 'intermediate', 'شیوهٔ هدایت', ['intermediate','direct']);
      if (landingMode === 'direct') assert(targetUrl, 422, 'TARGET_REQUIRED', 'برای هدایت مستقیم نشانی مقصد لازم است.');
      if (placement === 'link_file_button') { targetUrl = telegramTarget(targetUrl); if (clickMode === 'tracked') trackedOrigin(); assert(headline.length <= 64, 422, 'BUTTON_TEXT_TOO_LONG', 'عنوان دکمه حداکثر ۶۴ نویسه است.'); }
      const buttons = parseButtons(req.body?.telegramButtons);
      const telegramPostText = asString(req.body?.telegramPostText, 'متن صفحه واسط', { max: 5000, optional: true });

      let creativeUrl;
      let assetType;
      let creativeLocalPath = null;
      if (req.file) {
        const appUrl = String(process.env.APP_URL || '').replace(/\/$/, '');
        creativeUrl = `${appUrl}/uploads/${encodeURIComponent(req.file.filename)}`;
        creativeLocalPath = req.file.filename;
        assetType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
      } else if (['text','link'].includes(adSettingsLib.placementMeta(placement).asset)) {
        creativeUrl = ''; assetType = 'image';
      } else {
        creativeUrl = asHttpUrl(req.body?.creativeUrl, 'فایل تبلیغ', { httpsOnly: isProduction });
        assetType = asEnum(req.body?.assetType, 'نوع فایل', ['video', 'image']);
      }
      const slotMeta = adSettingsLib.placementMeta(placement);
      const bid = normalizeBid(req.body?.bidMultiplier, placement, adPolicy.maxPriorityMultiplier);
      if (['text','link'].includes(slotMeta.asset)) assert(!req.file, 422, 'TEXT_ONLY', 'برای تبلیغ متنی فایل ارسال نکنید.');
      if (slotMeta.asset === 'video') {
        assert(assetType === 'video', 422, 'VIDEO_REQUIRED', 'این جایگاه به فایل ویدیویی نیاز دارد.');
      }
      if (slotMeta.asset === 'image') {
        assert(assetType === 'image', 422, 'IMAGE_REQUIRED', 'این جایگاه به تصویر نیاز دارد.');
      }
      // Owner rules: upload caps and local files are stored with the campaign so a
      // rejection can delete them from the host.
      if (req.file) {
        const limitMb = assetType === 'video' ? adPolicy.maxVideoMb : adPolicy.maxImageKb / 1024;
        assert(req.file.size / (1024 * 1024) <= limitMb, 422, 'CREATIVE_TOO_LARGE',
          assetType === 'video'
            ? `حجم ویدیو حداکثر ${adPolicy.maxVideoMb} مگابایت است.`
            : `حجم تصویر حداکثر ${adPolicy.maxImageKb} کیلوبایت است.`);
        if (assetType === 'image') assert(req.file.size / 1024 <= adPolicy.maxImageKb, 422, 'IMAGE_TOO_LARGE', `حجم تصویر حداکثر ${adPolicy.maxImageKb} کیلوبایت است.`);
      }
      if (adPolicy.linkAllowlist.length && targetUrl) {
        const host = (() => { try { return new URL(targetUrl).hostname.toLowerCase(); } catch { return ''; } })();
        const allowed = adPolicy.linkAllowlist.some((entry) => host === entry || host.endsWith(`.${entry.replace(/^\*\./, '')}`));
        assert(allowed, 422, 'LINK_NOT_ALLOWED', 'دامنه مقصد در فهرست مجاز تنظیمات تبلیغات نیست.');
      }

      const publicId = crypto.randomUUID();
      const created = await withTransaction(async (connection) => {
        // Lock in a deterministic order; reject the whole purchase if any slot
        // is disabled or the one shared budget is below that slot's minimum.
        const prices = new Map();
        for (const key of [...placements].sort()) {
          const [rows] = await connection.execute(
            'SELECT *, CAST(price_per_thousand AS CHAR) AS price_exact, (CAST(:budget AS DECIMAL(20,5)) >= minimum_budget) AS budget_sufficient FROM ad_placement_prices WHERE placement = :placement AND is_active = TRUE AND is_enabled = TRUE FOR UPDATE',
            { placement:key, budget },
          );
          assert(rows[0], 422, 'PLACEMENT_UNAVAILABLE', 'یکی از جایگاه‌های انتخاب‌شده فعال نیست.');
          assert(rows[0].budget_sufficient, 422, 'BUDGET_TOO_LOW', `حداقل بودجهٔ جایگاه ${rows[0].display_name_fa} ${Number(rows[0].minimum_budget).toLocaleString('fa-IR')} ریال است.`);
          prices.set(key, rows[0]);
        }
        await connection.execute(
          `INSERT INTO advertiser_wallets (user_id, balance)
           VALUES (:userId, 0) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
          { userId: req.user.id },
        );
        const [wallets] = await connection.execute(
          'SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId FOR UPDATE',
          { userId: req.user.id },
        );
        const [debit] = await connection.execute(
          'UPDATE advertiser_wallets SET balance = balance - :budget WHERE user_id = :userId AND balance >= :budget',
          { budget, userId: req.user.id },
        );
        assert(debit.affectedRows === 1, 409, 'INSUFFICIENT_BALANCE', 'موجودی کیف پول برای این بودجه کافی نیست.');
        const [updatedWallets] = await connection.execute('SELECT CAST(balance AS CHAR) AS balance FROM advertiser_wallets WHERE user_id = :userId', { userId: req.user.id });
        const newBalance = updatedWallets[0].balance;
        const [adResult] = await connection.execute(
          `INSERT INTO ads
            (public_id, advertiser_id, campaign_name, headline, body, placement, asset_type,
             creative_url, creative_local_path, target_url, telegram_click_mode, landing_mode, telegram_post_text, telegram_buttons,
             unit_price, bid_multiplier, budget, skip_after_seconds, duration_seconds, starts_at, ends_at, status)
           VALUES
            (:publicId, :userId, :campaignName, :headline, :body, :placement, :assetType,
             :creativeUrl, :localPath, :targetUrl, :clickMode, :landingMode, :postText, :buttons,
             ROUND(:basePrice * :bid, 2), :bid, :budget, :skipAfter, :duration, :startsAt, :endsAt, :status)`,
          {
            publicId,
            userId: req.user.id,
            campaignName,
            headline,
            body,
            placement,
            assetType,
            creativeUrl,
            localPath: creativeLocalPath,
            targetUrl,
            clickMode,
            landingMode,
            duration: slotMeta.group === 'banner' ? adPolicy.defaultBannerDuration : adPolicy.defaultVideoDuration,
            status: adPolicy.autoApprove ? 'active' : 'pending',
            postText: telegramPostText,
            buttons: JSON.stringify(buttons),
            basePrice: prices.get(placement).price_exact,
            bid,
            budget,
            skipAfter,
            startsAt,
            endsAt,
          },
        );
        for (const key of placements) {
          await connection.execute(`INSERT INTO ad_campaign_placements (ad_id, placement, unit_price, bid_multiplier)
            VALUES (:adId, :placement, ROUND(:basePrice * :bid, 2), :bid)`,
          {adId:adResult.insertId, placement:key, basePrice:prices.get(key).price_exact, bid});
        }
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
        campaign: { id: publicId, status: adPolicy.autoApprove ? 'active' : 'pending', placements },
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
  const store = contentStore();
  const [overview, legacy] = await Promise.all([
    store.overview(),
    store.kind === 'demo'
      ? Promise.resolve([])
      : query("SELECT (SELECT COUNT(*) FROM media_links WHERE health_status = 'unavailable') AS unavailable").catch(() => []),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    overview,
    stats: {
      contents: { total: overview.totals.contents, published: overview.totals.published },
      users: { total: overview.totals.users, advertisers: overview.totals.advertisers },
      media: { total: overview.totals.media, unavailable: Number(legacy[0]?.unavailable || overview.totals.streams || 0) },
      ads: { total: overview.totals.ads, pending: overview.totals.pendingAds, active: overview.totals.activeAds },
    },
    healthEvents: overview.health,
    mode: contentStore().kind,
    warnings: overview.warnings || [],
  });
}));

/**
 * Reads a pasted Telegram post (text and/or link) into an editable draft.
 * Nothing is written: the owner reviews the parsed fields, then saves.
 */
app.post('/api/admin/parse', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 40_000) : '';
  const link = typeof req.body?.link === 'string' && req.body.link.trim()
    ? asString(req.body.link, 'لینک پست', { min: 8, max: 512 })
    : null;
  if (!text.trim() && !link) {
    throw new AppError(422, 'EMPTY_SOURCE', 'متن یا لینک پست تلگرام را وارد کنید.');
  }
  const draft = await buildParseDraft({ text, link });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ draft });
}));

// IMPAwards uses HTTP/hotlink restrictions: relay only allowlisted image URLs
// on demand, without writing files or caching on the server.
app.get('/img', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }), asyncRoute(async (req, res) => {
  const image = await posterImage(asString(req.query.url, 'لینک پوستر', { min: 10, max: 2048 }));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type({ '.jpg':'image/jpeg', '.png':'image/png', '.webp':'image/webp' }[image.extension]).send(image.data);
}));
app.post('/api/admin/import-poster', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const source = await resolvePoster(asString(req.body?.url, 'لینک پوستر', { min: 10, max: 2048 }));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ path: `/img?url=${encodeURIComponent(source)}`, source });
}));
app.post('/api/admin/imdb-posters', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const url = asString(req.body?.url, 'لینک IMDb', { min: 10, max: 2048 });
  const posters = await imdbPosters(url, Number(req.body?.count));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ posters });
}));

/**
 * Host self-check: tells the owner what this server actually has, so a failing
 * dashboard can be explained without shell access (wrong schema version, MariaDB
 * instead of MySQL, migration not run, keys missing, ...).
 */
/**
 * GitHub → host sync.
 *
 * Updating a cPanel/LiteSpeed deployment used to mean opening File Manager and
 * overwriting files by hand. This endpoint pulls the repository archive for the
 * configured branch and applies every file that belongs to the application code
 * (`backend/`, `frontend/`, `database/`), then reports what changed. It never
 * touches `.env`, `node_modules`, `uploads` or anything outside those trees, and
 * refuses to run when a checkout/redeploy is not safe.
 *
 * GET  /api/admin/deploy/status  → current ref, upstream latest commit, drift
 * POST /api/admin/deploy/github  → pull and apply { branch?, dryRun? }
 *
 * Requires `GITHUB_REPO` (e.g. `Atliner/filmwork`) and, for private repositories,
 * `GITHUB_TOKEN`. See DEPLOYMENT_GUIDE.md.
 */
const DEPLOY_TREES = ['backend', 'frontend', 'database'];
const DEPLOY_SKIP = new Set(['node_modules', '.git', 'uploads', '.env', '.env.local']);
const DEPLOY_PATHS = [
  'backend', 'frontend', 'database',
  'README.md', 'DEPLOYMENT_GUIDE.md', 'package.json',
];

function githubRepo() {
  const repo = String(process.env.GITHUB_REPO || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new AppError(422, 'DEPLOY_NOT_CONFIGURED', 'متغیر GITHUB_REPO را مثل Atliner/filmwork در .env تنظیم کنید.');
  }
  return repo;
}

function deployBranch() {
  return String(process.env.GITHUB_BRANCH || 'main').trim();
}

async function githubFetch(pathname) {
  const headers = {
    'User-Agent': 'filmwork-deploy',
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let response;
  try {
    response = await fetch(`https://api.github.com${pathname}`, { headers });
  } catch (error) {
    throw new AppError(502, 'GITHUB_UNREACHABLE', `دسترسی سرور به گیت‌هاب برقرار نشد (${error.message}). اگر host اجازه خروج نمی‌دهد، از «به‌روزرسانی دستی» پایین صفحه استفاده کنید.`);
  }
  if (!response.ok) {
    throw new AppError(502, 'GITHUB_UNAVAILABLE', `ارتباط با گیت‌هاب ناموفق بود (${response.status}).`);
  }
  return response;
}

const deployState = { lastRunAt: null, lastResult: null, currentRef: null };

app.get('/api/admin/deploy/status', requireAdmin, asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const repo = process.env.GITHUB_REPO || null;
  const base = {
    configured: Boolean(repo),
    repo,
    branch: deployBranch(),
    appRoot: path.resolve(__dirname, '..'),
    lastRunAt: deployState.lastRunAt,
    lastResult: deployState.lastResult,
    botRuntime: { matchesDisk: runningBotFingerprint === botSourceFingerprint(), fingerprint: runningBotFingerprint.slice(0, 12), processId: process.pid, leader: botStatus.leader, status: { ...botStatus } },
  };
  if (!repo) {
    res.json(base);
    return;
  }
  try {
    const branch = await (await githubFetch(`/repos/${repo}/branches/${encodeURIComponent(deployBranch())}`)).json();
    base.upstream = {
      sha: branch.commit.sha,
      message: branch.commit.commit.message,
      date: branch.commit.commit.author?.date,
      url: branch.commit.html_url,
    };
  } catch (error) {
    base.upstreamError = error.message;
  }
  res.json(base);
}));

app.post('/api/admin/deploy/github', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const fail = (message, code = 'DEPLOY_FAILED') => new AppError(502, code, message);
  const repo = githubRepo();
  const branch = typeof req.body?.branch === 'string' && req.body.branch.trim()
    ? asString(req.body.branch, 'شاخه', { min: 1, max: 120 })
    : deployBranch();
  const dryRun = req.body?.dryRun === true;
  const appRoot = path.resolve(__dirname, '..');
  const branchInfo = await (await githubFetch(`/repos/${repo}/branches/${encodeURIComponent(branch)}`)).json();
  const sha = branchInfo.commit.sha;
  let archive;
  try {
    archive = await fetch(`https://codeload.github.com/${repo}/tar.gz/${sha}`, {
      headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
    });
  } catch (error) {
    throw fail(`دریافت آرشیو از گیت‌هاب ممکن نشد (${error.message}).`);
  }
  if (!archive.ok) throw fail(`دریافت آرشیو ناموفق بود (${archive.status}).`, 'GITHUB_UNAVAILABLE');
  const tarball = Buffer.from(await archive.arrayBuffer());
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'filmwork-deploy-'));
  const written = [];
  const skipped = [];
  try {
    const tarPath = path.join(staging, 'source.tar.gz');
    await fsp.writeFile(tarPath, tarball);
    const extractDir = path.join(staging, 'extract');
    await fsp.mkdir(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xzf', tarPath, '-C', extractDir, '--strip-components=1'], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
    });
    const walk = async (relative) => {
      const entries = await fsp.readdir(path.join(extractDir, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (DEPLOY_SKIP.has(entry.name)) continue;
        if (entry.isDirectory()) {
          if (!relative && !DEPLOY_TREES.includes(entry.name)) continue;
          await walk(child);
        } else if (DEPLOY_PATHS.some((allowed) => child === allowed || child.startsWith(`${allowed}/`))) {
          const source = path.join(extractDir, child);
          const target = path.join(appRoot, child);
          const incoming = await fsp.readFile(source);
          const existing = await fsp.readFile(target).catch(() => null);
          if (existing && existing.equals(incoming)) continue;
          if (!dryRun) {
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.writeFile(target, incoming);
          }
          written.push({ path: child, status: existing ? 'updated' : 'added' });
        } else {
          skipped.push(child);
        }
      }
    };
    await walk('');
    // Keep the prebuilt CSS in step with the Tailwind sources when they changed.
    const cssChanged = written.some((file) => file.path === 'frontend/tailwind.css' || file.path === 'backend/tailwind.config.js');
    // Passenger observes this marker on the next request. It cannot restart a
    // separately launched process or replace a systemd/PM2 restart policy.
    let restartRequested = false;
    if (!dryRun) {
      await requestPassengerRestart(__dirname);
      restartRequested = true;
    }
    deployState.lastRunAt = new Date().toISOString();
    deployState.lastResult = { sha, branch, dryRun, files: written.length, cssNeedsBuild: cssChanged };
    res.json({
      deployed: !dryRun,
      sha,
      branch,
      commit: branchInfo.commit.commit.message,
      files: written,
      skipped: skipped.slice(0, 50),
      cssNeedsBuild: cssChanged,
      restartRequired: !dryRun,
      restartRequested,
    });
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}));

app.get('/api/admin/diagnostics', requireAdmin, asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const store = contentStore();
  const report = {
    mode: store.kind,
    node: process.version,
    migrations: { contentVersions: false, ownerConsoleV2: false },
    database: { version: null, engine: null, ok: false, error: null },
    checks: [],
  };
  const check = (name, ok, detail) => report.checks.push({ name, ok, detail: detail || null });
  if (store.kind === 'demo') {
    check('حالت نمایشی', true, 'DEMO_DATA=1 است؛ داده‌ها در حافظه نگه داشته می‌شوند و به دیتابیس وصل نمی‌شویم.');
    res.json(report);
    return;
  }
  try {
    const [row] = await query('SELECT VERSION() AS version');
    report.database.version = row.version;
    report.database.engine = /mariadb/i.test(String(row.version)) ? 'mariadb' : 'mysql';
    report.database.ok = true;
  } catch (error) {
    report.database.error = error.message;
  }
  const tableExists = async (table) => {
    const rows = await query(
      `SELECT COUNT(*) AS found FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = :table`,
      { table },
    );
    return Number(rows[0]?.found || 0) > 0;
  };
  const columnExists = async (table, column) => {
    const rows = await query(
      `SELECT COUNT(*) AS found FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = :table AND column_name = :column`,
      { table, column },
    );
    return Number(rows[0]?.found || 0) > 0;
  };
  try {
    for (const table of ['contents', 'users', 'media_links', 'ads', 'admin_events', 'content_versions', 'content_version_links']) {
      check(`جدول ${table}`, await tableExists(table), null);
    }
    report.migrations.contentVersions = await tableExists('content_versions') && await tableExists('content_version_links');
    // The version relation lives in content_version_links.media_link_id; no
    // content_version_link_id column exists in either schema or migration.
    // Check actual columns rather than claim to know whether a file was run.
    const ownerRequired = {
      contents: ['last_air_year','series_running','current_season','broadcast_note','episode_count','season_count','directors','cast_members','network','has_dub','has_sub','poster_gallery','featured_hero','view_count','last_viewed_at','hero_slot'],
      content_versions: ['id','content_id','kind','title','resolution','sort_order','created_at','updated_at'],
      content_version_links: ['id','version_id','season_number','episode_number','episode_title','label','size_text','stream_url','subtitle_url','dub_url','telegram_url','media_link_id','source','created_at','updated_at'],
      admin_events: ['id','kind','title','detail','created_at'],
    };
    const ownerColumns = await query(`SELECT table_name AS tableName, column_name AS columnName
      FROM information_schema.columns WHERE table_schema = DATABASE()
        AND table_name IN ('contents','content_versions','content_version_links','admin_events')`);
    const existingOwnerColumns = new Set(ownerColumns.map((row) => `${row.tableName}.${row.columnName}`));
    const ownerMissing = Object.entries(ownerRequired).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`).filter((key) => !existingOwnerColumns.has(key)));
    report.migrations.ownerConsoleV2 = ownerMissing.length === 0;
    check('ساختار پنل نسخه ۲', report.migrations.ownerConsoleV2,
      ownerMissing.length ? `ستون‌های موجودنشده: ${ownerMissing.join('، ')}. فایل قدیمی migration را دوباره کامل اجرا نکنید؛ ابتدا از دیتابیس پشتیبان بگیرید و ساختار را بررسی کنید.` : null);
    check('ستون ژانر', await columnExists('contents', 'genres'), null);
    // A GitHub update copies SQL files but does not run them. Check the features
    // separately so an owner can identify a partially applied upgrade.
    const viewReceipts = await tableExists('content_view_receipts');
    const adDeletedAt = await columnExists('ads', 'deleted_at');
    const adBid = await columnExists('ads', 'bid_multiplier');
    const telegramMode = await columnExists('ads', 'telegram_click_mode');
    const adColumns = await query(`SELECT table_name AS tableName, column_name AS columnName, column_type AS columnType, numeric_precision AS precisionValue, numeric_scale AS scaleValue
      FROM information_schema.columns WHERE table_schema = DATABASE()
        AND ((table_name IN ('ads','ad_placement_prices') AND column_name = 'placement')
          OR (table_name = 'ads' AND column_name IN ('budget','spent'))
          OR (table_name = 'advertiser_wallets' AND column_name = 'balance')
          OR (table_name = 'wallet_transactions' AND column_name IN ('amount','balance_after'))) `);
    const pagePlacements = ['banner_home','text_home','banner_detail','text_detail','banner_search','text_search'];
    const placementTypes = ['ads','ad_placement_prices'].every((table) => {
      const column = adColumns.find((row) => row.tableName === table && row.columnName === 'placement');
      return column && pagePlacements.every((name) => String(column.columnType).includes(`'${name}'`));
    });
    const preciseMoney = [['ads','budget'],['ads','spent'],['advertiser_wallets','balance'],['wallet_transactions','amount'],['wallet_transactions','balance_after']].every(([table, column]) => {
      const row = adColumns.find((item) => item.tableName === table && item.columnName === column);
      return row && Number(row.scaleValue) >= 5 && Number(row.precisionValue) - Number(row.scaleValue) >= 15;
    });
    report.migrations.contentViewReceipts = viewReceipts;
    report.migrations.adSoftDelete = adDeletedAt;
    report.migrations.adPageBidding = Boolean(adBid && telegramMode && placementTypes && preciseMoney);
    check('جدول ثبت بازدید آثار', viewReceipts, viewReceipts ? null : 'پس از پشتیبان‌گیری، migration 2026-11-content-view-receipts.sql را اجرا کنید.');
    check('ستون حذف کمپین', adDeletedAt, adDeletedAt ? null : 'پس از پشتیبان‌گیری، migration 2026-11-soft-delete-campaigns.sql را اجرا کنید.');
    check('ساختار تبلیغات صفحه و ربات', report.migrations.adPageBidding, report.migrations.adPageBidding ? null : 'پس از پشتیبان‌گیری و بررسی پیش‌نیازها، migration 2026-11-page-ads-bidding.sql را اجرا کنید.');
    const multiplePlacements = await tableExists('ad_campaign_placements') && await columnExists('ads', 'landing_mode') && await columnExists('ad_events', 'placement');
    report.migrations.adMultiplePlacements = multiplePlacements;
    check('جایگاه‌های چندگانه و صفحهٔ واسط اختیاری', multiplePlacements, multiplePlacements ? null : 'پس از پشتیبان‌گیری و اجرای migrationهای قبلی، فایل 2026-11-ad-multiple-placements.sql را اجرا کنید.');
    const downloadVideoEnums = ['ads','ad_placement_prices'].every((table) => adColumns.some((column) => column.tableName === table && column.columnName === 'placement' && String(column.columnType).includes("'video_download'")));
    const downloadVideoRow = downloadVideoEnums && (await query("SELECT COUNT(*) AS found FROM ad_placement_prices WHERE placement='video_download'"))[0]?.found > 0;
    report.migrations.pauseBannerDownloadVideo = Boolean(downloadVideoEnums && downloadVideoRow);
    check('بنر توقف و ویدیوی قبل از دانلود', report.migrations.pauseBannerDownloadVideo, report.migrations.pauseBannerDownloadVideo ? null : 'پس از پشتیبان‌گیری و اجرای migrationهای قبلی، فایل 2026-11-pause-banner-download-video.sql را اجرا کنید.');
    report.migrations.permanentDeletion = await tableExists('ad_financial_archive') && await tableExists('ad_financial_placement_rates') && await columnExists('wallet_transactions', 'campaign_public_id') && await columnExists('admin_events', 'content_asset_id') && await columnExists('admin_events', 'ad_public_id');
    check('حذف قطعی و حفظ اطلاعات مالی', report.migrations.permanentDeletion, report.migrations.permanentDeletion ? null : 'پس از بکاپ و migrationهای قبلی، فایل 2026-11-permanent-deletion-finance.sql را اجرا کنید.');

  } catch (error) {
    check('بررسی ساختار دیتابیس', false, error.message);
  }
  const overview = await store.overview().catch((error) => ({ error }));
  check('داشبورد', !overview.error, overview.error ? overview.error.message : (overview.warnings?.length
    ? `بخش‌های ناموفق: ${overview.warnings.map((item) => item.block).join('، ')}`
    : null));
  res.json(report);
}));

app.get('/api/admin/contents', requireAdmin, asyncRoute(async (req, res) => {
  const result = await contentStore().listContents({
    page: req.query.page,
    limit: req.query.limit,
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '',
    type: req.query.type,
    status: req.query.status,
    hero: req.query.hero,
    running: req.query.running,
    sort: req.query.sort,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
}));

app.get('/api/admin/contents/:assetId', requireAdmin, asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await contentStore().getContent(req.params.assetId));
}));

app.post('/api/admin/contents', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const payload = normalizeContentPayload(req.body || {}, { statuses: ['draft', 'published'] });
  const created = await contentStore().createContent(payload);
  invalidatePeopleCache();
  res.status(201).json(created);
}));

app.patch('/api/admin/contents/:assetId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  // Status-only edits stay supported for the compact library toggle.
  if (req.body?.status && Object.keys(req.body).length === 1) {
    const status = asEnum(req.body.status, 'وضعیت', ['draft', 'published', 'archived']);
    const payload = updateContentPayload(await contentStore().getContent(req.params.assetId), { status });
    payload.versions = undefined;
    const updated = await contentStore().updateContent(req.params.assetId, payload);
    invalidatePeopleCache();
    res.json(updated);
    return;
  }
  const payload = updateContentPayload(await contentStore().getContent(req.params.assetId), req.body || {});
  if (!Object.hasOwn(req.body || {}, 'versions')) payload.versions = undefined;
  else payload.manualRevision = req.body?.manualRevision;
  const updated = await contentStore().updateContent(req.params.assetId, payload);
  invalidatePeopleCache();
  res.json(updated);
}));

app.post('/api/admin/contents/:assetId/hero', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  res.json(await contentStore().setHero(req.params.assetId, enabled));
}));

app.patch('/api/admin/contents/:assetId/media/:mediaId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  assert(contentStore().kind !== 'demo', 404, 'MEDIA_NOT_FOUND', 'فایل پیدا نشد.');
  res.json({ media: await mediaAdmin.update(req.params.assetId, req.params.mediaId, req.body?.revision, req.body?.changes) });
}));

app.delete('/api/admin/contents/:assetId/media/:mediaId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  assert(contentStore().kind !== 'demo', 404, 'MEDIA_NOT_FOUND', 'فایل پیدا نشد.');
  res.json(await mediaAdmin.remove(req.params.assetId, req.params.mediaId, req.body?.revision));
}));

app.post('/api/admin/contents/:assetId/sync-media', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  res.json(await contentStore().syncFromMedia(req.params.assetId));
}));

app.delete('/api/admin/contents/:assetId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const deleted = await contentStore().deleteContent(req.params.assetId);
  invalidatePeopleCache();
  res.json(deleted);
}));

/**
 * The owner sees the Telegram identity a visitor shared with the login bot.
 * The phone number is stored encrypted (AES-256-GCM); only the masked tail is
 * exposed by default and the full number only through the explicit reveal route,
 * so a stolen browser session never dumps the whole address book at once.
 */
function safeDecryptPhone(payload) {
  try {
    return decryptPhone(payload);
  } catch {
    return null;
  }
}

function maskPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, '');
  return digits.length >= 7 ? `${digits.slice(0, 4)}••••${digits.slice(-2)}` : '••••';
}

function ownerUserDto(row) {
  const phone = safeDecryptPhone(row.encrypted_phone);
  return {
    id: String(row.id),
    accountName: row.account_name,
    telegramUsername: row.tg_username,
    telegramUserId: row.tg_user_id === undefined || row.tg_user_id === null ? null : String(row.tg_user_id),
    telegramProfileUrl: row.tg_username ? `https://t.me/${row.tg_username}` : null,
    telegramChatUrl: row.tg_username ? `https://t.me/${row.tg_username}` : `tg://user?id=${row.tg_user_id}`,
    phoneMasked: maskPhone(phone),
    phoneLast4: row.phone_last4 || null,
    role: 'user',
    isAdvertiser: true,
    status: row.status,
    walletBalance: Number(row.wallet_balance || 0),
    walletCurrency: row.wallet_currency || 'IRR',
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at,
  };
}

app.get('/api/admin/users', requireAdmin, asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (contentStore().kind === 'demo') {
    res.json({
      items: await contentStore().listUsers({ q: req.query.q, role: req.query.role }),
      mode: 'demo',
    });
    return;
  }
  const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
  const role = req.query.role === 'user' ? 'user' : '';
  const where = ["u.status <> 'deleted'"];
  const params = {};
  if (role) {
    where.push('u.role = :role');
    params.role = role;
  }
  // Advertiser access is shared by every account; users.role is legacy metadata.
  if (search) {
    where.push("(u.account_name LIKE :search ESCAPE '!' OR u.tg_username LIKE :search ESCAPE '!' OR u.phone_last4 LIKE :search ESCAPE '!' OR CAST(u.tg_user_id AS CHAR) LIKE :search ESCAPE '!')");
    params.search = `%${String(search).replace(/[!%_]/g, (match) => `!${match}`)}%`;
  }
  const rows = await query(
    `SELECT u.id, u.account_name, u.tg_username, u.tg_user_id, u.encrypted_phone, u.phone_last4,
            u.role, u.status, u.last_login_at, u.created_at,
            COALESCE(w.balance, 0) AS wallet_balance, COALESCE(w.currency, 'IRR') AS wallet_currency
     FROM users u LEFT JOIN advertiser_wallets w ON w.user_id = u.id
     WHERE ${where.join(' AND ')}
     ORDER BY u.created_at DESC LIMIT 500`,
    params,
  );
  res.json({ items: rows.map(ownerUserDto), mode: 'mysql' });
}));

/** Reveals one full phone number on demand; always logged in the owner audit trail. */
app.get('/api/admin/users/:userId/phone', requireAdmin, asyncRoute(async (req, res) => {
  assert(/^\d+$/.test(req.params.userId), 422, 'INVALID_USER_ID', 'شناسه کاربر نامعتبر است.');
  if (contentStore().kind === 'demo') {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await contentStore().revealUserPhone(req.params.userId));
    return;
  }
  const rows = await query('SELECT encrypted_phone FROM users WHERE id = :userId LIMIT 1', { userId: req.params.userId });
  const phone = rows[0] ? safeDecryptPhone(rows[0].encrypted_phone) : null;
  assert(phone, 404, 'PHONE_UNAVAILABLE', 'شماره‌ای برای این کاربر ثبت نشده است.');
  await query(
    "INSERT INTO admin_events (kind, title, detail) VALUES ('user', :title, :detail)",
    { title: 'شماره کاربر نمایش داده شد', detail: `شناسه ${req.params.userId}` },
  ).catch(() => {});
  res.setHeader('Cache-Control', 'no-store');
  res.json({ phone });
}));

/** Wallet top-up straight from the console (creates the wallet when needed). */
app.post('/api/admin/users/:userId/wallet', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  assert(/^\d+$/.test(req.params.userId), 422, 'INVALID_USER_ID', 'شناسه کاربر نامعتبر است.');
  const amount = asPositiveNumber(req.body?.amount, 'مبلغ', { min: 1, max: 1_000_000_000_000_000 });
  const rawNote = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  const note = rawNote ? cleanPlainText(rawNote, 180) : '';
  if (contentStore().kind === 'demo') {
    res.status(201).json({ wallet: await contentStore().creditUserWallet(req.params.userId, amount) });
    return;
  }
  const result = await withTransaction(async (connection) => {
    const [users] = await connection.execute(
      "SELECT id, account_name, role, status FROM users WHERE id = :userId AND status <> 'deleted' FOR UPDATE",
      { userId: req.params.userId },
    );
    assert(users[0], 404, 'USER_NOT_FOUND', 'کاربر پیدا نشد.');
    await connection.execute(
      'INSERT INTO advertiser_wallets (user_id, balance) VALUES (:userId, 0) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
      { userId: req.params.userId },
    );
    const [wallets] = await connection.execute(
      'SELECT balance, currency FROM advertiser_wallets WHERE user_id = :userId FOR UPDATE',
      { userId: req.params.userId },
    );
    const balance = Number(wallets[0].balance) + amount;
    await connection.execute('UPDATE advertiser_wallets SET balance = :balance WHERE user_id = :userId', { balance, userId: req.params.userId });
    await connection.execute(
      "INSERT INTO wallet_transactions (user_id, transaction_type, amount, balance_after, reference) VALUES (:userId, 'credit', :amount, :balance, :reference)",
      { userId: req.params.userId, amount, balance, reference: `owner-topup:${req.params.userId}:${generateOpaqueToken(10)}` },
    );
    await connection.execute(
      "INSERT INTO admin_events (kind, title, detail) VALUES ('user', :title, :detail)",
      { title: 'کیف پول شارژ شد', detail: `${users[0].account_name} · ${amount} ${wallets[0].currency}${note ? ` · ${note}` : ''}` },
    ).catch(() => {});
    return { balance, currency: wallets[0].currency, added: amount };
  }, { isolationLevel: 'READ COMMITTED' });
  res.status(201).json({ wallet: result });
}));

/**
 * Hard delete: removes the account and everything hanging off it (wallets,
 * transactions, favorites, progress, downloads, login codes, ad events). Ads the
 * user created are cascaded to wallet-safe deletes first because `ads` uses
 * ON DELETE RESTRICT for accounting integrity.
 */
app.delete('/api/admin/users/:userId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  assert(/^\d+$/.test(req.params.userId), 422, 'INVALID_USER_ID', 'شناسه کاربر نامعتبر است.');
  if (contentStore().kind === 'demo') {
    res.json({ deleted: true, user: await contentStore().deleteUser(req.params.userId) });
    return;
  }
  const removed = await withTransaction(async (connection) => {
    const [users] = await connection.execute(
      'SELECT id, account_name, tg_user_id FROM users WHERE id = :userId FOR UPDATE',
      { userId: req.params.userId },
    );
    assert(users[0], 404, 'USER_NOT_FOUND', 'کاربر پیدا نشد.');
    await connection.execute('DELETE FROM ad_events WHERE user_id = :userId', { userId: req.params.userId });
    await connection.execute('DELETE FROM ads WHERE advertiser_id = :userId', { userId: req.params.userId });
    await connection.execute('DELETE FROM users WHERE id = :userId', { userId: req.params.userId });
    await connection.execute(
      "INSERT INTO admin_events (kind, title, detail) VALUES ('user', :title, :detail)",
      { title: 'کاربر حذف شد', detail: `${users[0].account_name} · شناسه ${req.params.userId}` },
    ).catch(() => {});
    return { id: String(users[0].id), accountName: users[0].account_name };
  }, { isolationLevel: 'READ COMMITTED' });
  res.json({ deleted: true, user: removed });
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

/* -------------------------------------------------------- ad platform (owner) */
const adPlatform = require('./services/adPlatform');
const adSettingsLib = require('./services/adSettings');

const adStoreKind = () => contentStore().kind;

app.get('/api/admin/site-settings', requireAdmin, asyncRoute(async (_req, res) => {
  res.json({ settings: await siteSettings.read() });
}));
app.patch('/api/admin/site-settings', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  res.json({ settings: await siteSettings.write(req.body?.settings || {}) });
}));

app.get('/api/admin/coupons', requireAdmin, asyncRoute(async (_req, res) => {
  res.json({ items: await couponService.listCoupons() });
}));
app.post('/api/admin/coupons', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  res.status(201).json({ coupon: await couponService.createCoupon(req.body || {}) });
}));
app.delete('/api/admin/coupons/:couponId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  res.json(await couponService.deleteCoupon(req.params.couponId));
}));
app.post('/api/advertiser/coupons/redeem', requireUser, requireRole('advertiser'), asyncRoute(async (req, res) => {
  res.json({ wallet: await couponService.redeemCoupon(req.user.id, req.body?.code) });
}));

app.get('/api/admin/ads/settings', requireAdmin, asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const payload = adStoreKind() === 'demo'
    ? await contentStore().readAdSettings()
    : { settings: await adPlatform.readSettings(), placements: await adPlatform.readPlacements() };
  res.json({
    ...payload,
    groups: adSettingsLib.GROUPS,
    policy: adSettingsLib.adPolicy(payload.settings),
  });
}));

app.patch('/api/admin/ads/settings', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const payload = adStoreKind() === 'demo'
    ? await contentStore().writeAdSettings(req.body?.settings || {})
    : { settings: await adPlatform.writeSettings(req.body?.settings || {}), placements: await adPlatform.readPlacements() };
  await query(
    "INSERT INTO admin_events (kind, title, detail) VALUES ('ad', 'تنظیمات تبلیغات ذخیره شد', :detail)",
    { detail: Object.keys(req.body?.settings || {}).length + ' مورد' },
  ).catch(() => {});
  res.json({ ...payload, policy: adSettingsLib.adPolicy(payload.settings) });
}));

app.patch('/api/admin/ads/placements/:placement', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const placements = adStoreKind() === 'demo'
    ? await contentStore().updateAdPlacement(req.params.placement, req.body || {})
    : await adPlatform.updatePlacement(req.params.placement, req.body || {});
  res.json({ placements });
}));

app.get('/api/admin/ads/dashboard', requireAdmin, asyncRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(adStoreKind() === 'demo' ? await contentStore().adDashboard() : await adPlatform.adDashboard());
}));

app.get('/api/admin/ads/campaigns', requireAdmin, asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const items = adStoreKind() === 'demo'
    ? await contentStore().listAdCampaigns({ status: req.query.status, owner: req.query.owner })
    : await adPlatform.listCampaigns({ status: req.query.status, owner: req.query.owner });
  res.json({ items });
}));

app.delete('/api/admin/ads/campaigns/:adId', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const result = adStoreKind() === 'demo'
    ? await contentStore().deleteAdCampaign(req.params.adId)
    : await deleteCampaign(req.params.adId);
  res.json(result);
}));

/** Approve/reject/pause a campaign. Rejection refunds unspent budget and purges uploads. */
app.post('/api/admin/ads/campaigns/:adId/review', requireAdmin, requireAdminCsrf, asyncRoute(async (req, res) => {
  const status = asEnum(req.body?.status, 'وضعیت', ['active', 'rejected', 'paused', 'completed']);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 255) : '';
  const result = adStoreKind() === 'demo'
    ? await contentStore().reviewAdCampaign(req.params.adId, { status, note })
    : await adPlatform.reviewCampaign(req.params.adId, { status, note });
  await query(
    "INSERT INTO admin_events (kind, title, detail, ad_public_id) VALUES ('ad', :title, :detail, :adPublicId)",
    { adPublicId: req.params.adId, title: `کمپین ${status === 'active' ? 'تأیید' : status === 'rejected' ? 'رد' : status} شد`, detail: note || req.params.adId },
  ).catch(() => {});
  res.json(result);
}));

/**
 * Owner campaigns bypass the wallet entirely: the owner is the platform, so no
 * balance is reserved and the campaign is created active (still subject to the
 * per-placement on/off switch and the dates).
 */
app.post('/api/admin/ads/campaigns', requireAdmin, requireAdminCsrf, upload.single('creative'), asyncRoute(async (req, res) => {
  let retainUpload = false;
  try {
  const appUrl = String(process.env.APP_URL || '').replace(/\/$/, '');
  const payload = {
    campaignName: req.body?.campaignName,
    bidMultiplier: req.body?.bidMultiplier,
    placements: req.body?.placements,
    landingMode: req.body?.landingMode,
    telegramPostText: req.body?.telegramPostText,
    telegramClickMode: req.body?.telegramClickMode,
    headline: req.body?.headline,
    body: req.body?.body,
    placement: req.body?.placement,
    targetUrl: req.body?.targetUrl,
    durationSeconds: req.body?.durationSeconds,
    budget: req.body?.budget,
    startsAt: req.body?.startsAt,
    endsAt: req.body?.endsAt,
    creativeUrl: req.body?.creativeUrl,
    creativeLocalPath: req.file ? req.file.filename : null,
  };
  if (req.file) {
    const placementType = adSettingsLib.placementMeta(parsePlacements(payload)[0]).asset;
    const matches = (placementType === 'video' && req.file.mimetype.startsWith('video/')) || (placementType === 'image' && req.file.mimetype.startsWith('image/'));
    if (!matches) throw new AppError(422, 'CREATIVE_TYPE_MISMATCH', 'فایل با نوع جایگاه انتخاب‌شده سازگار نیست.');
  }
  if (req.file) payload.creativeUrl = `${appUrl}/uploads/${encodeURIComponent(req.file.filename)}`;
  const created = adStoreKind() === 'demo'
    ? await contentStore().createOwnerAdCampaign(payload)
    : await adPlatform.createOwnerCampaign(payload);
  retainUpload = true;
  await query(
    "INSERT INTO admin_events (kind, title, detail, ad_public_id) VALUES ('ad', 'کمپین مالک ساخته شد', :detail, :adPublicId)",
    { detail: String(payload.campaignName || ''), adPublicId: created.id },
  ).catch(() => {});
  res.status(201).json({ campaign: created });
  } finally {
    if (req.file && !retainUpload) await fs.promises.unlink(req.file.path).catch(() => {});
  }
}));

app.get('/api/admin/ads', requireAdmin, asyncRoute(async (_req, res) => {
  if (contentStore().kind === 'demo') {
    res.json({ items: await contentStore().listAds() });
    return;
  }
  const rows = await query(
    `SELECT a.public_id, a.campaign_name, a.headline, a.placement, a.budget, a.status,
            a.created_at, u.account_name
     FROM ads a JOIN users u ON u.id = a.advertiser_id
     WHERE a.deleted_at IS NULL
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
app.get('/owner-console/styles.css', requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/css').sendFile(path.join(privateDirectory, 'admin.css'));
});

/**
 * Preview sign-in. Only exists when the in-memory demo store is enabled outside
 * production, so a real deployment can never hand out an owner session.
 */
app.get('/owner-console/demo-login', asyncRoute(async (_req, res) => {
  const demoEnabled = process.env.DEMO_DATA === '1' && !isProduction;
  if (!demoEnabled) throw new AppError(404, 'NOT_FOUND', 'صفحه پیدا نشد.');
  const ownerId = [...ownerIds()][0] || 'demo';
  const csrfToken = generateOpaqueToken(24);
  res.cookie('filmwork_admin', signAdminToken(ownerId, csrfToken), {
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    maxAge: 2 * 60 * 60 * 1000,
    path: '/',
  });
  res.redirect(303, '/owner-console');
}));

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
  } else if (/^\/api\/advertiser(?:\/|$)/.test(req.path) && ['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR'].includes(error?.code)) {
    // Do not hide the original database error from operators or expose SQL to clients.
    console.error(`[${req.requestId}] Advertiser schema error`, error);
    normalized = new AppError(503, 'AD_SCHEMA_UNAVAILABLE', 'ساختار پایگاه دادهٔ تبلیغات کامل نیست؛ با پشتیبانی سایت تماس بگیرید.');
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
let deletionTimer;
let deletionRunning = false;
// Set by the hosting entry point (app.js) when it already owns the listening port.
const hooks = { listenOnceReady: null };
let botRetryTimer;
let processGuardsInstalled = false;
let shuttingDown = false;
let botsStarting = false;
const botStatus = { authentication: 'pending', administration: 'pending', download: 'pending', lastError: null, leader: false };
const botServices = [authBotService, adminBotService, downloadBotService];
const botLeader = new BotLeader(pool, async (error) => {
  botStatus.leader = false;
  botStatus.lastError = `Telegram leader lock lost: ${error.message}`;
  console.error(botStatus.lastError);
  await Promise.allSettled(botServices.map((service) => service.stop('leader-lock-lost')));
  if (!shuttingDown) scheduleBotRetry();
});
for (const [index, service] of botServices.entries()) {
  const key = ['authentication', 'administration', 'download'][index];
  service.onPollingStopped = (error) => {
    botStatus[key] = 'failed';
    botStatus.lastError = String(error?.message || error).slice(0, 500);
    console.error(`Telegram bot (${key}) polling stopped:`, error);
    service.stop('polling-stopped').catch((stopError) => console.error('Bot cleanup failed:', stopError));
    if (!shuttingDown) scheduleBotRetry();
  };
}

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
  for (const key of ['authentication', 'administration', 'download']) {
    if (botStatus[key] === 'pending') botStatus[key] = 'starting';
  }
  try {
    if (!await botLeader.acquire()) {
      botStatus.leader = false;
      for (const key of ['authentication', 'administration', 'download']) botStatus[key] = 'standby';
      if (!shuttingDown) scheduleBotRetry();
      return;
    }
    if (shuttingDown) return;
    botStatus.leader = true;
    // Only start what is not already polling: launching the same token twice makes
    // Telegram answer 409 Conflict and kills the bot that was working.
    const pending = [];
    if (!authBotService.started && authBotService.bot === null) pending.push(['authentication', authBotService]);
    if (!adminBotService.started && adminBotService.bot === null) pending.push(['administration', adminBotService]);
    if (!downloadBotService.started && downloadBotService.bot === null) pending.push(['download', downloadBotService]);
    if (!pending.length) {
      botStatus.authentication = authBotService.started ? 'started' : botStatus.authentication;
      botStatus.administration = adminBotService.started ? 'started' : botStatus.administration;
      botStatus.download = downloadBotService.started ? 'started' : botStatus.download;
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
  } catch (error) {
    botStatus.lastError = `Telegram coordination error: ${error.message}`;
    console.error(botStatus.lastError);
    if (!shuttingDown) scheduleBotRetry();
  } finally {
    botsStarting = false;
  }
}

function scheduleBotRetry() {
  if (botRetryTimer || shuttingDown) return;
  const retrySeconds = Number(process.env.BOT_RETRY_SECONDS || 10);
  const delayMs = Math.max(5, Math.min(30, Number.isFinite(retrySeconds) ? retrySeconds : 10)) * 1000;
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
  // The in-memory demo store exists precisely because a review machine has no MySQL.
  if (process.env.DEMO_DATA === '1') {
    await healthCheck().catch((error) => {
      console.warn('DEMO_DATA=1: starting without a reachable database.', error.message);
    });
  } else {
    await healthCheck();
  }
  await settleExpiredCampaigns().catch((error) => {
    console.error('Initial campaign settlement failed (continuing):', error);
  });
  if (!campaignSettlementTimer) {
    campaignSettlementTimer = setInterval(() => {
      settleExpiredCampaigns().catch((error) => console.error('Expired campaign settlement failed', error));
      if (contentStore().kind !== 'demo') {
        adPlatform.purgeRejectedCreatives().catch((error) => console.error('Rejected creative purge failed', error));
      }
    }, 5 * 60_000);
    campaignSettlementTimer.unref?.();
  }
  if (process.env.DEMO_DATA !== '1' && !deletionTimer) {
    const runDeletions = async () => {
      if (deletionRunning || shuttingDown) return;
      deletionRunning = true;
      try { await processDeletions(); }
      catch (error) { console.error('Telegram deletion worker failed:', error.message); }
      finally { deletionRunning = false; }
    };
    runDeletions();
    deletionTimer = setInterval(runDeletions, 30_000);
    deletionTimer.unref?.();
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
  if (deletionTimer) clearInterval(deletionTimer);
  if (botRetryTimer) clearTimeout(botRetryTimer);
  await Promise.allSettled([
    authBotService.stop(signal),
    adminBotService.stop(signal),
    downloadBotService.stop(signal),
  ]);
  await botLeader.close();
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

module.exports = { app, start, shutdown, botStatus, numberFromEnv, hooks, contentDto };
