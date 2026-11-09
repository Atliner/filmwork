'use strict';

/**
 * Validation and normalisation for owner-entered content.
 *
 * The console posts a wide payload (two titles, series state, gallery, versions).
 * Every field is coerced here so the store only ever sees clean values, and the
 * same rules apply to create and update.
 */

const { AppError } = require('./errors');
const { asEnum, asHttpUrl, asString, asPositiveNumber } = require('./validation');
const { parseContentPost, buildVersionSuggestions, normalizeDigits } = require('./postParser');

function fail(field) {
  throw new AppError(422, 'VALIDATION_ERROR', `${field} نامعتبر است.`);
}

function optionalText(value, max, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length > max) fail(field);
  return text;
}

function listOf(value, maxItems, field) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[,،؛;|\n]+/u);
  const items = raw
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (items.length > maxItems) fail(field);
  return [...new Set(items.map((item) => item.slice(0, 120)))];
}

function optionalYear(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const year = Number(normalizeDigits(String(value)).replace(/[^\d]/g, ''));
  if (!Number.isInteger(year) || year < 1888 || year > 2200) fail(field);
  return year;
}

function optionalInt(value, field, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(normalizeDigits(String(value)).replace(/[^\d]/g, ''));
  if (!Number.isInteger(number) || number < min || number > max) fail(field);
  return number;
}

function optionalScore(value) {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(String(value).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(score) || score < 0 || score > 10) fail('امتیاز IMDb');
  return Number(score.toFixed(1));
}

function optionalUrl(value, field, { httpsOnly = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return asHttpUrl(String(value).trim(), field, { httpsOnly });
}

function uniqUrls(values) {
  return [...new Set(values.filter(Boolean))].slice(0, 30);
}

/**
 * @param {object} body raw JSON body from the console
 * @param {{ statuses?: string[] }} options
 */
function normalizeContentPayload(body = {}, options = {}) {
  const contentType = asEnum(body.contentType || 'movie', 'نوع اثر', ['movie', 'series']);
  const titleFa = optionalText(body.titleFa, 255, 'عنوان فارسی');
  const titleEn = optionalText(body.titleEn, 255, 'عنوان انگلیسی');
  if (!titleFa && !titleEn) {
    throw new AppError(422, 'VALIDATION_ERROR', 'حداقل یکی از عنوان فارسی یا انگلیسی لازم است.');
  }

  const statuses = options.statuses || ['draft', 'published'];
  const status = asEnum(body.status || 'draft', 'وضعیت', statuses);
  const releaseYear = optionalYear(body.releaseYear, 'سال تولید');
  const lastAirYear = contentType === 'series' ? optionalYear(body.lastAirYear, 'سال آخرین فصل') : null;
  if (lastAirYear && releaseYear && lastAirYear < releaseYear) fail('سال آخرین فصل');

  const seriesRunning = contentType === 'series' ? Boolean(body.seriesRunning) : false;
  const currentSeason = seriesRunning ? optionalInt(body.currentSeason, 'فصل در حال پخش', 1, 100) : null;
  let broadcastNote = seriesRunning ? optionalText(body.broadcastNote, 120, 'متن وضعیت پخش') : null;
  if (seriesRunning && !broadcastNote) {
    broadcastNote = `فصل ${String(currentSeason || 1).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])} — هر هفته قسمت جدید`;
  }

  const gallery = uniqUrls((Array.isArray(body.posterGallery) ? body.posterGallery : [])
    .map((item) => (typeof item === 'string' ? item : item?.url))
    .map((url) => optionalUrl(url, 'تصویر گالری')));

  return {
    contentType,
    titleFa: titleFa || titleEn,
    titleEn: titleEn || titleFa,
    description: optionalText(body.description, 20_000, 'توضیحات'),
    releaseYear,
    lastAirYear,
    seriesRunning,
    currentSeason,
    seasonCount: contentType === 'series' ? optionalInt(body.seasonCount, 'تعداد فصل', 1, 100) : null,
    episodeCount: contentType === 'series' ? optionalInt(body.episodeCount, 'تعداد قسمت', 1, 5000) : null,
    broadcastNote,
    genres: listOf(body.genres, 12, 'ژانرها'),
    directors: listOf(body.directors, 12, 'کارگردان'),
    castMembers: listOf(body.cast ?? body.castMembers, 40, 'بازیگران'),
    countries: listOf(body.countries ?? body.country, 8, 'کشور'),
    network: optionalText(body.network, 120, 'شبکه'),
    ageRating: optionalText(body.ageRating, 20, 'رده سنی'),
    imdbScore: optionalScore(body.imdbScore),
    runtimeMinutes: optionalInt(body.runtimeMinutes, 'مدت', 1, 1200),
    hasDub: Boolean(body.hasDub),
    hasSub: Boolean(body.hasSub),
    posterUrl: optionalUrl(body.posterUrl, 'لینک پوستر'),
    posterGallery: gallery,
    backdropUrl: optionalUrl(body.backdropUrl, 'تصویر پس‌زمینه'),
    trailerUrl: optionalUrl(body.trailerUrl, 'لینک تریلر'),
    streamUrl: optionalUrl(body.streamUrl, 'لینک پخش'),
    featuredHero: Boolean(body.featuredHero),
    status,
    source: {
      type: body.sourceType === 'telegram_link' ? 'telegram_link' : body.sourceType === 'text' ? 'text' : null,
      url: optionalUrl(body.sourceUrl, 'لینک منبع'),
    },
    versions: normalizeVersions(body.versions, contentType),
  };
}

function normalizeVersions(raw, contentType) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map((version, index) => {
    const kind = version?.kind === 'dub' ? 'dub' : 'sub';
    const title = optionalText(version?.title, 120, 'عنوان نسخه') || 'نسخه';
    const resolution = optionalText(version?.resolution, 24, 'کیفیت');
    const links = (Array.isArray(version?.links) ? version.links : []).slice(0, 600).map((link) => ({
      season: optionalInt(link?.season, 'فصل', 1, 100),
      episode: optionalInt(link?.episode, 'قسمت', 1, 5000),
      title: optionalText(link?.title, 255, 'عنوان قسمت'),
      label: optionalText(link?.label, 80, 'برچسب'),
      sizeText: optionalText(link?.sizeText, 60, 'حجم'),
      streamUrl: optionalUrl(link?.streamUrl, 'لینک پخش آنلاین'),
      subtitleUrl: optionalUrl(link?.subtitleUrl, 'لینک زیرنویس'),
      dubUrl: optionalUrl(link?.dubUrl, 'لینک دوبله'),
      telegramUrl: optionalUrl(link?.telegramUrl, 'لینک تلگرام'),
      source: link?.source === 'telegram_bot' ? 'telegram_bot' : 'manual',
    }));
    if (contentType === 'movie' && links.length > 8) {
      throw new AppError(422, 'VALIDATION_ERROR', 'برای فیلم حداکثر ۸ لینک در هر نسخه مجاز است.');
    }
    return { kind, title, resolution, sortOrder: index, links };
  });
}

/**
 * Merges a stored content record with the fields the console actually changed.
 *
 * The console sends either a full form or a one-field patch (status toggle, hero
 * flag), and both must pass through the same validator without wiping metadata that
 * the form did not include.
 */
function updateContentPayload(existing, patch = {}) {
  const base = existing?.content || {};
  const pick = (key, fallback) => (patch[key] === undefined ? fallback : patch[key]);
  const merged = {
    contentType: pick('contentType', pick('type', base.type)),
    titleFa: pick('titleFa', base.title),
    titleEn: pick('titleEn', base.originalTitle),
    description: pick('description', base.description),
    releaseYear: pick('releaseYear', base.releaseYear),
    lastAirYear: pick('lastAirYear', base.lastAirYear),
    seriesRunning: pick('seriesRunning', base.seriesRunning),
    currentSeason: pick('currentSeason', base.currentSeason),
    broadcastNote: pick('broadcastNote', base.broadcastNote),
    seasonCount: pick('seasonCount', base.seasons),
    episodeCount: pick('episodeCount', base.episodes),
    genres: pick('genres', base.genres),
    directors: pick('directors', base.directors),
    cast: pick('cast', base.cast),
    countries: pick('countries', base.countries),
    network: pick('network', base.network),
    ageRating: pick('ageRating', base.ageRating),
    imdbScore: pick('imdbScore', base.imdbScore),
    runtimeMinutes: pick('runtimeMinutes', base.runtimeMinutes),
    hasDub: pick('hasDub', base.hasDub),
    hasSub: pick('hasSub', base.hasSub),
    posterUrl: pick('posterUrl', base.posterUrl),
    posterGallery: pick('posterGallery', base.posterGallery),
    backdropUrl: pick('backdropUrl', base.backdropUrl),
    trailerUrl: pick('trailerUrl', base.trailerUrl),
    streamUrl: pick('streamUrl', base.streamUrl),
    featuredHero: pick('featuredHero', base.featuredHero),
    status: pick('status', base.status),
    sourceType: patch.sourceType,
    sourceUrl: patch.sourceUrl,
    versions: pick('versions', existing?.versions),
  };
  return normalizeContentPayload(merged, { statuses: ['draft', 'published', 'archived'] });
}

/**
 * Reads a Telegram post or link through the shared parser and returns a ready-to-edit
 * draft. Never writes to the database: the owner confirms the result first.
 */
async function buildParseDraft({ text, link }) {
  let sourceText = String(text || '').trim();
  let sourceLabel = 'text';
  let resolvedLink = null;

  if (link) {
    const { fetchPublicTelegramPost } = require('../bots/adminBot');
    resolvedLink = asHttpUrl(link, 'لینک پست تلگرام', {});
    const fetched = await fetchPublicTelegramPost(resolvedLink);
    if (!sourceText) sourceLabel = 'telegram_link';
    sourceText = sourceText || fetched;
  }
  if (!sourceText) {
    throw new AppError(422, 'EMPTY_SOURCE', 'متن یا لینک پست را وارد کنید.');
  }

  const { fields, meta } = parseContentPost(sourceText);
  const suggestedVersions = buildVersionSuggestions(fields);
  return {
    source: { label: sourceLabel, url: resolvedLink, textLength: sourceText.length },
    fields: {
      contentType: fields.contentType,
      titleFa: fields.titleFa,
      titleEn: fields.titleEn,
      description: fields.description,
      releaseYear: fields.releaseYear,
      lastAirYear: fields.lastAirYear,
      seriesRunning: fields.seriesRunning,
      currentSeason: fields.currentSeason,
      broadcastNote: fields.broadcastNote,
      episodeCount: fields.episodeCount,
      seasonCount: fields.seasonCount,
      genres: fields.genres,
      directors: fields.directors,
      cast: fields.cast,
      countries: fields.countries,
      network: fields.network,
      ageRating: fields.ageRating,
      imdbScore: fields.imdbScore,
      runtimeMinutes: fields.runtimeMinutes,
      hasDub: fields.hasDub,
      hasSub: fields.hasSub,
      posterUrl: fields.posterUrl || null,
      streamUrl: fields.streamUrl || null,
      qualities: fields.qualities,
      telegramLinks: fields.telegramLinks,
    },
    versions: suggestedVersions,
    meta,
  };
}

module.exports = {
  normalizeContentPayload,
  updateContentPayload,
  buildParseDraft,
  listOf,
  optionalUrl,
  optionalScore,
  optionalYear,
  optionalInt,
  asPositiveNumber,
  asString,
};
