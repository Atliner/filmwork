'use strict';

/**
 * In-memory content store used **only** when `DEMO_DATA=1`.
 *
 * cPanel/Passenger deployments always run the MySQL store; this one exists so the
 * owner console can be reviewed (and screenshotted) on a machine without MySQL.
 * It keeps the exact same method contract and seeded data as the real installer.
 */

const crypto = require('crypto');
const { AppError, assert } = require('../lib/errors');
const { composeOverview } = require('./adminOverview');

function iso(daysAgo = 0, hours = 0) {
  return new Date(Date.now() - daysAgo * 86_400_000 - hours * 3_600_000).toISOString();
}

const SEED = [
  {
    titleFa: 'پیت', titleEn: 'The Pitt', type: 'series', status: 'published', featuredHero: true,
    releaseYear: 2026, lastAirYear: null, seriesRunning: true, currentSeason: 6,
    broadcastNote: 'فصل ۶ — هر جمعه قسمت جدید', seasonCount: 6, episodeCount: 34,
    imdbScore: 8.9, runtime: 50, network: 'HBO Max', country: 'آمریکا', age: 'TV-MA',
    genres: ['درام', 'پزشکی'], directors: ['R. Scott Gemmill'],
    cast: ['Noah Wyle', 'Tracy Ifeachor', 'Patrick Ball'],
    description: 'یک شیفت دوازده‌ساعته در اورژانس پیتسبورگ؛ پزشکان با کمبود نیرو، ازدحام بیمار و تصمیم‌های نفس‌گیر روبه‌رو می‌شوند.',
    poster: 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/pitt.jpg',
    views: 18420, daysAgo: 2, dub: true, sub: true, qualities: ['1080p', '720p', '480p'], mediaCount: 34,
  },
  {
    titleFa: 'اسب‌های آرام', titleEn: 'Slow Horses', type: 'series', status: 'published', featuredHero: false,
    releaseYear: 2022, lastAirYear: 2026, seriesRunning: true, currentSeason: 6,
    broadcastNote: 'فصل ۶ — هر جمعه قسمت جدید', seasonCount: 6, episodeCount: 34,
    imdbScore: 8.4, runtime: 45, network: 'Apple TV+', country: 'انگلستان', age: 'TV-MA',
    genres: ['جاسوسی', 'درام', 'کمدی سیاه'], directors: ['James Hawes', 'Saul Metzstein'],
    cast: ['Gary Oldman', 'Jack Lowden', 'Kristin Scott Thomas'],
    description: 'تیمی از جاسوس‌های سرخورده MI5 که در «اسلاو هاوس» زمین‌گیر شده‌اند، ناخواسته وارد پرونده‌ای ملی می‌شوند.',
    views: 9120, daysAgo: 5, dub: true, sub: true, qualities: ['1080p', '720p'], mediaCount: 34,
  },
  {
    titleFa: 'برادران', titleEn: 'Brothers', type: 'series', status: 'published', featuredHero: false,
    releaseYear: 2026, lastAirYear: null, seriesRunning: true, currentSeason: 1,
    broadcastNote: 'فصل ۱ در حال پخش', seasonCount: 1, episodeCount: 5,
    imdbScore: 7.2, runtime: 42, network: 'Netflix', country: 'آمریکا', age: 'PG-13',
    genres: ['اکشن', 'جنایی', 'درام'], directors: ['Max Winkler'],
    cast: ['Josh Brolin', 'Peter Dinklage', 'Glenn Close'],
    description: 'دو برادر با گذشته‌ای سیاه و مادری بیمار، برای یک سرقت آخر به هم می‌رسند.',
    views: 6340, daysAgo: 9, dub: false, sub: true, qualities: ['1080p', '720p', '480p'], mediaCount: 5,
  },
  {
    titleFa: 'فرقه', titleEn: 'The Order', type: 'series', status: 'published', featuredHero: false,
    releaseYear: 2025, lastAirYear: null, seriesRunning: true, currentSeason: 1,
    broadcastNote: 'فصل ۱ در حال پخش', seasonCount: 1, episodeCount: 4,
    imdbScore: 7.6, runtime: 55, network: 'Showtime', country: 'آمریکا', age: 'TV-MA',
    genres: ['ترسناک', 'معمایی'], directors: ['Tina Mabry'],
    cast: ['Jude Law', 'Nicholas Denton'],
    description: 'یک مأمور اف‌بی‌آی در پی ردی از یک فرقهٔ مذهبی رادیکال در شمال غرب آمریکا.',
    views: 4980, daysAgo: 12, dub: false, sub: true, qualities: ['1080p', '720p'], mediaCount: 4,
  },
  {
    titleFa: 'دون شماره دو', titleEn: 'Dune: Part Two', type: 'movie', status: 'published', featuredHero: false,
    releaseYear: 2024, imdbScore: 8.5, runtime: 166, network: 'Warner Bros.', country: 'آمریکا', age: 'PG-13',
    genres: ['علمی تخیلی', 'ماجراجویی', 'درام'], directors: ['Denis Villeneuve'],
    cast: ['Timothée Chalamet', 'Zendaya', 'Rebecca Ferguson', 'Austin Butler'],
    description: 'پل آتریدیز با فرمن‌ها متحد می‌شود تا از آراکیس دفاع کند و راه خود را در میان پیشگویی و انتقام پیدا کند.',
    views: 26890, daysAgo: 20, dub: true, sub: true, qualities: ['2160p', '1080p', '720p'], mediaCount: 6,
  },
  {
    titleFa: 'اوپنهایمر', titleEn: 'Oppenheimer', type: 'movie', status: 'published', featuredHero: false,
    releaseYear: 2023, imdbScore: 8.3, runtime: 180, network: 'Universal', country: 'آمریکا', age: 'R',
    genres: ['بیوگرافی', 'درام', 'تاریخی'], directors: ['Christopher Nolan'],
    cast: ['Cillian Murphy', 'Emily Blunt', 'Robert Downey Jr.'],
    description: 'زندگی رابرت اوپنهایمر و ساخت بمب اتم؛ درام تاریخی‌ای درباره قدرت، سیاست و وجدان.',
    views: 21460, daysAgo: 34, dub: true, sub: true, qualities: ['2160p', '1080p'], mediaCount: 4,
  },
  {
    titleFa: 'شهر متروکه', titleEn: 'Dead Town', type: 'movie', status: 'published', featuredHero: false,
    releaseYear: 2025, imdbScore: 6.4, runtime: 118, network: 'A24', country: 'کانادا', age: 'R',
    genres: ['ترسناک', 'هیجان‌انگیز'], directors: ['Emily Karr'],
    cast: ['Dev Patel', 'Anya Taylor-Joy'],
    description: 'گروهی از بازماندگان در شهری که هر شب فرو می‌ریزد، به دنبال راه خروج می‌گردند.',
    views: 3120, daysAgo: 41, dub: false, sub: true, qualities: ['1080p', '720p'], mediaCount: 2,
  },
  {
    titleFa: 'آخرین شب', titleEn: 'The Last Night', type: 'movie', status: 'draft', featuredHero: false,
    releaseYear: 2026, imdbScore: null, runtime: 104, network: '', country: 'فرانسه', age: 'PG-13',
    genres: ['درام'], directors: [], cast: [], description: 'پیش‌نویس؛ اطلاعات از پست تلگرام خوانده شده و در انتظار تکمیل است.',
    views: 0, daysAgo: 1, dub: false, sub: true, qualities: ['720p'], mediaCount: 0,
  },
  {
    titleFa: 'کوچ', titleEn: 'Migration', type: 'movie', status: 'archived', featuredHero: false,
    releaseYear: 2019, imdbScore: 7.1, runtime: 96, network: 'MUBI', country: 'آلمان', age: 'PG',
    genres: ['مستند', 'درام'], directors: ['Lena Hoffman'], cast: [],
    description: 'مستندی درباره سفر خانواده‌ای در مسیر بالکان.',
    views: 820, daysAgo: 96, dub: false, sub: false, qualities: [], mediaCount: 1,
  },
];

function posterFor(title) {
  const letters = encodeURIComponent(String(title).slice(0, 2));
  return `https://placehold.co/300x450/18181b/ffffff?text=${letters}`;
}

function buildState() {
  const contents = SEED.map((seed, index) => ({
    id: crypto.randomUUID(),
    internalId: String(index + 1),
    type: seed.type,
    title: seed.titleFa,
    originalTitle: seed.titleEn,
    description: seed.description,
    releaseYear: seed.releaseYear ?? null,
    lastAirYear: seed.lastAirYear ?? null,
    seriesRunning: Boolean(seed.seriesRunning),
    currentSeason: seed.currentSeason ?? null,
    broadcastNote: seed.broadcastNote ?? null,
    seasonCount: seed.seasonCount ?? null,
    episodeCount: seed.episodeCount ?? null,
    genres: seed.genres || [],
    directors: seed.directors || [],
    cast: seed.cast || [],
    countries: seed.country ? [seed.country] : [],
    network: seed.network || '',
    ageRating: seed.age || '',
    imdbScore: seed.imdbScore ?? null,
    runtimeMinutes: seed.runtime ?? null,
    hasDub: Boolean(seed.dub),
    hasSub: Boolean(seed.sub),
    posterUrl: posterFor(seed.titleEn),
    posterGallery: [],
    backdropUrl: '',
    trailerUrl: '',
    streamUrl: '',
    status: seed.status,
    featuredHero: Boolean(seed.featuredHero),
    views: seed.views,
    mediaCount: seed.mediaCount,
    createdAt: iso(seed.daysAgo, 3),
    updatedAt: iso(seed.daysAgo, 1),
    qualities: seed.qualities,
    versions: seed.qualities.map((quality, order) => ({
      id: `v-${index}-${order}`,
      kind: 'sub',
      title: quality,
      resolution: quality,
      sortOrder: order,
      links: seed.type === 'series'
        ? Array.from({ length: Math.max(1, seed.mediaCount || 1) }, (_unused, episodeIndex) => ({
          id: `l-${index}-${order}-${episodeIndex}`,
          season: 1,
          episode: episodeIndex + 1,
          title: `قسمت ${episodeIndex + 1}`,
          label: `${quality} WEB-DL`,
          sizeText: `${(0.4 + episodeIndex * 0.05).toFixed(1)} GB`,
          streamUrl: '',
          subtitleUrl: '',
          dubUrl: '',
          telegramUrl: `https://t.me/c/3981503084/${500 + episodeIndex}`,
          source: 'telegram_bot',
        }))
        : [{
          id: `l-${index}-${order}`,
          season: null,
          episode: null,
          title: null,
          label: `${quality} WEB-DL`,
          sizeText: '2.1 GB',
          streamUrl: '',
          subtitleUrl: '',
          dubUrl: '',
          telegramUrl: '',
          source: 'manual',
        }],
    })),
  }));

  const users = Array.from({ length: 148 }, (_unused, index) => ({
    id: String(index + 1),
    accountName: `کاربر ${index + 1}`,
    role: index % 9 === 0 ? 'advertiser' : 'user',
    status: 'active',
    createdAt: iso(index % 60, index % 24),
  }));

  const ads = [
    { id: 'ad-1', campaign: 'اسپانسر پخش زنده', advertiser: 'دیجی‌مارکت', placement: 'pre_roll', budget: 320_000_000, spent: 180_000_000, status: 'active', createdAt: iso(6) },
    { id: 'ad-2', campaign: 'تخفیف پاییزه', advertiser: 'کتاب‌راز', placement: 'timed_banner', budget: 90_000_000, spent: 12_000_000, status: 'pending', createdAt: iso(2) },
    { id: 'ad-3', campaign: 'اپلیکیشن سفر', advertiser: 'علی‌بابا', placement: 'pause_overlay', budget: 210_000_000, spent: 60_000_000, status: 'active', createdAt: iso(14) },
    { id: 'ad-4', campaign: 'کمپین پایان‌یافته', advertiser: 'اسنپ', placement: 'pre_roll', budget: 150_000_000, spent: 150_000_000, status: 'completed', createdAt: iso(45) },
  ];

  const events = [
    { kind: 'content', title: 'محتوای جدید ثبت شد: پیت', detail: 'از طریق ربات مدیریت · فصل ۶', createdAt: iso(0, 2) },
    { kind: 'media', title: '۶ کارت دانلود به پیت اضافه شد', detail: 'دوبله و زیرنویس، 1080p', createdAt: iso(0, 5) },
    { kind: 'user', title: 'کاربر جدید از تلگرام', detail: 'احراز هویت با کد پیامکی', createdAt: iso(1, 3) },
    { kind: 'ad', title: 'کمپین «تخفیف پاییزه» در انتظار تأیید', detail: 'بنر زمان‌بندی‌شده', createdAt: iso(2, 1) },
    { kind: 'system', title: 'پشتیبان‌گیری شبانه انجام شد', detail: '۳۸۴ مگابایت', createdAt: iso(3, 2) },
  ];

  const health = [
    { title: 'اسب‌های آرام', reason: 'لینک اصلی در دسترس نبود؛ نسخه پشتیبان جایگزین شد.', createdAt: iso(1, 4) },
    { title: 'شهر متروکه', reason: 'زیرنویس مجزا منقضی شده است.', createdAt: iso(4, 6) },
  ];

  return { contents, users, ads, events, health };
}

function applyDerivedCounts(item, payload) {
  if (payload.contentType !== 'series' || !payload.versions?.length) return;
  // One episode exists once, even when it has both a subtitle and a dubbed version.
  const episodes = payload.versions.flatMap((version) => version.links).filter((link) => link.episode);
  if (!episodes.length) return;
  const unique = new Set(episodes.map((link) => `${link.season || 1}-${link.episode}`));
  if (item.seasonCount === null || item.seasonCount === '' || payload.seasonCount === null) {
    item.seasonCount = new Set(episodes.map((link) => link.season || 1)).size;
  }
  if (item.episodeCount === null || item.episodeCount === '' || payload.episodeCount === null) {
    item.episodeCount = unique.size;
  }
}

let state = null;

function ensureState() {
  if (!state) state = buildState();
  return state;
}

function findContent(assetId) {
  const item = ensureState().contents.find((entry) => entry.id === assetId);
  assert(item, 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
  return item;
}

function summary(item) {
  return {
    id: item.id,
    internalId: item.internalId,
    type: item.type,
    title: item.title,
    originalTitle: item.originalTitle,
    posterUrl: item.posterUrl,
    releaseYear: item.releaseYear,
    lastAirYear: item.lastAirYear,
    imdbScore: item.imdbScore,
    status: item.status,
    featuredHero: item.featuredHero,
    views: item.views,
    seasons: item.seasonCount,
    episodes: item.episodeCount,
    seriesRunning: item.seriesRunning,
    currentSeason: item.currentSeason,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    qualities: item.qualities,
    hasDub: item.hasDub,
    hasSub: item.hasSub,
    mediaCount: item.mediaCount,
  };
}

function pushEvent(kind, title, detail) {
  ensureState().events.unshift({ kind, title, detail, createdAt: new Date().toISOString() });
  ensureState().events = ensureState().events.slice(0, 40);
}

const store = {
  kind: 'demo',

  async overview() {
    const data = ensureState();
    const timeline = Array.from({ length: 14 }, (_unused, index) => {
      const day = new Date(Date.now() - (13 - index) * 86_400_000).toISOString().slice(0, 10);
      return {
        day,
        contents: data.contents.filter((item) => item.createdAt.slice(0, 10) === day).length,
        users: data.users.filter((user) => user.createdAt.slice(0, 10) === day).length,
      };
    });
    const genreCounts = new Map();
    for (const item of data.contents) {
      for (const genre of item.genres) genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
    }
    return composeOverview({
      contents: {
        total: data.contents.length,
        movies: data.contents.filter((item) => item.type === 'movie').length,
        series: data.contents.filter((item) => item.type === 'series').length,
        published: data.contents.filter((item) => item.status === 'published').length,
        drafts: data.contents.filter((item) => item.status === 'draft').length,
        archived: data.contents.filter((item) => item.status === 'archived').length,
        seriesRunning: data.contents.filter((item) => item.seriesRunning).length,
        hero: data.contents.filter((item) => item.featuredHero).length,
      },
      media: {
        total: data.contents.reduce((sum, item) => sum + item.mediaCount, 0),
        unavailable: 2,
        resolutions: [
          { resolution: '1080p', count: 42 },
          { resolution: '720p', count: 36 },
          { resolution: '480p', count: 18 },
          { resolution: '2160p', count: 6 },
        ],
      },
      users: {
        total: data.users.length + 4112,
        advertisers: data.users.filter((user) => user.role === 'advertiser').length + 41,
        newThisMonth: 96,
      },
      ads: {
        total: data.ads.length,
        pending: data.ads.filter((ad) => ad.status === 'pending').length,
        active: data.ads.filter((ad) => ad.status === 'active').length,
        spent: data.ads.reduce((sum, ad) => sum + ad.spent, 0),
      },
      views: {
        total: data.contents.reduce((sum, item) => sum + item.views, 0) + 184_000,
        last7: 42_180,
      },
      timeline,
      genres: [...genreCounts.entries()].map(([genre, count]) => ({ genre, count })),
      topContents: [...data.contents].sort((a, b) => b.views - a.views).slice(0, 5).map((item) => ({
        asset_uuid: item.id,
        title: item.title,
        content_type: item.type,
        view_count: item.views,
        poster_url: item.posterUrl,
      })),
      weeklySeries: data.contents
        .filter((item) => item.seriesRunning)
        .map((item) => ({
          asset_uuid: item.id,
          title: item.title,
          current_season: item.currentSeason,
          broadcast_note: item.broadcastNote,
        })),
      activity: data.events.slice(0, 8).map((event) => ({
        kind: event.kind,
        title: event.title,
        detail: event.detail,
        created_at: event.createdAt,
      })),
      health: data.health.map((row) => ({ title: row.title, reason: row.reason, created_at: row.createdAt })),
    });
  },

  async listContents(filters = {}) {
    const data = ensureState();
    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const limit = Math.max(1, Math.min(60, Number.parseInt(filters.limit, 10) || 12));
    let rows = [...data.contents];
    if (filters.type && ['movie', 'series'].includes(filters.type)) {
      rows = rows.filter((item) => item.type === filters.type);
    }
    if (filters.status && ['draft', 'published', 'archived'].includes(filters.status)) {
      rows = rows.filter((item) => item.status === filters.status);
    }
    if (filters.hero === '1') rows = rows.filter((item) => item.featuredHero);
    if (filters.running === '1') rows = rows.filter((item) => item.seriesRunning);
    if (filters.q) {
      const term = String(filters.q).toLowerCase();
      rows = rows.filter((item) => `${item.title} ${item.originalTitle}`.toLowerCase().includes(term));
    }
    if (filters.sort === 'views') rows.sort((a, b) => b.views - a.views);
    else if (filters.sort === 'title') rows.sort((a, b) => a.title.localeCompare(b.title, 'fa'));
    else rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = rows.length;
    return {
      items: rows.slice((page - 1) * limit, page * limit).map(summary),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    };
  },

  async getContent(assetId) {
    const item = findContent(assetId);
    return { counts: { seasons: item.seasonCount, episodes: item.episodeCount,
      mediaLinks: item.versions.reduce((sum, version) => sum + version.links.length, 0) },
      content: { ...summary(item), description: item.description, genres: item.genres,
      directors: item.directors, cast: item.cast, countries: item.countries, network: item.network,
      ageRating: item.ageRating, runtimeMinutes: item.runtimeMinutes, broadcastNote: item.broadcastNote,
      posterGallery: item.posterGallery }, versions: item.versions };
  },

  async createContent(payload) {
    const data = ensureState();
    const item = {
      id: crypto.randomUUID(),
      internalId: String(data.contents.length + 1),
      type: payload.contentType,
      title: payload.titleFa,
      originalTitle: payload.titleEn,
      description: payload.description,
      releaseYear: payload.releaseYear,
      lastAirYear: payload.lastAirYear,
      seriesRunning: payload.seriesRunning,
      currentSeason: payload.currentSeason,
      broadcastNote: payload.broadcastNote,
      seasonCount: payload.seasonCount,
      episodeCount: payload.episodeCount,
      genres: payload.genres,
      directors: payload.directors,
      cast: payload.castMembers,
      countries: payload.countries,
      network: payload.network,
      ageRating: payload.ageRating,
      imdbScore: payload.imdbScore,
      runtimeMinutes: payload.runtimeMinutes,
      hasDub: payload.hasDub,
      hasSub: payload.hasSub,
      posterUrl: payload.posterUrl || posterFor(payload.titleEn || payload.titleFa),
      posterGallery: payload.posterGallery,
      backdropUrl: payload.backdropUrl,
      trailerUrl: payload.trailerUrl,
      streamUrl: payload.streamUrl,
      status: payload.status,
      featuredHero: false,
      views: 0,
      mediaCount: payload.versions.reduce((sum, version) => sum + version.links.length, 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      qualities: payload.versions.map((version) => version.resolution).filter(Boolean),
      versions: payload.versions.map((version, index) => ({
        id: `v-${index}`,
        kind: version.kind,
        title: version.title,
        resolution: version.resolution,
        sortOrder: index,
        links: version.links.map((link, linkIndex) => ({ ...link, id: `l-${index}-${linkIndex}` })),
      })),
    };
    if (payload.featuredHero) {
      data.contents.forEach((entry) => { entry.featuredHero = false; });
      item.featuredHero = true;
    }
    applyDerivedCounts(item, payload);
    data.contents.unshift(item);
    pushEvent('content', `محتوا ثبت شد: ${item.title}`, `${item.type === 'series' ? 'سریال' : 'فیلم'} · ${item.status}`);
    return { content: summary(item) };
  },

  async updateContent(assetId, payload) {
    const item = findContent(assetId);
    Object.assign(item, {
      type: payload.contentType,
      title: payload.titleFa,
      originalTitle: payload.titleEn,
      description: payload.description,
      releaseYear: payload.releaseYear,
      lastAirYear: payload.lastAirYear,
      seriesRunning: payload.seriesRunning,
      currentSeason: payload.currentSeason,
      broadcastNote: payload.broadcastNote,
      seasonCount: payload.seasonCount,
      episodeCount: payload.episodeCount,
      genres: payload.genres,
      directors: payload.directors,
      cast: payload.castMembers,
      countries: payload.countries,
      network: payload.network,
      ageRating: payload.ageRating,
      imdbScore: payload.imdbScore,
      runtimeMinutes: payload.runtimeMinutes,
      hasDub: payload.hasDub,
      hasSub: payload.hasSub,
      posterUrl: payload.posterUrl || item.posterUrl,
      posterGallery: payload.posterGallery,
      status: payload.status,
      updatedAt: new Date().toISOString(),
    });
    if (payload.featuredHero && !item.featuredHero) {
      ensureState().contents.forEach((entry) => { entry.featuredHero = false; });
      item.featuredHero = true;
    } else {
      item.featuredHero = payload.featuredHero;
    }
    if (payload.versions.length) {
      item.versions = payload.versions.map((version, index) => ({
        id: `v-${index}`,
        kind: version.kind,
        title: version.title,
        resolution: version.resolution,
        sortOrder: index,
        links: version.links.map((link, linkIndex) => ({ ...link, id: `l-${index}-${linkIndex}` })),
      }));
      item.qualities = payload.versions.map((version) => version.resolution).filter(Boolean);
      item.mediaCount = payload.versions.reduce((sum, version) => sum + version.links.length, 0);
    }
    applyDerivedCounts(item, payload);
    pushEvent('content', `محتوا ویرایش شد: ${item.title}`, `وضعیت ${item.status}`);
    return store.getContent(assetId);
  },

  async deleteContent(assetId) {
    const data = ensureState();
    const index = data.contents.findIndex((item) => item.id === assetId);
    if (index === -1) throw new AppError(404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
    const [removed] = data.contents.splice(index, 1);
    pushEvent('content', `محتوا حذف شد: ${removed.title}`, null);
    return { deleted: true };
  },

  async setHero(assetId, enabled) {
    const item = findContent(assetId);
    if (enabled) ensureState().contents.forEach((entry) => { entry.featuredHero = false; });
    item.featuredHero = Boolean(enabled);
    pushEvent('content', enabled ? `به بنر هیرو اضافه شد: ${item.title}` : `از بنر هیرو برداشته شد: ${item.title}`, null);
    return { featuredHero: item.featuredHero };
  },

  async syncFromMedia(assetId) {
    const item = findContent(assetId);
    pushEvent('media', `لینک‌های رسانه همگام شد: ${item.title}`, 'در حالت نمایشی لینک جدیدی وجود ندارد');
    return { imported: 0, scanned: item.mediaCount, ...(await store.getContent(assetId)) };
  },

  async countContentsThisMonth() {
    return ensureState().contents.filter((item) => Date.now() - new Date(item.createdAt) < 30 * 86_400_000).length;
  },

};

// Ops helpers used by the console routes when the demo store is active.
store.listUsers = async () => ensureState().users.map((user) => ({
  id: user.id,
  accountName: user.accountName,
  role: user.role,
  status: user.status,
  createdAt: user.createdAt,
  walletBalance: user.role === 'advertiser' ? 12_500_000 : 0,
  walletCurrency: 'IRR',
}));
store.listAds = async () => ensureState().ads;
store.listEvents = async () => ensureState().events;

module.exports = { store };
