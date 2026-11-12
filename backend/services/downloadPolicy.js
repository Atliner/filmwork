'use strict';

const { query } = require('../config/db');
const { AppError } = require('../lib/errors');
const siteSettings = require('./siteSettings');

async function checkDownloadAllowance(userId, settings = null) {
  const config = settings || await siteSettings.read();
  const dailyCap = Number(config['download.daily_cap'] || 0);
  const burstLimit = Math.max(1, Number(config['download.burst_limit'] || 10));
  const resetMinutes = Math.max(1, Number(config['download.reset_minutes'] || 60));
  const delays = String(config['download.delay_minutes'] || '1,2,10,30')
    .split(',').map((part) => Number(part.trim())).filter((value) => Number.isFinite(value) && value >= 0);

  if (dailyCap > 0) {
    const [daily] = await query(`SELECT COUNT(*) AS total FROM download_history
      WHERE user_id = :userId AND created_at >= UTC_DATE()`, { userId });
    if (Number(daily.total) >= dailyCap) throw new AppError(429, 'DAILY_DOWNLOAD_LIMIT', 'سقف دانلود روزانهٔ شما تکمیل شده است.');
  }
  const recent = await query(`SELECT created_at FROM download_history
    WHERE user_id = :userId AND created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${resetMinutes} MINUTE)
    ORDER BY created_at DESC LIMIT 500`, { userId });
  const streak = recent.length;
  if (streak >= burstLimit && delays.length) {
    const stage = Math.min(delays.length - 1, Math.floor(streak / burstLimit) - 1);
    const waitSeconds = delays[stage] * 60 - Math.floor((Date.now() - new Date(recent[0].created_at).getTime()) / 1000);
    if (waitSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(waitSeconds / 60));
      throw new AppError(429, 'DOWNLOAD_COOLDOWN', `برای دانلودهای پی‌درپی، ${minutes} دقیقه صبر کنید.`, { retryAfterSeconds: waitSeconds });
    }
  }
  return { settings: config, streak };
}

module.exports = { checkDownloadAllowance };
