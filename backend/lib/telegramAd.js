'use strict';
const { AppError } = require('./errors');
function telegramTarget(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new AppError(422, 'TELEGRAM_AD_URL_INVALID', 'لینک کانال یا ربات تلگرام معتبر نیست.'); }
  if (url.protocol !== 'https:' || !['t.me', 'telegram.me'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password || !url.pathname || url.pathname === '/') {
    throw new AppError(422, 'TELEGRAM_AD_URL_INVALID', 'برای دکمهٔ ربات لینک HTTPS کانال یا ربات در t.me وارد کنید.');
  }
  return url.toString();
}
function trackedOrigin(raw = process.env.APP_URL) {
  let url;
  try { url = new URL(raw); } catch { throw new AppError(422, 'TELEGRAM_AD_APP_URL', 'برای ثبت کلیک ربات، APP_URL عمومی HTTPS باید روی سرور تنظیم شود.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname || ['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname)) throw new AppError(422, 'TELEGRAM_AD_APP_URL', 'برای ثبت کلیک ربات، APP_URL عمومی HTTPS باید روی سرور تنظیم شود.');
  return url.origin;
}
module.exports = { telegramTarget, trackedOrigin };
