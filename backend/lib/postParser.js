'use strict';

/**
 * Turns a Persian/English movie-channel Telegram post into structured metadata.
 *
 * The owner pastes either the post text or a public `t.me/...` link into the console.
 * A single rigid format never survives real channels, so this parser is built around
 * label synonyms (left side of `:`), free-form heuristics (right side), and a
 * confidence report so the console can highlight what still needs the owner's eye.
 */

const DIGIT_MAP = Object.freeze({
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
});

function normalizeDigits(value = '') {
  return String(value).replace(/[۰-۹٠-٩]/g, (digit) => DIGIT_MAP[digit] || digit);
}

function toFaDigits(value) {
  return String(value ?? '').replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
}

const PERSIAN_RANGE = /[\u0600-\u06FF]/;
const LATIN_RANGE = /[A-Za-z]/;

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{2300}-\u{23FF}\u{FE0F}\u{2190}-\u{21FF}]/gu;
// Bullets and pictographs a channel puts in front of a label: `▪️ نام فارسی:`.
const LEADING_SYMBOLS = /^[\s\p{So}\p{Sk}\p{Mn}\u200d\u20e3]+/u;

function clean(value) {
  return String(value || '')
    .replace(/\u200f|\u200e|\u202a|\u202b|\u202c/g, '')
    .replace(EMOJI, '')
    .replace(LEADING_SYMBOLS, '')
    .replace(/^[#*\s]+/, '')
    .replace(/^[\s|•·,،:：\-–—]+/, '')
    .replace(/[\s|•·,،:：\-–—]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function splitList(value, limit = 24) {
  return clean(value)
    .split(/\s*(?:[,،؛;|/]|\s+و\s+)\s*/u)
    .map((item) => clean(item))
    .filter((item) => item && item.length <= 80)
    .slice(0, limit);
}

/** Longest-first alias matching keeps `امتیاز IMDb` from being read by `امتیاز`. */
const FIELDS = [
  {
    key: 'titleFa',
    aliases: ['عنوان فارسی', 'نام فارسی', 'عنوان فیلم', 'عنوان سریال', 'نام فیلم', 'نام سریال', 'عنوان', 'نام', 'title', 'name'],
    kind: 'text',
  },
  { key: 'titleEn', aliases: ['عنوان انگلیسی', 'نام انگلیسی', 'عنوان اصلی', 'نام اصلی', 'english title', 'original title'], kind: 'text' },
  { key: 'contentType', aliases: ['نوع', 'نوع اثر', 'نوع محتوا', 'type', 'kind'], kind: 'type' },
  { key: 'firstAirYear', aliases: ['سال شروع', 'سال آغاز', 'سال شروع پخش', 'سال ساخت', 'سال تولید', 'سال انتشار', 'سال', 'release year', 'first air year', 'year'], kind: 'year' },
  { key: 'lastAirYear', aliases: ['سال آخرین فصل', 'سال پایان', 'سال اتمام', 'سال آخر', 'last air year', 'end year', 'final year'], kind: 'year' },
  { key: 'currentSeason', aliases: ['فصل در حال پخش', 'فصل جاری', 'فصل', 'current season', 'season'], kind: 'number' },
  { key: 'broadcastStatus', aliases: ['وضعیت پخش', 'وضعیت', 'وضعیت اکران', 'status', 'broadcast status'], kind: 'text' },
  { key: 'broadcastNote', aliases: ['متن دلخواه', 'متن وضعیت', 'یادداشت پخش', 'broadcast note', 'status note'], kind: 'text' },
  { key: 'genres', aliases: ['ژانرها', 'ژانر', 'گونه', 'دسته‌بندی', 'genres', 'genre'], kind: 'list' },
  { key: 'directors', aliases: ['کارگردانان', 'کارگردان', 'کارگردان‌ها', 'directors', 'director'], kind: 'list' },
  { key: 'cast', aliases: ['بازیگران', 'بازیگر', 'ستارگان', 'cast', 'actors', 'stars'], kind: 'list' },
  { key: 'countries', aliases: ['کشورها', 'کشور تولید', 'کشور سازنده', 'محصول کشور', 'کشور محصول', 'کشور', 'محصول', 'country', 'countries'], kind: 'list' },
  { key: 'ageRating', aliases: ['رده سنی', 'رده‌بندی سنی', 'رده‌بندی', 'age rating', 'rated', 'certificate'], kind: 'text' },
  { key: 'network', aliases: ['شبکه', 'پلتفرم', 'اکران', 'network', 'platform', 'studio', 'channel'], kind: 'text' },
  { key: 'imdbScore', aliases: ['امتیاز imdb', 'امتیاز آی‌ام‌دی‌بی', 'امتیاز IMDb', 'imdb', 'imdb rating', 'imdb score', 'rating', 'score'], kind: 'score' },
  { key: 'runtimeMinutes', aliases: ['مدت زمان', 'مدت', 'زمان', 'runtime', 'duration', 'length'], kind: 'runtime' },
  { key: 'qualities', aliases: ['کیفیت‌ها', 'کیفیت ها', 'کیفیت‌های موجود', 'کیفیت موجود', 'quality', 'qualities', 'resolutions'], kind: 'qualities' },
  { key: 'description', aliases: ['خلاصه داستان', 'خلاصه', 'داستان', 'توضیحات', 'معرفی', 'synopsis', 'plot', 'summary', 'description', 'story'], kind: 'long' },
];

const ALIAS_LOOKUP = (() => {
  const entries = [];
  for (const field of FIELDS) {
    for (const alias of field.aliases) {
      entries.push({ key: field.key, kind: field.kind, alias: alias.toLowerCase() });
    }
  }
  // Longest alias wins: `امتیاز IMDb` must be tried before `امتیاز`.
  return entries.sort((a, b) => b.alias.length - a.alias.length);
})();

/** Label aliases are matched on the longest-first list above, never guessed mid-line. */
function labelEntry(rawLabel) {
  const label = normalizeDigits(String(rawLabel || ''))
    .toLowerCase()
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ALIAS_LOOKUP.find((candidate) => candidate.alias === label) || null;
}

/**
 * Extracts `label: value` from one line. The value keeps its own punctuation
 * (`ژانر: درام | جنایی`, `متن: فصل ۲ — هر جمعه`), so separators inside the value
 * are never mistaken for the label delimiter.
 */
function labelOf(line) {
  const text = normalizeDigits(clean(line)).replace(LEADING_SYMBOLS, '');
  if (!text || text.length > 400) return null;
  const candidates = [
    /^([^:：]{1,40})[:：]\s*([\s\S]*)$/u,
    /^([^|]{1,40}?)\s*\|\s+([\s\S]*)$/u,
    /^([^–—]{1,40}?)\s+[–—]\s+([\s\S]*)$/u,
  ];
  for (const expression of candidates) {
    const match = text.match(expression);
    if (!match) continue;
    const entry = labelEntry(match[1]);
    if (entry) {
      return { key: entry.key, kind: entry.kind, value: clean(match[2]), label: clean(match[1]) };
    }
  }
  const aliasOnly = labelEntry(text);
  return aliasOnly ? { key: aliasOnly.key, kind: aliasOnly.kind, value: '', label: text } : null;
}

function normalizeContentType(value, fullText) {
  const explicit = String(value || '');
  if (/سریال|series|season|فصل|episode|قسمت/i.test(explicit)) return 'series';
  if (/فیلم|movie|film/i.test(explicit)) return 'movie';
  const body = String(fullText || '');
  // Channel posts open with `🎬 #سریال | ...`: the hashtag is the strongest signal.
  if (/#(?:سریال|series)\b/iu.test(body)) return 'series';
  if (/#(?:فیلم|movie|film)\b/iu.test(body)) return 'movie';
  if (/(?:^|\n)\s*(?:فصل|season)\s*\d|S\d{1,2}\s*[.\-]?\s*E\d{1,3}/iu.test(body)) return 'series';
  if (/سریال/iu.test(body)) return 'series';
  return 'movie';
}

function parseYear(value) {
  const match = normalizeDigits(String(value || '')).match(/((?:18|19|20|21)\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1888 && year <= 2200 ? year : null;
}

function parseScore(value) {
  const match = normalizeDigits(String(value || '')).match(/(\d{1,2}(?:[.,]\d{1,2})?)/);
  if (!match) return null;
  const score = Number(match[1].replace(',', '.'));
  return Number.isFinite(score) && score >= 0 && score <= 10 ? Number(score.toFixed(1)) : null;
}

function parseRuntime(value) {
  const text = normalizeDigits(String(value || ''));
  const hourMatch = text.match(/(\d{1,2})\s*(?:ساعت|hours?|hrs?|h\b)/i);
  let minuteMatch = text.match(/(\d{1,3})\s*(?:دقیقه|mins?|minutes?)/i);
  if (!minuteMatch && !hourMatch) minuteMatch = text.match(/(\d{1,3})/);
  const minutes = (hourMatch ? Number(hourMatch[1]) * 60 : 0) + (minuteMatch ? Number(minuteMatch[1]) : 0);
  return minutes > 0 && minutes < 1200 ? minutes : null;
}

function parseQualities(value, fullText) {
  const out = [];
  const push = (token) => {
    const label = clean(String(token)).toLowerCase().replace(/\s+/g, '');
    const normalized = label === '4k' || label === 'uhd' ? '2160p' : label;
    if (/^\d{3,4}p$/.test(normalized) && !out.includes(normalized)) out.push(normalized);
  };
  for (const match of String(value || '').matchAll(/\b(2160p|1440p|1080p|720p|480p|360p|4k|uhd)\b/gi)) push(match[1]);
  for (const match of String(fullText || '').matchAll(/\b(2160p|1440p|1080p|720p|480p|360p|4k|uhd)\b/gi)) push(match[1]);
  return out.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
}

function detectDubSub(text) {
  const value = String(text || '');
  const hasDub = /دوبله|دوبلوره|dubbed|دوبله\s*فارسی/iu.test(value);
  const hasSub = /زیرنویس|هارد\s*ساب|سافت\s*ساب|hardsub|softsub|subtitle|subbed/iu.test(value);
  return { hasDub, hasSub };
}

/** @returns {boolean|null} `null` means the post says nothing about the schedule. */
function detectSeriesRunning(text) {
  const value = String(text || '');
  if (!value.trim()) return null;
  // Explicit endings win: "پخش فصل ۲ پایان یافته" must not read as "in progress".
  if (/پایان\s*یافته|اتمام|تمام\s*شده|پخش\s*(?:آن\s*)?(?:به\s*)?پایان|ended|finished|complete/iu.test(value)) return false;
  if (/در\s*حال\s*پخش|در\s*حال\s*نمایش|در\s*حال\s*انتشار|ongoing|continuing|airing(?:\s*now)?/iu.test(value)) return true;
  return null;
}

/** Splits `The Pitt | پیت` (or the reverse order) into English and Persian titles. */
function splitTitlePair(value) {
  const text = clean(value);
  if (!text) return { titleFa: '', titleEn: '' };
  const pieces = text.split(/\s*[|｜/•]\s*|\s+-\s+/u).map(clean).filter(Boolean);
  if (pieces.length >= 2) {
    const persian = pieces.find((piece) => PERSIAN_RANGE.test(piece) && !LATIN_RANGE.test(piece));
    const latin = pieces.find((piece) => LATIN_RANGE.test(piece));
    if (persian || latin) {
      return { titleFa: persian || '', titleEn: latin || clean(pieces.find((piece) => piece !== persian) || '') };
    }
    return { titleFa: pieces[0], titleEn: pieces.slice(1).join(' ') };
  }
  if (PERSIAN_RANGE.test(text) && LATIN_RANGE.test(text)) {
    // One line holding both scripts, e.g. `The Pitt پیت`.
    const persian = text.match(/[\u0600-\u06FF][\u0600-\u06FF\s\u200c]*/u)?.[0];
    const latin = text.match(/[A-Za-z0-9][A-Za-z0-9\s:,'.&!?\-–]*/u)?.[0];
    return {
      titleFa: clean(persian || ''),
      titleEn: clean((latin || text.replace(persian || '', '')).replace(/\s{2,}/g, ' ')),
    };
  }
  return PERSIAN_RANGE.test(text)
    ? { titleFa: text, titleEn: '' }
    : { titleFa: '', titleEn: text };
}

const NOISE_LINE = /^(?:https?:\/\/|t\.me\/|@|#|👇|➖|—|–|-{2,})/u;

function looksLikeTitleLine(line) {
  const text = clean(line);
  if (!text || text.length < 2 || text.length > 120) return false;
  if (NOISE_LINE.test(text) && !/^#/.test(text)) return false;
  if (/\b(?:ساعت|دقیقه|قسمت|فصل|امتیاز|کیفیت)\b/u.test(text)) return false;
  // Footers every channel posts: "برای دانلود کلیک کنید", "@channel", "ادمین".
  if (/دانلود|کلیک|کانال|عضو\s*شوید|ادمین|تبلیغ|join|download|click/iu.test(text)) return false;
  if (/^@/.test(text)) return false;
  return PERSIAN_RANGE.test(text) || LATIN_RANGE.test(text);
}

/**
 * Parses a channel post.
 * @param {string} rawText
 * @returns {{fields: object, meta: {found: string[], missing: string[], confidence: number, notes: string[]}}}
 */
function parseContentPost(rawText) {
  const raw = String(rawText || '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) {
    return { fields: {}, meta: { found: [], missing: [], confidence: 0, notes: ['متن ورودی خالی است.'] } };
  }

  const text = normalizeDigits(raw);
  const lines = text.split('\n').map((line) => line.trim());
  const values = {};
  const foundLabels = new Set();
  const leftovers = [];

  // Pass 1: labelled lines. Long descriptions swallow the following lines.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const parsed = labelOf(line);
    if (!parsed) {
      leftovers.push(line);
      continue;
    }
    foundLabels.add(parsed.key);
    if (parsed.kind === 'long' && !parsed.value) {
      const buffer = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (labelOf(lines[next])) break;
        if (lines[next]) buffer.push(lines[next]);
        index = next;
      }
      values.description = clean(buffer.join('\n'));
      continue;
    }
    values[parsed.key] = parsed.value;
  }

  const flat = text.replace(/\n+/g, '\n');
  const notes = [];
  const fields = {};
  const missing = [];

  // --- Titles -------------------------------------------------------------
  let titleFa = clean(values.titleFa);
  let titleEn = clean(values.titleEn);
  if (!titleFa && !titleEn) {
    const titled = values.title || values.name;
    const titleFromHashtag = text.match(/(?:^|\n)\s*#([^\s#]{3,80})/u)?.[1];
    const candidates = [titled, ...leftovers.filter(looksLikeTitleLine), titleFromHashtag]
      .map((candidate) => clean(candidate))
      .filter(Boolean);
    const first = candidates.find((candidate) => /\s|[A-Za-z]|[\u0600-\u06FF]/.test(candidate));
    if (first) {
      const pair = splitTitlePair(first);
      titleFa = pair.titleFa;
      titleEn = pair.titleEn;
    }
  } else {
    const pair = splitTitlePair(titleEn || titleFa);
    if (!titleEn && pair.titleEn) titleEn = pair.titleEn;
    if (!titleFa && pair.titleFa) titleFa = pair.titleFa;
  }
  fields.titleFa = titleFa;
  fields.titleEn = titleEn;
  if (!titleFa && !titleEn) missing.push('عنوان');

  // --- Type / years / series state ---------------------------------------
  const inlineTitleHasSeries = /فیلم|movie/i.test(values.contentType || '');
  const bigYearRange = flat.match(/((?:18|19|20|21)\d{2})\s*[–—\-–]\s*((?:18|19|20|21)\d{2})?/u);
  const contentType = normalizeContentType(values.contentType, flat) || 'movie';
  fields.contentType = contentType && !inlineTitleHasSeries ? contentType : 'movie';

  const year = parseYear(values.firstAirYear) ?? parseYear(flat);
  const lastYear = parseYear(values.lastAirYear) ?? (bigYearRange?.[2] ? Number(bigYearRange[2]) : null);
  fields.releaseYear = year;
  fields.lastAirYear = fields.contentType === 'series' && lastYear && lastYear !== year ? lastYear : null;
  if (!year) missing.push('سال');

  if (fields.contentType === 'series') {
    // `وضعیت پخش: در حال پخش` is a status, not the free-form note: it only flips the switch.
    // The status field, when present, is authoritative: the post body also contains
    // the title and description, which may mention airing for unrelated reasons.
    const runningFromText = detectSeriesRunning(values.broadcastStatus)
      ?? detectSeriesRunning(flat);
    const currentSeasonMatch = normalizeDigits(flat).match(/(?:فصل|season)\s*(\d{1,2})/iu);
    const seasonLabelValue = normalizeDigits(values.currentSeason || '').match(/(\d{1,2})/)?.[1];
    fields.seriesRunning = runningFromText === null ? Boolean(values.currentSeason) : runningFromText;
    fields.broadcastStatus = clean(values.broadcastStatus) || null;
    fields.currentSeason = fields.seriesRunning
      ? Number(String(values.currentSeason || '').match(/\d{1,2}/)?.[0] || seasonLabelValue || currentSeasonMatch?.[1] || 1)
      : null;
    fields.broadcastNote = clean(values.broadcastNote) || (fields.seriesRunning
      ? `فصل ${toFaDigits(fields.currentSeason)} — هر هفته قسمت جدید`
      : '');
    if (fields.broadcastNote) fields.broadcastNote = fields.broadcastNote.replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
    const episodeCount = normalizeDigits(flat).match(/(?:قسمت|episode|ep)\s*(\d{1,4})/iu)?.[1];
    fields.episodeCount = episodeCount ? Number(episodeCount) : null;
    const totalSeasons = normalizeDigits(flat).match(/(?:مجموع|تعداد)\s*(?:فصل|season)\s*[:：]?\s*(\d{1,2})/u)?.[1];
    fields.seasonCount = totalSeasons ? Number(totalSeasons) : null;
  } else {
    fields.seriesRunning = false;
    fields.currentSeason = null;
    fields.broadcastNote = '';
  }

  // --- Lists and numbers --------------------------------------------------
  const genres = splitList(values.genres);
  if (!genres.length) {
    const hashtagGenres = [...text.matchAll(/#([\u0600-\u06FFA-Za-z][^\s#]{1,30})/gu)]
      .map((match) => clean(match[1]))
      .filter((tag) => !/^(فیلم|سریال|movie|series|دانلود|download|کانال|channel)$/iu.test(tag));
    const inlineGenre = leftovers.find((line) => /^(?:ژانر|genre)/iu.test(line));
    if (hashtagGenres.length >= 2) genres.push(...hashtagGenres.slice(0, 8));
    if (inlineGenre) genres.push(...splitList(inlineGenre.replace(/^(?:ژانر|genre)\s*[:：]?/iu, '')));
  }
  fields.genres = [...new Set(genres.filter((genre) => genre.length <= 40))].slice(0, 12);

  // Channel posts often list every name twice (Persian | English), so the caps are
  // generous rather than tuned to one language.
  fields.directors = splitList(values.directors, 24);
  fields.cast = splitList(values.cast, 60);
  fields.countries = splitList(values.countries, 8);
  fields.ageRating = clean(values.ageRating).slice(0, 20);
  fields.network = clean(values.network).slice(0, 120);
  fields.imdbScore = parseScore(values.imdbScore);
  fields.runtimeMinutes = parseRuntime(values.runtimeMinutes);

  if (fields.imdbScore === null) {
    const inlineScore = normalizeDigits(flat).match(/(?:imdb|امتیاز)\D{0,12}(\d{1,2}[.,]\d)/iu);
    if (inlineScore) fields.imdbScore = parseScore(inlineScore[1]);
  }

  // --- Description --------------------------------------------------------
  let description = clean(values.description || '');
  if (!description) {
    const bodyLine = leftovers.find((line) => line.length > 60 && !/https?:/u.test(line));
    description = bodyLine ? clean(bodyLine) : '';
  }
  fields.description = description.slice(0, 20_000);

  // --- Media hints --------------------------------------------------------
  fields.qualities = parseQualities(values.qualities, flat);
  const dubSub = detectDubSub(flat);
  fields.hasDub = dubSub.hasDub;
  fields.hasSub = dubSub.hasSub;
  fields.posterUrl = text.match(/https?:\/\/\S+\.(?:jpe?g|png|webp|avif)(?:\?\S*)?/iu)?.[0] || '';
  fields.streamUrl = text.match(/https?:\/\/\S+\.(?:mp4|m3u8|mkv)(?:\?\S*)?/iu)?.[0] || '';
  fields.telegramLinks = [...new Set([...text.matchAll(/https?:\/\/(?:t|telegram)\.me\/\S+/giu)].map((match) => match[0]))].slice(0, 12);

  // --- Report -------------------------------------------------------------
  const meaningful = ['titleFa', 'titleEn', 'releaseYear', 'genres', 'imdbScore', 'directors', 'cast', 'description'];
  const hits = meaningful.filter((key) => {
    const value = fields[key];
    return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '';
  });
  const confidence = Math.round((hits.length / meaningful.length) * 100);
  for (const [key, label] of [
    ['genres', 'ژانر'], ['imdbScore', 'امتیاز IMDb'], ['directors', 'کارگردان'],
    ['cast', 'بازیگران'], ['description', 'توضیحات'], ['posterUrl', 'پوستر'],
  ]) {
    const value = fields[key];
    if (Array.isArray(value) ? !value.length : !value) missing.push(label);
  }
  if (!foundLabels.size) notes.push('برچسب شناخته‌شده‌ای پیدا نشد؛ فیلدها با حدس متن پر شدند.');
  if (fields.contentType === 'series' && fields.broadcastStatus) {
    notes.push(`وضعیت پخش از پست: ${fields.broadcastStatus}`);
  }
  if (fields.contentType === 'series' && !fields.currentSeason && fields.seriesRunning) {
    notes.push('فصل در حال پخش تشخیص داده نشد؛ مقدار پیش‌فرض ۱ در نظر گرفته شد.');
  }

  return {
    fields,
    meta: {
      found: [...foundLabels],
      missing,
      confidence,
      notes,
    },
  };
}

/**
 * Suggests the per-quality version blocks the owner creates right after metadata.
 * @param {object} fields output of {@link parseContentPost}
 */
function buildVersionSuggestions(fields = {}) {
  const qualities = Array.isArray(fields.qualities) && fields.qualities.length
    ? fields.qualities
    : ['720p', '1080p'];
  // Subtitles are the default for this library; dubbing is only offered when the
  // post actually mentions it, so the owner never has to delete phantom versions.
  const kinds = ['sub'];
  if (fields.hasDub) kinds.push('dub');
  const versions = [];
  for (const kind of kinds) {
    for (const quality of qualities) {
      versions.push({
        kind,
        label: quality,
        resolution: quality,
        streamUrl: '',
        subtitleUrls: [],
        dubUrls: [],
        telegramUrls: [],
      });
    }
  }
  return versions;
}

module.exports = {
  normalizeDigits,
  toFaDigits,
  parseContentPost,
  buildVersionSuggestions,
  splitTitlePair,
  parseQualities,
  detectDubSub,
  detectSeriesRunning,
  parseScore,
  parseRuntime,
  clean,
};
