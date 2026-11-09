'use strict';

/**
 * End-to-end regression test for the 503-on-the-domain bug.
 *
 * It boots the real entry point (`app.js`) as a *child process* with the database
 * host pointing nowhere, then asserts that:
 *
 *   - the process keeps running instead of dying (Passenger shows 503 when it dies),
 *   - the port is open and answers with the diagnostic page,
 *   - the page explains the failure without leaking credentials.
 *
 * A second case checks the Passenger contract itself: importing `app.js` must start
 * listening even though the module is not `require.main`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const backendDir = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      return { status: response.status, body: await response.text() };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`Nothing answered on port ${port}: ${lastError?.message}`);
}

function writeEnvFile(contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'filmwork-e2e-')), '.env');
  fs.writeFileSync(file, contents);
  return file;
}

test('the process serves a diagnostic page instead of dying (no bare 503)', async (t) => {
  const port = await freePort();
  const envFile = writeEnvFile([
    'NODE_ENV=production',
    `PORT=${port}`,
    'APP_URL=https://stream.example.com',
    'DB_HOST=127.0.0.1',
    'DB_PORT=3399', // nothing listens here
    'DB_NAME=filmwork',
    'DB_USER=filmwork',
    'DB_PASSWORD=do-not-print-this-password',
    `JWT_SECRET=${'a'.repeat(64)}`,
    `AUTH_CODE_PEPPER=${'b'.repeat(64)}`,
    `PHONE_ENCRYPTION_KEY=${'c'.repeat(64)}`,
    'AUTH_BOT_TOKEN=123456789:' + 'A'.repeat(40),
    'AUTH_BOT_USERNAME=filmwork_login_bot',
    'ADMIN_BOT_TOKEN=987654321:' + 'B'.repeat(40),
    'ADMIN_OWNER_IDS=123456789',
    'TELEGRAM_PRIMARY_CHAT_ID=-1001111111111',
    'TELEGRAM_FALLBACK_1_CHAT_ID=-1002222222222',
    'TELEGRAM_FALLBACK_2_CHAT_ID=-1003333333333',
    'BOOT_RETRY_SECONDS=3600',
    '',
  ].join('\n'));

  const child = spawn(process.execPath, ['app.js'], {
    cwd: backendDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOTENV_CONFIG_PATH: envFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(() => child.kill('SIGKILL'));

  const response = await waitForHttp(port);
  assert.notEqual(child.exitCode, 0, 'the process must still be running');
  assert.equal(response.status, 500);
  assert.ok(response.body.includes('برنامه بالا نیامد'), 'renders the Persian diagnostic page');
  assert.ok(response.body.includes('ECONNREFUSED'), 'names the real cause');
  assert.ok(!response.body.includes('do-not-print-this-password'), 'never leaks DB_PASSWORD');
  assert.ok(!response.body.includes('A'.repeat(40)), 'never leaks bot tokens');
  assert.match(stderr, /Filmwork failed to start/);
});

test('importing app.js (the Passenger path) starts the HTTP server', async (t) => {
  const port = await freePort();
  const envFile = writeEnvFile([
    'NODE_ENV=production',
    `PORT=${port}`,
    'APP_URL=https://stream.example.com',
    'DB_HOST=127.0.0.1',
    'DB_PORT=3399',
    'DB_NAME=filmwork',
    'DB_USER=filmwork',
    'DB_PASSWORD=unused',
    `JWT_SECRET=${'a'.repeat(64)}`,
    `AUTH_CODE_PEPPER=${'b'.repeat(64)}`,
    `PHONE_ENCRYPTION_KEY=${'c'.repeat(64)}`,
    'AUTH_BOT_TOKEN=123456789:' + 'A'.repeat(40),
    'AUTH_BOT_USERNAME=filmwork_login_bot',
    'ADMIN_BOT_TOKEN=987654321:' + 'B'.repeat(40),
    'ADMIN_OWNER_IDS=123456789',
    'TELEGRAM_PRIMARY_CHAT_ID=-1001111111111',
    'TELEGRAM_FALLBACK_1_CHAT_ID=-1002222222222',
    'TELEGRAM_FALLBACK_2_CHAT_ID=-1003333333333',
    'BOOT_RETRY_SECONDS=3600',
    '',
  ].join('\n'));

  // `-e 'require("./app.js")'` mimics Passenger: the startup file is imported, not run.
  const child = spawn(process.execPath, ['-e', 'require("./app.js")'], {
    cwd: backendDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOTENV_CONFIG_PATH: envFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));

  const response = await waitForHttp(port);
  assert.equal(response.status, 500, 'still answers (no silent exit, no 503)');
  assert.match(response.body, /برنامه بالا نیامد/);
});
