'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countInventory } = require('../lib/mediaCounts');
test('inventory counts versions as rows and every nonempty URL including replicas and playback tracks', () => {
  const media = [{ tg_link_primary:'https://t.me/c/1/1',tg_link_fallback_1:'https://t.me/c/2/1',subtitle_link_primary:'https://t.me/c/1/2',audio_link_primary:'https://t.me/c/1/3',stream_url:'https://cdn/video',playback_audio_url:'https://cdn/audio', playback_subtitle_url:'  ', is_active:0 }];
  const versions = [{links:[{telegramUrl:'https://t.me/c/3/3',streamUrl:'https://cdn/b',subtitleUrl:null,dubUrl:'https://cdn/a'}]}];
  assert.deepEqual(countInventory(media, versions),{versions:2,links:9});
});
