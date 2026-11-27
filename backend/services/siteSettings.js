'use strict';

const { query, withTransaction } = require('../config/db');
const { assert } = require('../lib/errors');

const DEFAULTS = Object.freeze({
  'site.name': 'Vizosten',
  'site.tagline': 'تماشای آنلاین و دریافت امن فیلم و سریال',
  'download.burst_limit': '10',
  'download.delay_minutes': '1,2,10,30',
  'download.reset_minutes': '60',
  'download.daily_cap': '0',
  'download.delete_after_minutes': '0',
  'download.caption': '🎬 {title}\n📦 {version}\n\nدریافت امن از {site_name}',
  'player.enabled': '1',
  'player.button_visible': '1',
});
const demoValues = { ...DEFAULTS };

// Replace the old display name, not usernames, URLs or existing template tokens.
// Stored custom text is otherwise retained. The name comes from the previous
// setting under a row lock, so concurrent panel updates cannot lose the caption.
function captionAsTemplate(value, names = []) {
  const parts = String(value ?? '').split(/(https?:\/\/[^\s]+|@[A-Za-z0-9_]+|\{(?:site_name|title|version)\})/giu);
  const unique = [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return parts.join('');
  const escaped = unique.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_@\\u200c\\u200d])(?:${escaped})(?![\\p{L}\\p{N}\\p{M}_\\u200c\\u200d])`, 'giu');
  return parts.map((part, index) => index % 2 ? part : part.replace(pattern, '{site_name}')).join('');
}
function effectiveSettings(values) {
  const settings = { ...DEFAULTS, ...values };
  settings['download.caption'] = captionAsTemplate(settings['download.caption'], [settings['site.name'], 'Vizosten', 'Filmwork']);
  return settings;
}

function validate(values) {
  const output = {};
  const allowed = new Set(Object.keys(DEFAULTS));
  for (const [key, raw] of Object.entries(values || {})) {
    assert(allowed.has(key), 422, 'UNKNOWN_SETTING', `تنظیم ناشناخته: ${key}`);
    const value = String(raw ?? '').trim();
    if (key === 'site.name') assert(value.length >= 1 && value.length <= 80, 422, 'INVALID_SETTING', 'نام سایت باید حداکثر ۸۰ نویسه باشد.');
    if (key === 'site.tagline') assert(value.length <= 180, 422, 'INVALID_SETTING', 'شعار سایت باید حداکثر ۱۸۰ نویسه باشد.');
    if (key === 'download.caption') assert(value.length <= 900, 422, 'INVALID_SETTING', 'کپشن حداکثر ۹۰۰ نویسه است.');
    if (key === 'download.delay_minutes') assert(/^\s*\d{1,3}(\s*,\s*\d{1,3}){0,9}\s*$/.test(value), 422, 'INVALID_SETTING', 'زمان‌های انتظار را به‌شکل ۱،۲،۱۰ وارد کنید.');
    if (['player.enabled', 'player.button_visible'].includes(key)) assert(['0', '1'].includes(value), 422, 'INVALID_SETTING', 'مقدار این گزینه باید روشن یا خاموش باشد.');
    if (['download.burst_limit', 'download.reset_minutes', 'download.daily_cap', 'download.delete_after_minutes'].includes(key)) {
      const number = Number(value);
      const maxima = { 'download.burst_limit': 100, 'download.reset_minutes': 1440, 'download.daily_cap': 10000, 'download.delete_after_minutes': 2760 };
      const minimum = ['download.daily_cap', 'download.delete_after_minutes'].includes(key) ? 0 : 1;
      assert(Number.isSafeInteger(number) && number >= minimum && number <= maxima[key], 422, 'INVALID_SETTING', `مقدار ${key} خارج از محدوده است.`);
    }
    output[key] = value;
  }
  return output;
}

async function read() {
  if (process.env.DEMO_DATA === '1') return effectiveSettings(demoValues);
  const rows = await query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'site.%' OR setting_key LIKE 'download.%' OR setting_key LIKE 'player.%'");
  return effectiveSettings(Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value ?? ''])));
}

async function getSiteName() {
  try { return String((await read())['site.name'] || '').trim() || 'سایت'; }
  catch (error) {
    // Do not block a Telegram response or claim an outdated brand when settings
    // are temporarily unavailable. The next message tries the database again.
    console.warn('Cannot read site name for Telegram:', error.message);
    return 'سایت';
  }
}

async function write(values) {
  const clean = validate(values);
  const hasBrandChange = Object.hasOwn(clean, 'site.name') || Object.hasOwn(clean, 'download.caption');
  const prepareCaption = (previousName, previousCaption) => {
    if (!hasBrandChange) return;
    const text = Object.hasOwn(clean, 'download.caption') ? clean['download.caption'] : previousCaption;
    const caption = captionAsTemplate(text, [previousName, clean['site.name'], 'Vizosten', 'Filmwork']);
    assert(caption.length <= 900, 422, 'INVALID_SETTING', 'پس از جایگزینی نام سایت، کپشن بیشتر از ۹۰۰ نویسه شد؛ آن را کوتاه کنید.');
    clean['download.caption'] = caption;
  };
  if (process.env.DEMO_DATA === '1') {
    prepareCaption(demoValues['site.name'], demoValues['download.caption']);
    Object.assign(demoValues, clean);
  } else {
    if (Number(clean['download.delete_after_minutes']) > 0) {
      try { await query('SELECT id FROM telegram_deletion_queue LIMIT 1'); }
      catch (error) {
        console.error('Telegram deletion queue is unavailable:', error.message);
        assert(false, 503, 'DELETION_QUEUE_UNAVAILABLE', 'ابتدا migration صف حذف تلگرام را اجرا و برنامه را بازنشانی کنید.');
      }
    }
    await withTransaction(async (connection) => {
      if (hasBrandChange) {
        // Seed before locking: existing installations may not yet have either key.
        await connection.execute(`INSERT IGNORE INTO app_settings (setting_key, setting_value)
          VALUES ('download.caption', :caption), ('site.name', :siteName)`, { caption:DEFAULTS['download.caption'], siteName:DEFAULTS['site.name'] });
        const [rows] = await connection.execute("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('site.name','download.caption') ORDER BY setting_key FOR UPDATE");
        const current = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value ?? '']));
        prepareCaption(current['site.name'], current['download.caption']);
      }
      for (const [setting_key, setting_value] of Object.entries(clean)) {
        await connection.execute(`INSERT INTO app_settings (setting_key, setting_value) VALUES (:setting_key, :setting_value)
          ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, { setting_key, setting_value });
      }
    });
  }
  return read();
}

module.exports = { DEFAULTS, validate, read, write, getSiteName, captionAsTemplate, effectiveSettings };
