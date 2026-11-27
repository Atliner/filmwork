'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const { assert, AppError } = require('../lib/errors');
const { asHttpUrl } = require('../lib/validation');
const { downloadBotService } = require('../bots/downloadBot');

const FIELDS = [
  'public_id', 'season_number', 'episode_number', 'episode_title', 'version_label',
  'audio_type', 'subtitle_type', 'resolution', 'quality_label', 'encoder',
  'file_size_bytes', 'mime_type', 'stream_url', 'playback_subtitle_url', 'playback_audio_url', 'is_active',
  'tg_link_primary', 'tg_link_fallback_1', 'tg_link_fallback_2', 'tg_link_fallback_3',
  'primary_chat_id', 'primary_message_id', 'fallback_1_chat_id', 'fallback_1_message_id',
  'fallback_2_chat_id', 'fallback_2_message_id', 'fallback_3_chat_id', 'fallback_3_message_id', 'subtitle_link_primary',
  'subtitle_link_fallback_1', 'subtitle_link_fallback_2', 'subtitle_link_fallback_3', 'subtitle_primary_message_id',
  'subtitle_fallback_1_message_id', 'subtitle_fallback_2_message_id', 'subtitle_fallback_3_message_id', 'subtitle_file_size_bytes',
  'audio_link_primary', 'audio_link_fallback_1', 'audio_link_fallback_2', 'audio_link_fallback_3',
  'audio_primary_message_id', 'audio_fallback_1_message_id', 'audio_fallback_2_message_id', 'audio_fallback_3_message_id', 'audio_file_size_bytes',
];
const REPLICAS = [
  { link: 'tg_link_primary', chat: 'primary_chat_id', message: 'primary_message_id', sub: 'subtitle_link_primary', subMessage: 'subtitle_primary_message_id', audio: 'audio_link_primary', audioMessage: 'audio_primary_message_id' },
  { link: 'tg_link_fallback_1', chat: 'fallback_1_chat_id', message: 'fallback_1_message_id', sub: 'subtitle_link_fallback_1', subMessage: 'subtitle_fallback_1_message_id', audio: 'audio_link_fallback_1', audioMessage: 'audio_fallback_1_message_id' },
  { link: 'tg_link_fallback_2', chat: 'fallback_2_chat_id', message: 'fallback_2_message_id', sub: 'subtitle_link_fallback_2', subMessage: 'subtitle_fallback_2_message_id', audio: 'audio_link_fallback_2', audioMessage: 'audio_fallback_2_message_id' },
  { link: 'tg_link_fallback_3', chat: 'fallback_3_chat_id', message: 'fallback_3_message_id', sub: 'subtitle_link_fallback_3', subMessage: 'subtitle_fallback_3_message_id', audio: 'audio_link_fallback_3', audioMessage: 'audio_fallback_3_message_id' },
];
const TEXT = { version_label: [120, true], resolution: [24, true], episode_title: [255, false], quality_label: [80, false], encoder: [100, false], mime_type: [120, false] };
const INTS = { season_number: [1, 65535], episode_number: [1, 65535], file_size_bytes: [1, Number.MAX_SAFE_INTEGER], subtitle_file_size_bytes: [1, Number.MAX_SAFE_INTEGER], audio_file_size_bytes: [1, Number.MAX_SAFE_INTEGER] };
const EDITABLE = new Set([...Object.keys(TEXT), ...Object.keys(INTS), 'stream_url', 'playback_subtitle_url', 'playback_audio_url', 'audio_type', 'subtitle_type', 'is_active', ...REPLICAS.flatMap(r => [r.link, r.sub, r.audio])]);
function revision(row) {
  return crypto.createHash('sha256').update(JSON.stringify(FIELDS.map(key => row[key] == null ? null : String(row[key])))).digest('hex');
}
function dto(row) {
  return { ...Object.fromEntries(FIELDS.map(key => [key, row[key] ?? null])), health_status: row.health_status,
    failure_count: row.failure_count, last_checked_at: row.last_checked_at, created_at: row.created_at, updated_at: row.updated_at, revision: revision(row) };
}
function parseTelegramMessage(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new AppError(422, 'TELEGRAM_LINK_INVALID', 'لینک پیام تلگرام معتبر نیست.'); }
  assert(url.protocol === 'https:' && ['t.me', 'telegram.me'].includes(url.hostname.toLowerCase()) && !url.username && !url.password && !url.port && !url.search && !url.hash, 422, 'TELEGRAM_LINK_INVALID', 'لینک باید نشانی مستقیم پیام t.me بدون پارامتر باشد.');
  const parts = url.pathname.split('/').filter(Boolean);
  const privateMatch = parts.length === 3 && parts[0].toLowerCase() === 'c' && /^[1-9]\d{0,14}$/.test(parts[1]);
  const publicMatch = parts.length === 2 && /^[A-Za-z0-9_]{5,32}$/.test(parts[0]) && !['joinchat'].includes(parts[0].toLowerCase());
  const id = privateMatch ? parts[2] : publicMatch ? parts[1] : '';
  assert(/^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)), 422, 'TELEGRAM_LINK_INVALID', 'لینک باید به یک پیام کانال مانند t.me/c/123/456 اشاره کند.');
  const chatId = privateMatch ? `-100${parts[1]}` : null;
  assert(!chatId || Number.isSafeInteger(Number(chatId)), 422, 'TELEGRAM_LINK_INVALID', 'شناسه کانال خارج از محدوده مجاز است.');
  return { url: `https://t.me/${parts.join('/')}`, chatId, username: publicMatch ? parts[0].toLowerCase() : null, messageId: Number(id) };
}
async function resolveLink(raw, referenceUrl, referenceChat, resolveChat) {
  const parsed = parseTelegramMessage(raw);
  if (parsed.chatId) return parsed;
  let old;
  try { old = parseTelegramMessage(referenceUrl); } catch { /* old records may have legacy URLs */ }
  if (old?.username === parsed.username && referenceChat) parsed.chatId = String(referenceChat);
  else {
    for (const prefix of ['TELEGRAM_PRIMARY', 'TELEGRAM_FALLBACK_1', 'TELEGRAM_FALLBACK_2', 'TELEGRAM_FALLBACK_3']) {
      if (String(process.env[`${prefix}_USERNAME`] || '').replace(/^@/, '').toLowerCase() === parsed.username && process.env[`${prefix}_CHAT_ID`]) parsed.chatId = String(process.env[`${prefix}_CHAT_ID`]);
    }
    if (!parsed.chatId) {
      try { parsed.chatId = String((await resolveChat(`@${parsed.username}`)).id); }
      catch { throw new AppError(422, 'TELEGRAM_CHANNEL_UNRESOLVED', 'شناسه کانال عمومی قابل دریافت نیست؛ ربات دریافت را عضو کانال کنید یا لینک خصوصی پیام را وارد کنید.'); }
    }
  }
  assert(/^-?\d+$/.test(parsed.chatId) && Number.isSafeInteger(Number(parsed.chatId)), 422, 'TELEGRAM_LINK_INVALID', 'شناسه کانال معتبر نیست.');
  return parsed;
}
function cleanPatch(raw) {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 422, 'VALIDATION_ERROR', 'اطلاعات فایل معتبر نیست.');
  const patch = {};
  for (const [key, value] of Object.entries(raw)) {
    assert(EDITABLE.has(key), 422, 'VALIDATION_ERROR', 'فیلد فایل قابل ویرایش نیست.');
    if (key in TEXT) {
      const [max, required] = TEXT[key];
      assert(value == null || typeof value === 'string', 422, 'VALIDATION_ERROR', 'مقدار متنی نامعتبر است.');
      const text = String(value ?? '').trim();
      assert(text.length <= max && (!required || text.length > 0), 422, 'VALIDATION_ERROR', `مقدار ${key} نامعتبر است.`);
      patch[key] = text || null;
    } else if (key in INTS) {
      if (value === '' || value === null) { assert(key !== 'file_size_bytes', 422, 'VALIDATION_ERROR', 'حجم فایل الزامی است.'); patch[key] = null; }
      else { const number = Number(value), [min, max] = INTS[key]; assert(Number.isSafeInteger(number) && number >= min && number <= max, 422, 'VALIDATION_ERROR', `مقدار ${key} نامعتبر است.`); patch[key] = number; }
    } else if (key === 'audio_type' || key === 'subtitle_type') {
      const options = key === 'audio_type' ? ['dubbed', 'hard_sub', 'soft_sub', 'original'] : ['embedded', 'separate', 'none'];
      assert(options.includes(value), 422, 'VALIDATION_ERROR', 'نوع صدا یا زیرنویس معتبر نیست.'); patch[key] = value;
    } else if (key === 'is_active') { assert(typeof value === 'boolean', 422, 'VALIDATION_ERROR', 'وضعیت فایل نامعتبر است.'); patch[key] = value ? 1 : 0; }
    else if (['stream_url', 'playback_subtitle_url', 'playback_audio_url'].includes(key)) patch[key] = value ? asHttpUrl(value, 'لینک پخش') : null;
    else { assert(value == null || typeof value === 'string', 422, 'VALIDATION_ERROR', 'لینک نامعتبر است.'); patch[key] = String(value || '').trim() || null; }
  }
  return patch;
}
async function prepareChanges(row, raw, resolveChat = (name) => downloadBotService.ensureReady().telegram.getChat(name)) {
  const patch = cleanPatch(raw), result = { ...row, ...patch };
  let replicaChanged = false;
  for (const r of REPLICAS) {
    const linkChanged = Object.hasOwn(patch, r.link) && patch[r.link] !== row[r.link];
    const subChanged = Object.hasOwn(patch, r.sub) && patch[r.sub] !== row[r.sub];
    const audioChanged = Object.hasOwn(patch, r.audio) && patch[r.audio] !== row[r.audio];
    if (!linkChanged && !subChanged && !audioChanged) continue;
    replicaChanged = true;
    let video;
    if (linkChanged) {
      video = patch[r.link] ? await resolveLink(patch[r.link], row[r.link], row[r.chat], resolveChat) : null;
      result[r.link] = video?.url || null; result[r.chat] = video?.chatId || null; result[r.message] = video?.messageId || null;
    }
    for (const [track, message, label] of [[r.sub, r.subMessage, 'زیرنویس'], [r.audio, r.audioMessage, 'صوت']]) {
      const trackChanged = Object.hasOwn(patch, track) && patch[track] !== row[track];
      if (trackChanged) {
        const parsed = patch[track] ? await resolveLink(patch[track], video?.url || row[track], video?.chatId || row[r.chat], resolveChat) : null;
        assert(!parsed || (result[r.chat] && String(parsed.chatId) === String(result[r.chat])), 422, 'SUBTITLE_CHANNEL_MISMATCH', `${label} هر نسخه باید در همان کانال فایل باشد.`);
        result[track] = parsed?.url || null; result[message] = parsed?.messageId || null;
      } else if (linkChanged && row[track] && String(result[r.chat] || '') !== String(row[r.chat] || '')) {
        throw new AppError(422, 'SUBTITLE_CHANNEL_MISMATCH', `با تغییر کانال فایل، لینک ${label} همان نسخه را نیز تغییر دهید یا خالی کنید.`);
      }
      assert(!result[track] || result[r.link], 422, 'SUBTITLE_CHANNEL_MISMATCH', `${label} بدون فایل همان کانال قابل ثبت نیست.`);
    }
  }
  if (replicaChanged) assert(!result.tg_link_fallback_2 || result.tg_link_fallback_1, 422, 'INVALID_REPLICAS', 'برای پشتیبان ۲، ابتدا پشتیبان ۱ را وارد کنید.');
  if (replicaChanged) assert(!result.tg_link_fallback_3 || result.tg_link_fallback_2, 422, 'INVALID_REPLICAS', 'برای پشتیبان ۳، ابتدا پشتیبان ۲ را وارد کنید.');
  assert(!result.is_active || result.tg_link_primary, 422, 'INVALID_REPLICAS', 'فایل فعال باید لینک اصلی داشته باشد.');
  const changed = Object.fromEntries(FIELDS.filter(k => k !== 'public_id' && String(result[k] ?? '') !== String(row[k] ?? '')).map(k => [k, result[k]]));
  return { changed, replicaChanged };
}
async function find(assetId, mediaId, connection) {
  const sql = `SELECT ml.* FROM media_links ml JOIN contents c ON c.id = ml.content_id
    WHERE c.asset_uuid = :assetId AND ml.public_id = :mediaId`;
  const rows = connection ? (await connection.execute(`${sql} FOR UPDATE`, { assetId, mediaId }))[0] : await query(sql, { assetId, mediaId });
  assert(rows[0], 404, 'MEDIA_NOT_FOUND', 'فایل پیدا نشد.');
  return rows[0];
}
function checkRevision(row, expected) {
  assert(typeof expected === 'string' && expected === revision(row), 409, 'MEDIA_CONFLICT', 'فایل از زمان باز شدن تغییر کرده است؛ صفحه را بازخوانی و دوباره تلاش کنید.');
}
async function update(assetId, mediaId, expected, rawPatch, deps = {}) {
  const snapshot = await find(assetId, mediaId);
  checkRevision(snapshot, expected);
  const { changed, replicaChanged } = await prepareChanges(snapshot, rawPatch, deps.resolveChat);
  return withTransaction(async (connection) => {
    const row = await find(assetId, mediaId, connection); checkRevision(row, expected);
    const fields = Object.keys(changed);
    if (fields.length) {
      const extra = replicaChanged ? ", health_status = 'unchecked', last_checked_at = NULL" : '';
      await connection.execute(`UPDATE media_links SET ${fields.map(k => `${k} = :${k}`).join(', ')}${extra} WHERE id = :id`, { ...changed, id: row.id });
      // Keep old linked projections coherent without touching unrelated manual rows.
      const updated = { ...row, ...changed };
      await connection.execute(`UPDATE content_version_links SET season_number=:season, episode_number=:episode, episode_title=:title,
        stream_url=IF(:streamChanged, :streamUrl, stream_url), telegram_url=IF(:telegramChanged, :telegramUrl, telegram_url)
        WHERE media_link_id=:id`, { id: row.id, season: updated.season_number, episode: updated.episode_number,
        title: updated.episode_title, streamChanged: Object.hasOwn(changed, 'stream_url') ? 1 : 0, streamUrl: updated.stream_url,
        telegramChanged: Object.hasOwn(changed, 'tg_link_primary') ? 1 : 0, telegramUrl: updated.tg_link_primary });
    }
    return dto(await find(assetId, mediaId, connection));
  });
}
async function remove(assetId, mediaId, expected) {
  await withTransaction(async (connection) => {
    const row = await find(assetId, mediaId, connection); checkRevision(row, expected);
    // FK is SET NULL: delete only projections known to belong to this file, then
    // delete the media row. Unrelated/manual versions and channel messages remain.
    const [projections] = await connection.execute('SELECT version_id FROM content_version_links WHERE media_link_id = :id FOR UPDATE', { id: row.id });
    await connection.execute('DELETE FROM content_version_links WHERE media_link_id = :id', { id: row.id });
    for (const projection of projections) {
      await connection.execute(`DELETE FROM content_versions WHERE id = :id
        AND NOT EXISTS (SELECT 1 FROM content_version_links WHERE version_id = :id)`, { id: projection.version_id });
    }
    await connection.execute('DELETE FROM media_links WHERE id = :id', { id: row.id });
  });
  return { deleted: true };
}
module.exports = { FIELDS, REPLICAS, revision, dto, parseTelegramMessage, resolveLink, prepareChanges, update, remove };
