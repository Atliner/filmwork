'use strict';

function normalizedChatId(chatId) {
  const value = String(chatId || '').trim();
  if (!/^-?\d+$/.test(value)) throw new Error(`Invalid Telegram chat id: ${value}`);
  return value;
}

function privateChannelPath(chatId) {
  const value = normalizedChatId(chatId);
  if (value.startsWith('-100')) return value.slice(4);
  if (value.startsWith('-')) return value.slice(1);
  return value;
}

function buildTelegramMessageLink(chatId, messageId, publicUsername = '') {
  const numericMessageId = Number(messageId);
  if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) {
    throw new Error('Invalid Telegram message id');
  }
  const username = String(publicUsername || '').replace(/^@/, '').trim();
  if (username) return `https://t.me/${encodeURIComponent(username)}/${numericMessageId}`;
  return `https://t.me/c/${privateChannelPath(chatId)}/${numericMessageId}`;
}

function mediaFromMessage(message) {
  const source = message?.video || message?.document || message?.audio || null;
  if (!source) return null;
  return {
    fileId: source.file_id,
    uniqueFileId: source.file_unique_id,
    fileName: source.file_name || (message.video ? `${source.file_unique_id}.mp4` : null),
    fileSize: Number(source.file_size || 0),
    mimeType: source.mime_type || (message.video ? 'video/mp4' : 'application/octet-stream'),
    duration: Number(source.duration || 0),
  };
}

function isSubtitleMessage(message) {
  const document = message?.document;
  if (!document) return false;
  const name = String(document.file_name || '').toLowerCase();
  const mime = String(document.mime_type || '').toLowerCase();
  return name.endsWith('.srt') || name.endsWith('.vtt') || mime.includes('subrip') || mime === 'text/vtt';
}

function telegramErrorDescription(error) {
  return String(
    error?.response?.description ||
      error?.description ||
      error?.message ||
      'Unknown Telegram error',
  );
}

function isTelegramDeletionError(error) {
  const description = telegramErrorDescription(error).toLowerCase();
  return [
    'message to copy not found',
    'message_id_invalid',
    'message identifier is not specified',
    'message not found',
  ].some((fragment) => description.includes(fragment));
}

async function probeTelegramLink(url, timeoutMs = 5000) {
  if (!url) return { healthy: false, definitive: true, reason: 'missing_link' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { healthy: false, definitive: true, reason: 'invalid_url' };
  }
  if (parsed.hostname !== 't.me' && parsed.hostname !== 'telegram.me') {
    return { healthy: false, definitive: true, reason: 'unexpected_host' };
  }

  // Private /c/ pages are deliberately opaque to anonymous HTTP clients. Their
  // authoritative health check is copyMessage through the delivery bot.
  if (parsed.pathname.startsWith('/c/')) {
    return { healthy: true, definitive: false, reason: 'private_link_bot_check_required' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Filmwork-LinkMonitor/1.0' },
    });
    if (!response.ok) {
      const definitive = response.status === 404 || response.status === 410;
      return { healthy: false, definitive, reason: `http_${response.status}` };
    }
    const body = (await response.text()).slice(0, 250_000).toLowerCase();
    const deletedMarkers = [
      'message doesn\'t exist',
      'message does not exist',
      'post not found',
      'this message is unavailable',
      'tgme_widget_message_error',
    ];
    const deleted = deletedMarkers.some((marker) => body.includes(marker));
    return {
      healthy: !deleted,
      definitive: true,
      reason: deleted ? 'telegram_deleted_marker' : 'http_ok',
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { healthy: false, definitive: false, reason: 'probe_timeout' };
    }
    return { healthy: false, definitive: false, reason: `network_${error.code || 'error'}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  normalizedChatId,
  privateChannelPath,
  buildTelegramMessageLink,
  mediaFromMessage,
  isSubtitleMessage,
  telegramErrorDescription,
  isTelegramDeletionError,
  probeTelegramLink,
};
