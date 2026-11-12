'use strict';

process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'filmwork_test';
process.env.DB_USER ||= 'filmwork_test';
process.env.DB_PASSWORD ||= 'not-used-by-parser-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDigits,
  parsePublicPost,
  parseDirectives,
} = require('../bots/adminBot');

test('normalizes Persian and Arabic digits', () => {
  assert.equal(normalizeDigits('۱۴۰۳ / ٢٠٢٤'), '1403 / 2024');
});

test('parses a Persian movie channel post', () => {
  const parsed = parsePublicPost(`
🎬 عنوان: Dune Part Two
IMDb: 8.7
سال انتشار: ۲۰۲۴
ژانر: علمی تخیلی، ماجراجویی، درام
خلاصه داستان: پل آتریدیز با چانی و فرمن‌ها متحد می‌شود.
  `);
  assert.deepEqual(parsed, {
    title: 'Dune Part Two',
    imdbScore: 8.7,
    releaseYear: 2024,
    genres: ['علمی تخیلی', 'ماجراجویی', 'درام'],
    description: 'پل آتریدیز با چانی و فرمن‌ها متحد می‌شود.',
    contentType: 'movie',
  });
});

test('parses English series metadata', () => {
  const parsed = parsePublicPost(`Title: Severance\nType: Series\nIMDb Rating: 8.7\nYear: 2022\nGenre: Drama | Mystery\nDescription: Mark leads a team whose memories are divided.`);
  assert.equal(parsed.contentType, 'series');
  assert.equal(parsed.title, 'Severance');
  assert.deepEqual(parsed.genres, ['Drama', 'Mystery']);
});

test('parses all hashtag directives including a separate subtitle bundle', () => {
  const parsed = parseDirectives('#اثر 550e8400-e29b-41d4-a716-446655440000 #نسخه DigiMovies #نوع سافتساب #زیرنویس مجزا #رزولوشن 1080p #سریال S01.E07 #کیفیت WEB-DL #انکودر x265');
  assert.deepEqual(parsed, {
    assetUuid: '550e8400-e29b-41d4-a716-446655440000',
    version: 'DigiMovies',
    sourceType: 'سافتساب',
    audioType: 'soft_sub',
    subtitleType: 'separate',
    resolution: '1080p',
    quality: 'WEB-DL',
    encoder: 'x265',
    seasonNumber: 1,
    episodeNumber: 7,
  });
});

test('rejects malformed directive UUID and episode format', () => {
  assert.match(parseDirectives('#اثر bad #نسخه A #نوع دوبله #زیرنویس داخلی #رزولوشن 720p').error, /UUID/);
  assert.match(parseDirectives('#اثر 550e8400-e29b-41d4-a716-446655440000 #نسخه A #نوع دوبله #زیرنویس داخلی #رزولوشن 720p #سریال episode1').error, /S01\.E01/);
});

test('does not treat arbitrary chat text as metadata', () => {
  assert.equal(parsePublicPost('سلام، این فقط یک پیام عادی است.'), null);
  assert.equal(parseDirectives('#نسخه DigiMovies'), null);
});
