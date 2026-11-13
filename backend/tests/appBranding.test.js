'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Vizosten browser and PWA branding reference shipped assets', () => {
  const html = read('frontend/index.html');
  const manifest = JSON.parse(read('frontend/manifest.webmanifest'));
  assert.match(html, /<title>Vizosten \| ویزوستن<\/title>/);
  assert.match(html, /href="\/favicon.ico"/);
  const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  assert.match(header, /<span class="brand-name">Vizosten<\/span>/);
  assert.doesNotMatch(header, /<img\b/);
  assert.doesNotMatch(html, /سینمای شخصی شما/);
  const worker = read('frontend/sw.js');
  for (const asset of ['/styles.css?v=5', '/app.js?v=5']) {
    assert.ok(html.includes(asset));
    assert.ok(worker.includes(asset));
  }
  assert.match(worker, /SHELL_PATHS\.has\(url\.pathname\)/);
  assert.equal(manifest.name, 'Vizosten | ویزوستن');
  for (const file of ['frontend/favicon.ico', 'frontend/icons/icon-192.png', 'frontend/icons/icon-512.png', 'frontend/icons/splash.jpg']) {
    assert.ok(fs.statSync(path.join(root, file)).size > 0, file);
  }
  assert.match(html, /src="\/icons\/splash.jpg"/);
  assert.match(read('frontend/app.js'), /document\.title = 'Vizosten \| ویزوستن'/);
});

test('native Android consumes insets after applying them to its content', () => {
  const activity = read('apps/android/app/src/main/java/com/filmwork/app/MainActivity.java');
  assert.match(activity, /content\.setPadding\(left, top, right, bottom\)/);
  assert.match(activity, /return WindowInsets\.CONSUMED/);
  assert.match(activity, /consumeDisplayCutout\(\)/);
  assert.match(activity, /MAX_SPLASH_MS = 3500/);
});

test('Windows release does not open a console and retains native window controls', () => {
  const main = read('apps/desktop/src-tauri/src/main.rs');
  const config = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
  assert.match(main, /windows_subsystem = "windows"/);
  assert.notEqual(config.app.windows[0].decorations, false);
  assert.match(read('apps/desktop/src-tauri/src/lib.rs'), /DwmSetWindowAttribute/);
});
