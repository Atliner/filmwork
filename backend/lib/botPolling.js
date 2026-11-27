'use strict';

// Telegraf.launch() for polling resolves only when polling ends, not when it
// starts. Start its documented polling lifecycle explicitly so shutdown and
// retries can see the real state while getUpdates is running.
async function startPolling(service, bot, allowedUpdates) {
  bot.botInfo = await bot.telegram.getMe();
  if (service.bot !== bot) return false;
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  if (service.bot !== bot) return false;
  const task = bot.startPolling(allowedUpdates);
  service.started = true;
  service.pollingTask = task;
  task.then(
    () => pollingEnded(service, bot, null),
    (error) => pollingEnded(service, bot, error),
  );
  return true;
}

function pollingEnded(service, bot, error) {
  if (service.bot !== bot) return;
  service.bot = null;
  service.started = false;
  service.pollingTask = null;
  if (service.onPollingStopped) service.onPollingStopped(error || new Error('Telegram polling stopped unexpectedly'));
}

async function stopPolling(service, reason) {
  const bot = service.bot;
  const task = service.pollingTask;
  // Mark it stale first: a late startup or failure must not restart this bot.
  service.bot = null;
  service.started = false;
  service.pollingTask = null;
  try { bot?.stop(reason); } catch { /* startup had not reached polling */ }
  if (task) {
    let timer;
    await Promise.race([
      task.catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, 4000); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
  }
}

module.exports = { startPolling, stopPolling };
