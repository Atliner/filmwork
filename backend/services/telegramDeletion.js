'use strict';

const crypto = require('crypto');
const { query } = require('../config/db');
const { downloadBotService } = require('../bots/downloadBot');

// Telegram only permits deleting messages for 48 hours. Keep a safety margin for
// downtime/retries; the setting is captured when each message is sent.
async function scheduleDeletion(chatId, message, minutes, deps = {}) {
  const delay = Number(minutes);
  if (!delay) return true;
  const messageId = message?.message_id;
  if (!messageId || !chatId || !Number.isInteger(delay) || delay < 1 || delay > 2760) {
    console.error('Cannot schedule Telegram message deletion: invalid message or delay');
    return false;
  }
  const run = deps.query || query;
  const bot = deps.bot || downloadBotService;
  try {
    await run(`INSERT INTO telegram_deletion_queue (chat_id, message_id, delete_after, expires_at)
      VALUES (:chatId, :messageId, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL :minutes MINUTE), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 47 HOUR))`,
    { chatId, messageId, minutes: delay });
    return true;
  } catch (error) {
    // Sending and SQL cannot be atomic. Do not silently leave a newly delivered
    // message behind if queue insertion failed; try deleting it immediately.
    console.error('Could not persist Telegram deletion; attempting immediate deletion:', error.message);
    try { await bot.deleteMessage(chatId, messageId); }
    catch (deleteError) { console.error('Immediate Telegram deletion failed; manual intervention required:', deleteError.message); }
    return false;
  }
}

async function processDeletions(deps = {}) {
  const run = deps.query || query;
  const bot = deps.bot || downloadBotService;
  const lease = crypto.randomUUID();
  // Atomic claim works across Passenger processes and recovers a crashed worker.
  await run(`UPDATE telegram_deletion_queue SET lease_token = :lease, lease_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE)
    WHERE failed = FALSE AND delete_after <= UTC_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until < UTC_TIMESTAMP(3))
    ORDER BY delete_after, id LIMIT 25`, { lease });
  const rows = await run('SELECT * FROM telegram_deletion_queue WHERE lease_token = :lease ORDER BY id', { lease });
  for (const row of rows) {
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      console.error('Telegram deletion expired before it could be completed:', row.id);
      await run("UPDATE telegram_deletion_queue SET failed = TRUE, lease_token = NULL, lease_until = NULL, last_error = 'expired before deletion' WHERE id = :id AND lease_token = :lease", { id: row.id, lease });
      continue;
    }
    try {
      await bot.deleteMessage(row.chat_id, row.message_id);
      await run('DELETE FROM telegram_deletion_queue WHERE id = :id AND lease_token = :lease', { id: row.id, lease });
    } catch (error) {
      const description = String(error?.response?.description || error.message || error);
      if (/message to delete not found/i.test(description)) {
        await run('DELETE FROM telegram_deletion_queue WHERE id = :id AND lease_token = :lease', { id: row.id, lease });
      } else {
        console.error('Telegram deletion failed; will retry:', description);
        await run(`UPDATE telegram_deletion_queue SET lease_token = NULL, lease_until = NULL,
          delete_after = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE), attempts = attempts + 1, last_error = :error
          WHERE id = :id AND lease_token = :lease`, { id: row.id, lease, error: description.slice(0, 500) });
      }
    }
  }
}
module.exports = { scheduleDeletion, processDeletions };
