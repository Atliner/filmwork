'use strict';

/**
 * Regression tests for two deployment failures that produced a 503 on the whole
 * domain:
 *
 * 1. `server.js` listened only under `require.main === module`. Passenger (cPanel
 *    "Setup Node.js App", LiteSpeed) imports the startup file, so the app never
 *    bound a port. `app.js` is now the startup file and always starts the app.
 * 2. A production startup error (bad `APP_URL`, unreachable database) crashed the
 *    process, which Passenger surfaces as a bare 503.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const backendDir = path.join(__dirname, '..');

// Point dotenv at an empty file so a developer's local backend/.env cannot make the
// assertions non-deterministic (or hand the child a database port that is in use).
const emptyEnvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'filmwork-env-')), 'empty.env');
fs.writeFileSync(emptyEnvFile, '');

function runNode(args, env = {}) {
  return spawnSync(process.execPath, ['-e', args], {
    cwd: backendDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      DOTENV_CONFIG_PATH: emptyEnvFile,
      FILMWORK_BOOT_PAGE: '0',
      ...env,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

const BASE_ENV = {
  DB_HOST: '127.0.0.1',
  DB_NAME: 'filmwork_test',
  DB_USER: 'filmwork_test',
  DB_PASSWORD: 'not-used',
  JWT_SECRET: 'a'.repeat(64),
  AUTH_CODE_PEPPER: 'b'.repeat(64),
  PHONE_ENCRYPTION_KEY: 'c'.repeat(64),
};

test('a broken APP_URL fails with a message the owner can act on', () => {
  const result = runNode("require('./app.js')", {
    ...BASE_ENV,
    APP_URL: 'stream.example.com',
  });
  assert.match(result.stderr, /APP_URL must be an absolute URL/);
  assert.doesNotMatch(result.stderr, /\/api\/health/);
});

test('production requires the full Telegram configuration before serving', () => {
  const result = runNode("require('./app.js')", {
    ...BASE_ENV,
    APP_URL: 'https://stream.example.com',
    AUTH_BOT_TOKEN: '123456789:' + 'A'.repeat(35),
    AUTH_BOT_USERNAME: 'filmwork_login_bot',
  });
  assert.match(result.stderr, /ADMIN_BOT_TOKEN is required in production/);
});

test('chat ids must be numeric so storage replication cannot fail later', () => {
  const result = runNode("require('./app.js')", {
    ...BASE_ENV,
    APP_URL: 'https://stream.example.com',
    AUTH_BOT_TOKEN: '123456789:' + 'A'.repeat(35),
    AUTH_BOT_USERNAME: 'filmwork_login_bot',
    DOWNLOAD_BOT_TOKEN: '123456780:' + 'C'.repeat(35),
    DOWNLOAD_BOT_USERNAME: 'filmwork_files_bot',
    ADMIN_BOT_TOKEN: '987654321:' + 'B'.repeat(35),
    ADMIN_OWNER_IDS: '123456789',
    TELEGRAM_PRIMARY_CHAT_ID: 'https://t.me/mychannel',
    TELEGRAM_FALLBACK_1_CHAT_ID: '-1002222222222',
    TELEGRAM_FALLBACK_2_CHAT_ID: '-1003333333333',
  });
  assert.match(result.stderr, /TELEGRAM_PRIMARY_CHAT_ID must be a numeric Telegram chat id/);
});

test('server.js stays importable without side effects for unit tests', () => {
  const result = runNode(`const mod = require('./server.js');
    process.stdout.write(JSON.stringify({ exports: Object.keys(mod).sort() }));
    process.exit(0);`, { ...BASE_ENV, NODE_ENV: 'development' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.exports.includes('app'));
  assert.ok(parsed.exports.includes('start'));
});
