'use strict';

/**
 * Ad platform settings, placement catalogue and review policy.
 *
 * All of it lives in `app_settings` as `key → text` so a new knob never needs a
 * migration. The defaults below are the single source of truth used by the owner
 * console, the advertiser form and the ad server, so a missing row simply means
 * "use the default" rather than "crash".
 */

const PLACEMENTS = [
  { placement: 'pre_roll', group: 'video', label: 'پیش از پخش (Pre-roll)', order: 1, asset: 'video' },
  { placement: 'mid_roll', group: 'video', label: 'میان‌پخش (Mid-roll)', order: 2, asset: 'video' },
  { placement: 'timed_banner', group: 'video', label: 'پس از پخش (Post-roll)', order: 3, asset: 'video' },
  { placement: 'pause_overlay', group: 'video', label: 'لایه هنگام توقف (Pause)', order: 4, asset: 'video' },
  { placement: 'banner_player', group: 'banner', label: 'بنر روی پلیر (۷۲۸×۹۰)', order: 5, asset: 'image' },
  { placement: 'banner_pause', group: 'banner', label: 'بنر توقف (۳۰۰×۲۵۰)', order: 6, asset: 'image' },
  { placement: 'banner_download', group: 'banner', label: 'بنر قبل از دانلود (۱۰۸۰×۱۹۲۰)', order: 7, asset: 'image' },
  { placement: 'link_file_button', group: 'link', label: 'دکمه لینک زیر فایل (ربات)', order: 8, asset: 'link' },
];

const PLACEMENT_KEYS = PLACEMENTS.map((item) => item.placement);

const GROUPS = [
  { group: 'video', label: 'ویدیویی', hint: '۴ جایگاه · تبلیغ ویدیویی داخل پلیر' },
  { group: 'banner', label: 'بنری', hint: '۳ جایگاه · تصویر ثابت' },
  { group: 'link', label: 'لینکی', hint: '۱ جایگاه · دکمه لینک زیر فایل' },
];

const DEFAULTS = {
  'ads.auto_approve': '0',
  'ads.default_video_duration': '15',
  'ads.default_banner_duration': '8',
  'ads.skip_after_seconds': '5',
  'ads.max_video_mb': '8',
  'ads.max_image_kb': '600',
  'ads.min_video_seconds': '5',
  'ads.max_video_seconds': '30',
  'ads.cpm_video': '50000',
  'ads.cpm_banner': '50000',
  'ads.cpm_link': '50000',
  'ads.cpc_video': '0',
  'ads.cpc_banner': '0',
  'ads.cpc_link': '1000',
  'ads.cpv_video': '0',
  'ads.cpv_banner': '0',
  'ads.cpv_link': '0',
  'ads.min_budget': '50000',
  'ads.daily_budget_cap': '0',
  'ads.max_priority_multiplier': '5',
  'ads.link_allowlist': '',
  'ads.rules': '',
  'ads.reject_purge_minutes': '60',
};

/** Bounds so a typo in the console can never disable the ad server. */
const LIMITS = {
  'ads.default_video_duration': [5, 120],
  'ads.default_banner_duration': [3, 60],
  'ads.skip_after_seconds': [0, 30],
  'ads.max_video_mb': [1, 100],
  'ads.max_image_kb': [50, 5000],
  'ads.min_video_seconds': [1, 60],
  'ads.max_video_seconds': [5, 300],
  'ads.cpm_video': [0, 1_000_000_000],
  'ads.cpm_banner': [0, 1_000_000_000],
  'ads.cpm_link': [0, 1_000_000_000],
  'ads.cpc_video': [0, 1_000_000_000],
  'ads.cpc_banner': [0, 1_000_000_000],
  'ads.cpc_link': [0, 1_000_000_000],
  'ads.cpv_video': [0, 1_000_000_000],
  'ads.cpv_banner': [0, 1_000_000_000],
  'ads.cpv_link': [0, 1_000_000_000],
  'ads.min_budget': [1000, 1_000_000_000],
  'ads.daily_budget_cap': [0, 1_000_000_000],
  'ads.max_priority_multiplier': [1, 20],
  'ads.reject_purge_minutes': [0, 43_200],
};

const BOOLEAN_KEYS = new Set(['ads.auto_approve']);
const TEXT_KEYS = new Set(['ads.link_allowlist', 'ads.rules']);

function normalizeKeyValue(key, rawValue) {
  if (BOOLEAN_KEYS.has(key)) {
    return String(rawValue) === '1' || rawValue === true || rawValue === 'true' ? '1' : '0';
  }
  if (TEXT_KEYS.has(key)) {
    return String(rawValue ?? '').slice(0, 8000);
  }
  const numeric = Number(String(rawValue ?? '').replace(/[^\d.-]/g, ''));
  const [min, max] = LIMITS[key] || [0, Number.MAX_SAFE_INTEGER];
  if (!Number.isFinite(numeric)) return DEFAULTS[key] ?? '0';
  const clamped = Math.min(max, Math.max(min, numeric));
  return String(Math.round(clamped * 100) / 100);
}

/** Settings object handed to the console (`{key: value}` in their stored form). */
function mergeSettings(rows = []) {
  const stored = new Map(rows.map((row) => [row.setting_key || row.key, row.setting_value ?? row.value]));
  const settings = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    settings[key] = stored.has(key) ? normalizeKeyValue(key, stored.get(key)) : fallback;
  }
  return settings;
}

/** Typed view for the advertiser form and the ad server. */
function adPolicy(settings) {
  const num = (key) => Number(settings[key] ?? DEFAULTS[key] ?? 0);
  return {
    autoApprove: settings['ads.auto_approve'] === '1',
    defaultVideoDuration: num('ads.default_video_duration'),
    defaultBannerDuration: num('ads.default_banner_duration'),
    skipAfterSeconds: num('ads.skip_after_seconds'),
    maxVideoMb: num('ads.max_video_mb'),
    maxImageKb: num('ads.max_image_kb'),
    minVideoSeconds: num('ads.min_video_seconds'),
    maxVideoSeconds: num('ads.max_video_seconds'),
    cpm: { video: num('ads.cpm_video'), banner: num('ads.cpm_banner'), link: num('ads.cpm_link') },
    cpc: { video: num('ads.cpc_video'), banner: num('ads.cpc_banner'), link: num('ads.cpc_link') },
    cpv: { video: num('ads.cpv_video'), banner: num('ads.cpv_banner'), link: num('ads.cpv_link') },
    minBudget: num('ads.min_budget'),
    dailyBudgetCap: num('ads.daily_budget_cap'),
    maxPriorityMultiplier: num('ads.max_priority_multiplier'),
    linkAllowlist: String(settings['ads.link_allowlist'] || '')
      .split(/[\s,]+/u)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    rules: String(settings['ads.rules'] || ''),
    rejectPurgeMinutes: num('ads.reject_purge_minutes'),
  };
}

function placementMeta(placement) {
  return PLACEMENTS.find((item) => item.placement === placement) || null;
}

function placementGroup(placement) {
  return placementMeta(placement)?.group || 'video';
}

/** Validates every key the console can write. Returns `{key, value}` pairs. */
function buildSettingsUpdate(payload = {}) {
  const updates = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!(key in DEFAULTS)) continue;
    updates.push({ key, value: normalizeKeyValue(key, value) });
  }
  return updates;
}

module.exports = {
  PLACEMENTS,
  PLACEMENT_KEYS,
  GROUPS,
  DEFAULTS,
  mergeSettings,
  adPolicy,
  placementMeta,
  placementGroup,
  buildSettingsUpdate,
  normalizeKeyValue,
};
