'use strict';

const { query } = require('../config/db');
const { assert } = require('../lib/errors');

const DEFAULTS = Object.freeze({
  'site.name': 'Filmwork',
  'site.tagline': 'تماشای آنلاین و دریافت امن فیلم و سریال',
  'download.burst_limit': '10',
  'download.delay_minutes': '1,2,10,30',
  'download.reset_minutes': '60',
  'download.daily_cap': '0',
  'download.caption': '🎬 {title}\n📦 {version}\n\nدریافت امن از Filmwork',
  'player.enabled': '1',
  'player.button_visible': '1',
});
const demoValues = { ...DEFAULTS };

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
    if (['download.burst_limit', 'download.reset_minutes', 'download.daily_cap'].includes(key)) {
      const number = Number(value);
      const maxima = { 'download.burst_limit': 100, 'download.reset_minutes': 1440, 'download.daily_cap': 10000 };
      const minimum = key === 'download.daily_cap' ? 0 : 1;
      assert(Number.isSafeInteger(number) && number >= minimum && number <= maxima[key], 422, 'INVALID_SETTING', `مقدار ${key} خارج از محدوده است.`);
    }
    output[key] = value;
  }
  return output;
}

async function read() {
  if (process.env.DEMO_DATA === '1') return { ...DEFAULTS, ...demoValues };
  const rows = await query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'site.%' OR setting_key LIKE 'download.%' OR setting_key LIKE 'player.%'");
  return { ...DEFAULTS, ...Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value ?? ''])) };
}

async function write(values) {
  const clean = validate(values);
  if (process.env.DEMO_DATA === '1') Object.assign(demoValues, clean);
  else {
    for (const [setting_key, setting_value] of Object.entries(clean)) {
      await query(`INSERT INTO app_settings (setting_key, setting_value) VALUES (:setting_key, :setting_value)
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, { setting_key, setting_value });
    }
  }
  return read();
}

module.exports = { DEFAULTS, validate, read, write };
