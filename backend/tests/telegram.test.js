'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  privateChannelPath,
  buildTelegramMessageLink,
  mediaFromMessage,
  isSubtitleMessage,
  isTelegramDeletionError,
} = require('../lib/telegram');

test('builds private and public Telegram message links', () => {
  assert.equal(privateChannelPath('-1001234567890'), '1234567890');
  assert.equal(buildTelegramMessageLink('-1001234567890', 42), 'https://t.me/c/1234567890/42');
  assert.equal(buildTelegramMessageLink('-1001234567890', 42, '@filmwork_store'), 'https://t.me/filmwork_store/42');
});

test('extracts dynamic file metadata and detects subtitle documents', () => {
  const message = {
    document: {
      file_id: 'file',
      file_unique_id: 'unique',
      file_name: 'episode.srt',
      file_size: 9821,
      mime_type: 'application/x-subrip',
    },
  };
  assert.equal(mediaFromMessage(message).fileSize, 9821);
  assert.equal(isSubtitleMessage(message), true);
});

test('distinguishes deleted messages from channel permission failures', () => {
  assert.equal(isTelegramDeletionError({ response: { description: 'Bad Request: message to copy not found' } }), true);
  assert.equal(isTelegramDeletionError({ response: { description: 'Forbidden: bot is not a member of the channel chat' } }), false);
});
