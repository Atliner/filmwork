'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test';
process.env.DB_PASSWORD ||= 'not-used-by-boot-tests';

const {
  renderBootError,
  missingVariables,
  sanitizeMessage,
} = require('../lib/bootError');

test('lists only variable names, never their values', () => {
  const missing = missingVariables({
    NODE_ENV: 'production',
    DB_HOST: 'localhost',
    DB_NAME: 'db',
    DB_USER: 'user',
    DB_PASSWORD: 'super-secret',
    JWT_SECRET: 'x'.repeat(64),
  });
  assert.ok(missing.includes('AUTH_CODE_PEPPER'));
  assert.ok(missing.includes('PHONE_ENCRYPTION_KEY'));
  assert.ok(missing.includes('APP_URL'));
  assert.ok(!missing.includes('DB_PASSWORD'), 'configured variables must not be reported');
});

test('redacts bot tokens and passwords from the reported error', () => {
  const message = sanitizeMessage('request to https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe failed');
  assert.ok(!message.includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'));
  assert.ok(message.includes('<redacted>'));

  const passwordMessage = sanitizeMessage('Access denied for user "filmwork" (password=Hunter2)');
  assert.ok(!passwordMessage.includes('Hunter2'));
});

test('renders an actionable page instead of a bare 503', () => {
  const html = renderBootError(new Error('APP_URL must use HTTPS in production'), {
    NODE_ENV: 'production',
  });
  assert.ok(html.includes('برنامه بالا نیامد'));
  assert.ok(html.includes('APP_URL must use HTTPS in production'));
  assert.ok(html.includes('APP_URL'), 'the checklist should mention APP_URL');
  assert.ok(html.includes('noindex'), 'the diagnostic page must not be indexed');
  assert.ok(html.includes('<code>DB_HOST</code>'), 'missing variables are listed by name');
  assert.ok(!html.includes('DATABASE_PASSWORD_VALUE'));
});
