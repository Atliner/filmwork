'use strict';
process.env.DB_HOST ||= '127.0.0.1'; process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test'; process.env.DB_PASSWORD ||= 'unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTelegramMessage, prepareChanges, revision } = require('../services/mediaAdmin');
function sample() { return { public_id:'x', version_label:'test', resolution:'720p', is_active:1, audio_type:'soft_sub', subtitle_type:'separate', file_size_bytes:100,
  tg_link_primary:'https://t.me/c/123/10', primary_chat_id:-100123, primary_message_id:10,
  subtitle_link_primary:'https://t.me/c/123/11', subtitle_primary_message_id:11,
  tg_link_fallback_1:'https://t.me/c/456/20', fallback_1_chat_id:-100456, fallback_1_message_id:20,
  tg_link_fallback_2:'https://t.me/c/789/30', fallback_2_chat_id:-100789, fallback_2_message_id:30 }; }
test('message URLs are parsed strictly and derive source IDs', () => {
  assert.deepEqual(parseTelegramMessage('https://t.me/c/123/42'), { url:'https://t.me/c/123/42', chatId:'-100123', username:null, messageId:42 });
  for (const url of ['https://evil.test/c/123/1','https://t.me/c/123/1?x=1','https://t.me/c/123/0','https://t.me/c/123/1/2','http://t.me/c/123/1','https://t.me/joinchat/123']) assert.throws(() => parseTelegramMessage(url));
});
test('changing a replica updates chat and message together and preserves other replicas', async () => {
  const row = sample();
  const result = await prepareChanges(row, { tg_link_fallback_1:'https://t.me/c/999/33', quality_label:'WEB-DL' });
  assert.deepEqual(result.changed, { quality_label:'WEB-DL', tg_link_fallback_1:'https://t.me/c/999/33', fallback_1_chat_id:'-100999', fallback_1_message_id:33 });
  assert.equal(result.replicaChanged, true);
});
test('changing a channel requires its subtitle to be moved or removed', async () => {
  const row = sample();
  await assert.rejects(prepareChanges(row, { tg_link_primary:'https://t.me/c/999/33' }), {code:'SUBTITLE_CHANNEL_MISMATCH'});
  await assert.rejects(prepareChanges(row, { tg_link_primary:'https://t.me/c/999/33', subtitle_link_primary:'https://t.me/c/123/44' }), {code:'SUBTITLE_CHANNEL_MISMATCH'});
  const changed = await prepareChanges(row, { tg_link_primary:'https://t.me/c/999/33', subtitle_link_primary:'https://t.me/c/999/44' });
  assert.equal(changed.changed.primary_chat_id, '-100999'); assert.equal(changed.changed.subtitle_primary_message_id, 44);
  const cleared = await prepareChanges(row, { tg_link_primary:'https://t.me/c/999/33', subtitle_link_primary:'' });
  assert.equal(cleared.changed.subtitle_primary_message_id, null);
});
test('public channel is resolved safely and fallback holes are rejected', async () => {
  const row = sample();
  const changed = await prepareChanges(row, { tg_link_fallback_1:'https://t.me/sample_channel/88' }, async name => { assert.equal(name,'@sample_channel'); return {id:-100999}; });
  assert.equal(changed.changed.fallback_1_chat_id, '-100999'); assert.equal(changed.changed.fallback_1_message_id, 88);
  await assert.rejects(prepareChanges(row, { tg_link_fallback_1:'' }), {code:'INVALID_REPLICAS'});
});
test('revision detects concurrent replica and metadata changes; protected fields rejected', async () => {
  const row = sample();
  assert.notEqual(revision(row), revision({ ...row, fallback_2_message_id:31 }));
  assert.notEqual(revision(row), revision({ ...row, version_label:'changed' }));
  await assert.rejects(prepareChanges(row, { primary_chat_id:123 }), {code:'VALIDATION_ERROR'});
  await assert.rejects(prepareChanges(row, { file_size_bytes:0 }), {code:'VALIDATION_ERROR'});
});

test('fourth replica can be edited together with its subtitle', async () => {
  const row = { ...sample(), tg_link_fallback_3:'https://t.me/c/444/4', fallback_3_chat_id:-100444, fallback_3_message_id:4,
    subtitle_link_fallback_3:'https://t.me/c/444/14', subtitle_fallback_3_message_id:14 };
  const changed = await prepareChanges(row, {tg_link_fallback_3:'https://t.me/c/555/50',subtitle_link_fallback_3:'https://t.me/c/555/51'});
  assert.equal(changed.changed.fallback_3_chat_id,'-100555'); assert.equal(changed.changed.fallback_3_message_id,50);
  assert.equal(changed.changed.subtitle_fallback_3_message_id,51);
  await assert.rejects(prepareChanges(row,{tg_link_fallback_2:''}),{code:'INVALID_REPLICAS'});
});
