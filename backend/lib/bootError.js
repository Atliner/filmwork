'use strict';

/**
 * Renders the startup failure as a small HTML page.
 *
 * The alternative — letting the process die — makes Passenger/cPanel answer a bare
 * "503 Service Unavailable" with no hint about what to fix. The page lists the
 * error, the most common causes and only the *names* of missing environment
 * variables (never their values).
 */

const REQUIRED_ALWAYS = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const REQUIRED_SECRETS = ['JWT_SECRET', 'AUTH_CODE_PEPPER', 'PHONE_ENCRYPTION_KEY'];
const REQUIRED_PRODUCTION = [
  'APP_URL',
  'AUTH_BOT_TOKEN',
  'AUTH_BOT_USERNAME',
  'ADMIN_BOT_TOKEN',
  'ADMIN_OWNER_IDS',
  'TELEGRAM_PRIMARY_CHAT_ID',
  'TELEGRAM_FALLBACK_1_CHAT_ID',
  'TELEGRAM_FALLBACK_2_CHAT_ID',
];

// Tokens, passwords and bot secrets must never be echoed into a web page.
const SENSITIVE_PATTERN = /(bot\d{5,}:[A-Za-z0-9_-]+|"password"\s*:\s*"[^"]*"|password=[^&\s]+)/gi;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeMessage(message) {
  return String(message || '').replace(SENSITIVE_PATTERN, (match) => (
    match.includes(':') && !match.includes('password') ? 'bot<redacted>' : 'password=<redacted>'
  ));
}

function missingVariables(env = process.env) {
  const required = [...REQUIRED_ALWAYS, ...REQUIRED_SECRETS];
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') required.push(...REQUIRED_PRODUCTION);
  return required.filter((name) => !env[name]);
}

function renderBootError(error, env = process.env) {
  const message = sanitizeMessage(error?.message || error || 'Unknown startup error');
  const missing = missingVariables(env);
  const code = error?.code ? escapeHtml(error.code) : '';
  const missingBlock = missing.length
    ? `<p class="label">متغیرهای محیطی تنظیم‌نشده</p><ul>${missing.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join('')}</ul>`
    : '';

  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Filmwork — خطای راه‌اندازی</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:#08080a;color:#f4f4f5;font-family:system-ui,"Segoe UI",Tahoma,sans-serif;display:grid;place-items:center;padding:24px;line-height:1.9}
  main{width:min(720px,100%);background:#121216;border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:28px}
  h1{margin:0 0 6px;font-size:20px}
  p{margin:10px 0;color:#d4d4d8}
  .label{margin-top:22px;font-weight:700;color:#fafafa}
  pre{white-space:pre-wrap;word-break:break-word;background:#000;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px;color:#fca5a5;font-size:13px;direction:ltr;text-align:left}
  ul{margin:8px 0;padding-inline-start:22px}
  code{background:rgba(255,255,255,.08);padding:2px 6px;border-radius:6px;font-size:13px;direction:ltr;display:inline-block}
  ol{padding-inline-start:22px;color:#d4d4d8}
  small{display:block;margin-top:22px;color:#71717a}
</style></head>
<body><main>
  <h1>برنامه بالا نیامد</h1>
  <p>این صفحه به‌جای پاسخ ۵۰۳ خالی نمایش داده می‌شود تا علت دقیق راه‌اندازی‌نشدن برنامه را ببینید. پس از اصلاح، Application را Restart کنید.</p>
  <p class="label">خطا${code ? ` (${code})` : ''}</p>
  <pre>${escapeHtml(message)}</pre>
  ${missingBlock}
  <p class="label">بررسی‌های رایج</p>
  <ol>
    <li>فایل <code>.env</code> در پوشه <code>backend</code> وجود دارد و مقادیر <code>DB_*</code> با دیتابیس cPanel یکی است.</li>
    <li>در cPanel هاست MySQL از راه دور مسدود است؛ <code>DB_HOST</code> معمولاً <code>localhost</code> است.</li>
    <li><code>npm ci --omit=dev</code> در پوشه <code>backend</code> اجرا شده و پوشه <code>node_modules</code> وجود دارد.</li>
    <li><code>NODE_ENV=production</code>، <code>APP_URL=https://…</code> و سه secret با حداقل ۳۲ نویسه تنظیم شده‌اند.</li>
    <li>سه <code>CHAT_ID</code> تلگرام و <code>ADMIN_OWNER_IDS</code> عددی و کامل هستند.</li>
  </ol>
  <small>این صفحه فقط برای مالک سایت است و هیچ مقدار محرمانه‌ای را نمایش نمی‌دهد.</small>
</main></body></html>`;
}

module.exports = { renderBootError, missingVariables, sanitizeMessage };
