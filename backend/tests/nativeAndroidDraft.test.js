'use strict';

// These tests parse the experimental source and check its integration boundary.
// They do NOT compile the Android project or validate real LibVLC playback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('experimental Android renderer parses as Java and has explicit track controls', async () => {
  const { parse } = await import('java-parser');
  const code = read('apps/android/app/src/experimentalNative/java/com/filmwork/app/NativePlayerActivity.java');
  assert.doesNotThrow(() => parse(code));
  for (const pattern of [/getAudioTracks\(/, /getSpuTracks\(/, /setSpuTrack\(-1\)/,
    /IMedia\.Slave\.Type\.Subtitle/, /IMedia\.Slave\.Type\.Audio/, /setSpuDelay\(/,
    /freetype-rel-fontsize/, /freetype-color/, /freetype-font/, /getUserInfo\(\)/]) {
    assert.match(code, pattern);
  }
});

test('unfinished Android native player is isolated from the release app', () => {
  const build = read('apps/android/app/build.gradle');
  const manifest = read('apps/android/app/src/main/AndroidManifest.xml');
  const main = read('apps/android/app/src/main/java/com/filmwork/app/MainActivity.java');
  assert.match(build, /experimentalNativePlayer/);
  assert.match(build, /src\/experimentalNative\/java/);
  assert.doesNotMatch(manifest, /NativePlayerActivity/);
  assert.doesNotMatch(main, /NativePlayerActivity/);
});

test('experimental ad client parses and follows the current site routes', async () => {
  const { parse } = await import('java-parser');
  const code = read('apps/android/app/src/experimentalNative/java/com/filmwork/app/NativeAdClient.java');
  assert.doesNotThrow(() => parse(code));
  for (const pattern of [/\/api\/ads\/serve\?placement=/, /\/api\/ads\//, /\/events/,
    /X-Ad-Session/, /eventType/, /creativeUrl/, /skipAfterSeconds/, /\/api\/contents\//,
    /positionSeconds/, /durationSeconds/, /Bearer /, /setInstanceFollowRedirects\(false\)/]) {
    assert.match(code, pattern);
  }
  // These source checks do not establish that Android can compile or play an ad.
});
