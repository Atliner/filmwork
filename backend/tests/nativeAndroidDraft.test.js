'use strict';

// Source-level checks only: they do not replace device playback tests.
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

test('Android bridge is main-frame and origin scoped, with a private player activity', async () => {
  const { parse } = await import('java-parser');
  const build = read('apps/android/app/build.gradle');
  const manifest = read('apps/android/app/src/main/AndroidManifest.xml');
  const main = read('apps/android/app/src/main/java/com/filmwork/app/MainActivity.java');
  assert.doesNotThrow(() => parse(main));
  assert.match(build, /libvlc-all:3\.6\.2/);
  assert.match(build, /androidx\.webkit:webkit/);
  assert.match(manifest, /NativePlayerActivity" android:exported="false"/);
  assert.match(main, /WEB_MESSAGE_LISTENER/);
  assert.match(main, /Collections\.singleton\(origin\)/);
  assert.match(main, /!isMainFrame/);
  assert.match(main, /sourceOrigin/);
  assert.match(main, /safeHttps/);
  assert.doesNotMatch(main, /addJavascriptInterface/);
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


test('native renderer uses managed texture views and split APKs', () => {
  const code = read('apps/android/app/src/experimentalNative/java/com/filmwork/app/NativePlayerActivity.java');
  const build = read('apps/android/app/build.gradle');
  assert.match(code, /VLCVideoLayout/);
  assert.match(code, /player\.attachViews\(videoLayout, null, true, true\)/);
  assert.match(code, /showPlaybackStatus/);
  assert.doesNotMatch(code, /new SurfaceView\(/);
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']) assert.ok(build.includes(abi));
  assert.match(build, /useLegacyPackaging true/);
  assert.match(build, /testInstrumentationRunner/);
});


test('diagnostics are local, privacy-preserving, and available from both screens', async () => {
  const { parse } = await import('java-parser');
  const diagnostics = read('apps/android/app/src/main/java/com/filmwork/app/PlayerDiagnostics.java');
  const application = read('apps/android/app/src/main/java/com/filmwork/app/VizostenApplication.java');
  const main = read('apps/android/app/src/main/java/com/filmwork/app/MainActivity.java');
  const player = read('apps/android/app/src/experimentalNative/java/com/filmwork/app/NativePlayerActivity.java');
  for (const java of [diagnostics, application, main, player]) assert.doesNotThrow(() => parse(java));
  assert.match(application, /installCrashHandler/);
  assert.match(diagnostics, /setDefaultUncaughtExceptionHandler/);
  assert.match(diagnostics, /failureStage/);
  assert.doesNotMatch(diagnostics, /getMessage\(\)|getDataString\(\)|sessionToken|Authorization/);
  assert.match(main, /PlayerDiagnostics\.show/);
  assert.match(player, /PlayerDiagnostics\.show/);
  assert.match(player, /VLC_INITIALIZING/);
  assert.match(player, /catch \(RuntimeException \| LinkageError error\)/);
});


test('native controls are dismissible and subtitle styling never restarts the active stream', () => {
  const code = read('apps/android/app/src/experimentalNative/java/com/filmwork/app/NativePlayerActivity.java');
  assert.match(code, /setControlsVisible\(!controlsVisible\)/);
  assert.match(code, /postDelayed\(hideControls, 4000\)/);
  assert.match(code, /saveDeferredSubtitleStyle/);
  assert.doesNotMatch(code, /recreateEngine|promptTrackUrl|افزودن لینک/);
});


test('landscape uses immersive bars while video and controls have separate inset layouts', () => {
  const code = read('apps/android/app/src/experimentalNative/java/com/filmwork/app/NativePlayerActivity.java');
  assert.match(code, /controller\.hide\(WindowInsets\.Type\.systemBars\(\)\)/);
  assert.match(code, /controller\.show\(WindowInsets\.Type\.systemBars\(\)\)/);
  assert.match(code, /videoHost\.addView\(videoLayout/);
  assert.match(code, /content\.setPadding\(left, top, right, bottom\)/);
  assert.match(code, /pendingSubtitleId = null/);
});
