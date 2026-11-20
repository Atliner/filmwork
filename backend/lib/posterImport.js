'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { AppError } = require('./errors');

const MAX_PAGE = 2 * 1024 * 1024;
const MAX_IMAGE = 12 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['impawards.com', 'www.impawards.com']);

// No arbitrary URL fetching: only this fixed public provider, default ports,
// ordinary paths, no credentials and no redirects outside the allowlist.
function allowedUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new AppError(422, 'POSTER_URL_INVALID', 'لینک IMPAwards معتبر نیست.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || url.port || url.username || url.password ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(url.pathname) || url.pathname.includes('..') || url.search || url.hash) {
    throw new AppError(422, 'POSTER_URL_INVALID', 'فقط لینک صفحه یا تصویر معتبر از دامنه IMPAwards پذیرفته می‌شود.');
  }
  return url;
}
function isImageUrl(url) { return /\/posters\/[a-zA-Z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname); }
function extractPosterUrl(html, pageUrl) {
  // Read only image tags, not scripts or links to a different movie/poster.
  const tags = String(html).match(/<img\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const match = tag.match(/\b(?:src|data-src)\s*=\s*["']([^"']+)["']/i);
    if (!match) continue;
    const source = match[1].replace(/&amp;/gi, '&');
    let candidate;
    try { candidate = allowedUrl(new URL(source, pageUrl).toString()); } catch { continue; }
    if (isImageUrl(candidate)) return candidate;
  }
  throw new AppError(422, 'POSTER_NOT_FOUND', 'تصویر پوستر در این صفحه پیدا نشد. لینک صفحهٔ یک پوستر یا تصویر مستقیم را وارد کنید.');
}
async function readLimited(response, max) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > max) throw new AppError(422, 'POSTER_TOO_LARGE', 'حجم فایل دریافتی بیش از حد مجاز است.');
  const chunks = []; let total = 0;
  if (!response.body) throw new AppError(502, 'POSTER_EMPTY', 'پاسخ خالی از سایت پوستر دریافت شد.');
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > max) { await response.body.cancel?.().catch(() => {}); throw new AppError(422, 'POSTER_TOO_LARGE', 'حجم فایل دریافتی بیش از حد مجاز است.'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function fetchAllowed(rawUrl, { fetchFn = globalThis.fetch, maxBytes, referer } = {}) {
  let url = allowedUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    for (let count = 0; count <= 3; count += 1) {
      const response = await fetchFn(url.toString(), {
        redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Vizosten/1.0)', accept: 'image/avif,image/webp,image/*,text/html;q=0.9,*/*;q=0.5', ...(referer ? { referer } : {}) },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || count === 3) throw new AppError(502, 'POSTER_REDIRECT', 'تغییر مسیر صفحه پوستر نامعتبر است.');
        url = allowedUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new AppError(502, 'POSTER_UPSTREAM', `سایت پوستر پاسخ HTTP ${response.status} داد.`);
      return { data: await readLimited(response, maxBytes), url, contentType: response.headers.get('content-type') || '' };
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'POSTER_UNREACHABLE', 'دریافت از IMPAwards ممکن نیست؛ دسترسی خروجی سرور به این سایت را بررسی کنید.');
  } finally { clearTimeout(timer); }
}
function imageExtension(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))) return '.png';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  throw new AppError(422, 'POSTER_NOT_IMAGE', 'فایل دریافتی تصویر JPEG، PNG یا WebP معتبر نیست.');
}
async function importPoster(source, directory, fetchFn = globalThis.fetch) {
  const sourceUrl = allowedUrl(source);
  let imageUrl = sourceUrl;
  if (!isImageUrl(sourceUrl)) {
    if (!/\.html$/i.test(sourceUrl.pathname)) throw new AppError(422, 'POSTER_URL_INVALID', 'لینک صفحهٔ پوستر یا تصویر مستقیم IMPAwards را وارد کنید.');
    const page = await fetchAllowed(sourceUrl, { fetchFn, maxBytes: MAX_PAGE });
    if (!/html/i.test(page.contentType)) throw new AppError(422, 'POSTER_NOT_PAGE', 'پاسخ سایت یک صفحهٔ HTML نیست.');
    imageUrl = extractPosterUrl(page.data.toString('utf8'), page.url);
  }
  const image = await fetchAllowed(imageUrl, { fetchFn, maxBytes: MAX_IMAGE, referer: sourceUrl.toString() });
  if (!isImageUrl(image.url)) throw new AppError(422, 'POSTER_REDIRECT', 'تصویر پوستر به مسیر غیرمجاز هدایت شد.');
  const ext = imageExtension(image.data);
  const filename = `${crypto.createHash('sha256').update(image.data).digest('hex')}${ext}`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, filename), image.data, { flag: 'wx' }).catch((err) => { if (err.code !== 'EEXIST') throw err; });
  return { path: `/uploads/posters/${filename}`, source: sourceUrl.toString(), imageSource: image.url.toString() };
}
module.exports = { allowedUrl, extractPosterUrl, imageExtension, fetchAllowed, importPoster };
