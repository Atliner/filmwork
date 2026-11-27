'use strict';
const { AppError } = require('./errors');

function titleId(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new AppError(422, 'IMDB_URL_INVALID', 'لینک صفحهٔ اثر در IMDb معتبر نیست.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['imdb.com', 'www.imdb.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) {
    throw new AppError(422, 'IMDB_URL_INVALID', 'فقط لینک صفحهٔ اثر در IMDb پذیرفته می‌شود.');
  }
  const match = url.pathname.match(/^\/title\/(tt\d{5,12})\/?$/i);
  if (!match) throw new AppError(422, 'IMDB_URL_INVALID', 'لینک باید به صفحهٔ یک اثر IMDb اشاره کند.');
  return match[1].toLowerCase();
}

// Read only images in mediaviewer links for this title on the poster-filtered
// index; never pick logos, advertisements or unrelated recommendation images.
function extractPosters(html, id, limit) {
  const result = [], seen = new Set();
  const anchors = String(html).match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
  for (const anchor of anchors) {
    const opening = anchor.match(/^<a\b[^>]*>/i)?.[0] || '';
    const href = opening.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    let link;
    try { link = new URL(href.replace(/&amp;/g, '&'), 'https://www.imdb.com'); } catch { continue; }
    if (link.hostname !== 'www.imdb.com' || !new RegExp(`^/title/${id}/mediaviewer/rm[0-9]+/?$`, 'i').test(link.pathname)) continue;
    const tag = anchor.match(/<img\b[^>]*>/i)?.[0] || '';
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&');
    let image;
    try { image = new URL(src); } catch { continue; }
    if (image.protocol !== 'https:' || image.hostname !== 'm.media-amazon.com' || image.port || image.username || image.password || !/^\/images\/M\/MV5[A-Za-z0-9_@.,%-]+\.(?:jpe?g|png|webp)$/i.test(image.pathname) || image.search || image.hash) continue;
    // The URL is used as returned by IMDb rather than guessing original files.
    const key = image.pathname.replace(/\._V1_.*(?=\.(?:jpg|jpeg|png|webp)$)/i, '');
    if (!seen.has(key)) { seen.add(key); result.push(image.toString()); }
    if (result.length >= limit) break;
  }
  return result;
}
async function imdbPosters(raw, limit, fetchFn = globalThis.fetch) {
  const id = titleId(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError(422, 'IMDB_COUNT_INVALID', 'تعداد پوستر باید از ۱ تا ۵۰ باشد.');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchFn(`https://www.imdb.com/title/${id}/mediaindex/?refine=poster`, {
      redirect: 'error', signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Filmwork/1.0)', accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
    });
    if (!response.ok) throw new AppError(502, 'IMDB_UPSTREAM', `IMDb پاسخ HTTP ${response.status} داد؛ ممکن است دسترسی هاست را محدود کرده باشد.`);
    if (!/html/i.test(response.headers.get('content-type') || '')) throw new AppError(502, 'IMDB_UNEXPECTED', 'پاسخ IMDb صفحهٔ معتبر نیست.');
    if (Number(response.headers.get('content-length') || 0) > 4000000) throw new AppError(502, 'IMDB_RESPONSE_LARGE', 'پاسخ IMDb بیش از حد بزرگ است.');
    const chunks = []; let length = 0;
    if (!response.body) throw new AppError(502, 'IMDB_UNEXPECTED', 'پاسخ IMDb خالی است.');
    for await (const chunk of response.body) { length += chunk.length; if (length > 4000000) throw new AppError(502, 'IMDB_RESPONSE_LARGE', 'پاسخ IMDb بیش از حد بزرگ است.'); chunks.push(Buffer.from(chunk)); }
    const posters = extractPosters(Buffer.concat(chunks).toString('utf8'), id, limit);
    if (!posters.length) throw new AppError(422, 'IMDB_POSTERS_UNAVAILABLE', 'پوستری در صفحهٔ IMDb پیدا نشد؛ ممکن است دسترسی هاست محدود شده یا ساختار صفحه تغییر کرده باشد.');
    return posters;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'IMDB_UNREACHABLE', 'دسترسی به IMDb ممکن نیست؛ ارتباط خروجی هاست را بررسی کنید.');
  } finally { clearTimeout(timer); }
}
module.exports = { titleId, extractPosters, imdbPosters };
