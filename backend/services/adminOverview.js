'use strict';

/**
 * Composes the numbers shown on the owner console's overview.
 *
 * Both stores (MySQL and the demo store) emit the same compact `raw` shape and this
 * module turns it into cards, charts and feeds, so the two can never drift apart.
 */

function faDigits(value) {
  return String(value ?? '').replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
}

function number(value) {
  return Number(value || 0);
}

function lastDays(count) {
  const days = [];
  const today = new Date();
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - offset));
    days.push(date.toISOString().slice(0, 10));
  }
  return days;
}

function shortDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat('fa-IR', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

/**
 * @param {object} raw counts and grouped rows collected by a store
 */
function composeOverview(raw = {}) {
  const contents = raw.contents || {};
  const media = raw.media || {};
  const users = raw.users || {};
  const ads = raw.ads || {};
  const views = raw.views || {};

  const totals = {
    contents: number(contents.total),
    movies: number(contents.movies),
    series: number(contents.series),
    published: number(contents.published),
    drafts: number(contents.drafts),
    archived: number(contents.archived),
    seriesRunning: number(contents.seriesRunning),
    hero: number(contents.hero),
    media: number(media.total),
    streams: number(media.unavailable),
    resolutions: (media.resolutions || []).map((row) => ({
      label: row.resolution || 'نامشخص',
      value: number(row.count),
    })),
    users: number(users.total),
    advertisers: number(users.advertisers),
    newUsers: number(users.newThisMonth),
    ads: number(ads.total),
    pendingAds: number(ads.pending),
    activeAds: number(ads.active),
    adRevenue: number(ads.spent),
    views: number(views.total),
    viewsLast7: number(views.last7),
  };

  const timelineMap = new Map((raw.timeline || []).map((row) => [
    String(row.day).slice(0, 10),
    { contents: number(row.contents), users: number(row.users) },
  ]));
  const timeline = lastDays(14).map((day) => ({
    day,
    label: shortDay(day),
    contents: timelineMap.get(day)?.contents || 0,
    users: timelineMap.get(day)?.users || 0,
  }));

  const genreMap = new Map();
  for (const row of raw.genres || []) {
    const genre = String(row.genre || '').trim();
    if (!genre) continue;
    genreMap.set(genre, (genreMap.get(genre) || 0) + number(row.count));
  }
  const genres = [...genreMap.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const genreTotal = genres.reduce((sum, item) => sum + item.value, 0) || 1;

  return {
    totals,
    cards: [
      {
        key: 'contents',
        label: 'کل محتوا',
        value: totals.contents,
        hint: `${faDigits(totals.movies)} فیلم · ${faDigits(totals.series)} سریال`,
        accent: 'violet',
      },
      {
        key: 'published',
        label: 'منتشر شده',
        value: totals.published,
        hint: `${faDigits(totals.drafts)} پیش‌نویس`,
        accent: 'emerald',
      },
      {
        key: 'views',
        label: 'بازدید کل',
        value: totals.views,
        hint: `${faDigits(totals.viewsLast7)} در ۷ روز اخیر`,
        accent: 'amber',
      },
      {
        key: 'users',
        label: 'کاربران',
        value: totals.users,
        hint: `${faDigits(totals.advertisers)} تبلیغ‌دهنده`,
        accent: 'sky',
      },
      {
        key: 'media',
        label: 'لینک‌های رسانه',
        value: totals.media,
        hint: totals.streams ? `${faDigits(totals.streams)} خارج از دسترس` : 'همه سالم',
        accent: totals.streams ? 'rose' : 'emerald',
      },
      {
        key: 'ads',
        label: 'کمپین تبلیغات',
        value: totals.ads,
        hint: `${faDigits(totals.pendingAds)} در انتظار تأیید`,
        accent: 'rose',
      },
    ],
    timeline,
    genres: genres.map((item) => ({
      ...item,
      percent: Math.round((item.value / genreTotal) * 100),
    })),
    topContents: (raw.topContents || []).map((row) => ({
      id: row.asset_uuid || row.id,
      title: row.title,
      type: row.content_type || row.type,
      views: number(row.view_count ?? row.views),
      posterUrl: row.poster_url || row.posterUrl || null,
    })),
    resolutions: totals.resolutions,
    weeklySeries: (raw.weeklySeries || []).map((row) => ({
      id: row.asset_uuid,
      title: row.title,
      season: number(row.current_season),
      note: row.broadcast_note,
    })),
    activity: (raw.activity || []).map((row) => ({
      kind: row.kind,
      title: row.title,
      detail: row.detail,
      createdAt: row.created_at || row.createdAt,
    })),
    health: (raw.health || []).map((row) => ({
      title: row.title,
      reason: row.reason,
      createdAt: row.created_at || row.createdAt,
    })),
  };
}

module.exports = { composeOverview, faDigits };
