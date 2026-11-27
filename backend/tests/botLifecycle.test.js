'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startPolling, stopPolling } = require('../lib/botPolling');
const { BotLeader } = require('../lib/botLeader');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('polling becomes ready without waiting for the long-running loop; shutdown stops it', async () => {
  const running = deferred();
  const events = [];
  const bot = { telegram: { getMe: async () => ({ id: 1 }), deleteWebhook: async (opts) => events.push(opts) }, startPolling: () => running.promise, stop: () => { events.push('stop'); running.resolve(); } };
  const service = { bot, started: false };
  assert.equal(await startPolling(service, bot, ['message']), true);
  assert.equal(service.started, true);
  assert.deepEqual(events[0], { drop_pending_updates: false });
  await stopPolling(service, 'shutdown');
  assert.equal(service.started, false);
  assert.equal(service.bot, null);
  assert.equal(events[1], 'stop');
});

test('polling failure clears status and notifies retry; intentional stop does not', async () => {
  const task = deferred();
  const bot = { telegram: { getMe: async () => ({}), deleteWebhook: async () => {} }, startPolling: () => task.promise, stop: () => task.resolve() };
  const errors = [];
  const service = { bot, onPollingStopped: (error) => errors.push(error.message) };
  await startPolling(service, bot, []);
  task.reject(new Error('Telegram 409'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.bot, null);
  assert.equal(service.started, false);
  assert.deepEqual(errors, ['Telegram 409']);
  const task2 = deferred();
  const bot2 = { telegram: bot.telegram, startPolling: () => task2.promise, stop: () => task2.resolve() };
  service.bot = bot2;
  await startPolling(service, bot2, []);
  await stopPolling(service, 'shutdown');
  assert.deepEqual(errors, ['Telegram 409']);
});

test('stopping during getMe prevents a late startup from polling', async () => {
  const me = deferred(); let polled = false;
  const bot = { telegram: { getMe: () => me.promise, deleteWebhook: async () => {} }, startPolling: () => { polled = true; }, stop: () => { throw new Error('not running'); } };
  const service = { bot };
  const starting = startPolling(service, bot, []);
  await stopPolling(service, 'shutdown');
  me.resolve({});
  assert.equal(await starting, false);
  assert.equal(polled, false);
});

function fakePool() {
  let holder = null;
  const pool = { async getConnection() {
    const c = { released: false, destroyed: false, async execute(sql) {
      if (sql.includes('GET_LOCK')) { if (holder) return [[{ acquired: 0 }]]; holder = c; return [[{ acquired: 1 }]]; }
      if (sql.includes('IS_USED_LOCK')) return [[{ owned: holder === c ? 1 : 0 }]];
      if (sql.includes('RELEASE_LOCK')) { if (holder === c) holder = null; return [[{}]]; }
      throw new Error('unexpected query');
    }, release() { c.released = true; }, destroy() { c.destroyed = true; if (holder === c) holder = null; } };
    return c;
  }, lose() { holder = null; } };
  return pool;
}

test('only one worker leads; standby takes over after shutdown', async () => {
  const pool = fakePool();
  const one = new BotLeader(pool, () => {}, { name: 'test' });
  const two = new BotLeader(pool, () => {}, { name: 'test' });
  assert.equal(await one.acquire(), true);
  assert.equal(await two.acquire(), false);
  await one.close();
  assert.equal(await two.acquire(), true);
  await two.close();
});

test('lost leader lock stops polling via loss handler and can be reacquired', async () => {
  const pool = fakePool(); let losses = 0;
  const leader = new BotLeader(pool, async () => { losses++; }, { name: 'test' });
  assert.equal(await leader.acquire(), true);
  pool.lose();
  await leader.check();
  assert.equal(losses, 1);
  assert.equal(leader.connection, null);
  assert.equal(await leader.acquire(), true);
  await leader.close();
});

test('all three services start and stop while Telegram polling remains pending', async () => {
  process.env.DB_HOST ||= 'localhost'; process.env.DB_NAME ||= 'test'; process.env.DB_USER ||= 'test'; process.env.DB_PASSWORD ||= 'unused';
  process.env.ADMIN_OWNER_IDS = '12345';
  process.env.TELEGRAM_PRIMARY_CHAT_ID = '-100100'; process.env.TELEGRAM_FALLBACK_1_CHAT_ID = '-100101'; process.env.TELEGRAM_FALLBACK_2_CHAT_ID = '-100102';
  process.env.AUTH_BOT_TOKEN = `123456:${'a'.repeat(35)}`;
  process.env.ADMIN_BOT_TOKEN = `123457:${'b'.repeat(35)}`;
  process.env.DOWNLOAD_BOT_TOKEN = `123458:${'c'.repeat(35)}`;
  const { Telegraf, Telegram } = require('telegraf');
  const originals = { getMe: Telegram.prototype.getMe, deleteWebhook: Telegram.prototype.deleteWebhook, startPolling: Telegraf.prototype.startPolling };
  Telegram.prototype.getMe = async () => ({ id: 1, username: 'testbot' });
  Telegram.prototype.deleteWebhook = async () => true;
  Telegraf.prototype.startPolling = function () { const task = deferred(); this.polling = { stop: () => task.resolve() }; return task.promise; };
  try {
    const { AuthBotService } = require('../bots/authBot');
    const { AdminBotService } = require('../bots/adminBot');
    const { DownloadBotService } = require('../bots/downloadBot');
    const services = [new AuthBotService(), new AdminBotService(), new DownloadBotService()];
    services[1].finalizeDueBundles = async () => {};
    for (const service of services) { assert.equal(await service.start(), true); assert.equal(service.started, true); }
    for (const service of services) { await service.stop('test'); assert.equal(service.started, false); assert.equal(service.bot, null); }
    // A standby web worker can send files through Telegram's HTTP API without polling.
    assert.ok(services[2].ensureReady().telegram);
  } finally {
    Object.assign(Telegram.prototype, { getMe: originals.getMe, deleteWebhook: originals.deleteWebhook });
    Telegraf.prototype.startPolling = originals.startPolling;
  }
});

test('restart request creates the Passenger marker in the configured application root', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmwork-restart-test-'));
  try {
    const { requestPassengerRestart } = require('../lib/deployRestart');
    await requestPassengerRestart(dir);
    assert.match(await fs.readFile(path.join(dir, 'tmp', 'restart.txt'), 'utf8'), /^\d+\n$/);
    await requestPassengerRestart(dir);
    assert.ok((await fs.stat(path.join(dir, 'tmp', 'restart.txt'))).isFile());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
