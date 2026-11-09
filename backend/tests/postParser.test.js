'use strict';

process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test';
process.env.DB_PASSWORD ||= 'not-used-by-parser-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseContentPost,
  buildVersionSuggestions,
  splitTitlePair,
  parseQualities,
  parseRuntime,
} = require('../lib/postParser');

test('reads a full Persian series post', () => {
  const { fields, meta } = parseContentPost(`🎬 The Pitt | پیت
نوع: سریال
سال شروع: ۲۰۲۶
ژانر: درام، پزشکی
کارگردان: R. Scott Gemmill
بازیگران: Noah Wyle، Tracy Ifeachor
کشور: آمریکا
رده سنی: TV-MA
شبکه: HBO Max
امتیاز IMDb: ۸.۹
مدت: ۵۰ دقیقه
کیفیت: 1080p، 720p، 480p
دوبله و زیرنویس فارسی
خلاصه داستان: پزشکان اورژانس پیتسبورگ در یک شیفت پرتنش.`);

  assert.equal(fields.contentType, 'series');
  assert.equal(fields.titleFa, 'پیت');
  assert.equal(fields.titleEn, 'The Pitt');
  assert.equal(fields.releaseYear, 2026);
  assert.deepEqual(fields.genres, ['درام', 'پزشکی']);
  assert.deepEqual(fields.directors, ['R. Scott Gemmill']);
  assert.deepEqual(fields.cast, ['Noah Wyle', 'Tracy Ifeachor']);
  assert.deepEqual(fields.countries, ['آمریکا']);
  assert.equal(fields.ageRating, 'TV-MA');
  assert.equal(fields.network, 'HBO Max');
  assert.equal(fields.imdbScore, 8.9);
  assert.equal(fields.runtimeMinutes, 50);
  assert.deepEqual(fields.qualities, ['1080p', '720p', '480p']);
  assert.equal(fields.hasDub, true);
  assert.equal(fields.hasSub, true);
  assert.match(fields.description, /پزشکان اورژانس/);
  assert.ok(meta.confidence >= 80);
});

test('separates the broadcast status from the free-form note', () => {
  const running = parseContentPost('The Pitt\nنوع: سریال\nوضعیت پخش: در حال پخش\nفصل در حال پخش: ۳');
  assert.equal(running.fields.seriesRunning, true);
  assert.equal(running.fields.currentSeason, 3);
  assert.match(running.fields.broadcastNote, /فصل ۳/);
  assert.match(running.fields.broadcastNote, /هر هفته قسمت جدید/);

  const ended = parseContentPost('The Pitt\nنوع: سریال\nوضعیت پخش: پایان یافته\nفصل در حال پخش: ۲');
  assert.equal(ended.fields.seriesRunning, false);
  assert.equal(ended.fields.currentSeason, null);
  assert.equal(ended.fields.broadcastNote, '');
});

test('keeps a custom broadcast note exactly as typed', () => {
  const { fields } = parseContentPost('پیت\nنوع: سریال\nفصل در حال پخش: ۶\nمتن دلخواه: فصل ۶ — هر جمعه قسمت جدید');
  assert.equal(fields.broadcastNote, 'فصل ۶ — هر جمعه قسمت جدید');
});

test('both titles come out of pipe-separated and single-line formats', () => {
  assert.deepEqual(splitTitlePair('Slow Horses | اسب‌های آرام'), { titleFa: 'اسب‌های آرام', titleEn: 'Slow Horses' });
  assert.deepEqual(splitTitlePair('اسب‌های آرام | Slow Horses'), { titleFa: 'اسب‌های آرام', titleEn: 'Slow Horses' });
  const single = parseContentPost('# Brothers برادران 8.1\nYear: 2024\nGenre: Drama | Thriller').fields;
  assert.equal(single.titleFa, 'برادران');
  assert.equal(single.titleEn, 'Brothers');
  assert.deepEqual(single.genres, ['Drama', 'Thriller']);
});

test('parses English labels and the year range of a series', () => {
  const { fields } = parseContentPost(`Title: Severance
Type: Series
Year: 2022 – 2025
Genre: Drama | Mystery
Director: Ben Stiller
Cast: Adam Scott, Britt Lower
Runtime: 2h 5min
IMDb Rating: 8.7`);
  assert.equal(fields.contentType, 'series');
  assert.equal(fields.releaseYear, 2022);
  assert.equal(fields.lastAirYear, 2025);
  assert.equal(fields.runtimeMinutes, 125);
  assert.equal(fields.imdbScore, 8.7);
});

test('quality and runtime helpers accept messy input', () => {
  assert.deepEqual(parseQualities('', 'کیفیت 1080P و 4K'), ['2160p', '1080p']);
  assert.equal(parseRuntime('۱ ساعت و ۲۰ دقیقه'), 80);
  assert.equal(parseRuntime('45 min'), 45);
});

test('suggested versions follow the detected audio and qualities', () => {
  // Qualities always arrive sorted high → low, whatever the order in the post.
  const { fields } = parseContentPost('X\nژانر: درام\nکیفیت: 1080p، 720p\nدوبله');
  const versions = buildVersionSuggestions(fields);
  assert.deepEqual(versions.map((version) => `${version.kind}:${version.label}`), [
    'sub:1080p', 'sub:720p', 'dub:1080p', 'dub:720p',
  ]);
});

test('an empty post produces an empty report rather than throwing', () => {
  const { fields, meta } = parseContentPost('   ');
  assert.deepEqual(fields, {});
  assert.equal(meta.confidence, 0);
});
