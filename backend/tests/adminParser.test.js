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
    separateAudio: false,
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

test('reads Telegram widget HTML including entities, avoiding the old undefined decoder', async () => {
  const { fetchPublicTelegramPost } = require('../bots/adminBot');
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://t.me/Vizosten/72?embed=1&mode=tme');
      return new Response('<div class="tgme_widget_message_text js-message_text">نام: پیت<br>کارگردان: نام &amp; نام<br>سال: &#50;026</div>', { status: 200 });
    };
    const text = await fetchPublicTelegramPost('https://t.me/Vizosten/72');
    assert.equal(text, 'نام: پیت\nکارگردان: نام & نام\nسال: 2026');
  } finally { globalThis.fetch = old; }
});

test('Telegram link errors are actionable and pasted text never requires a network call', async () => {
  const { fetchPublicTelegramPost } = require('../bots/adminBot');
  const { buildParseDraft } = require('../lib/contentParams');
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('network unreachable'); };
    await assert.rejects(fetchPublicTelegramPost('https://t.me/Vizosten/72'), (error) => error.code === 'TELEGRAM_UNREACHABLE' && error.status === 502);
    const draft = await buildParseDraft({ text: 'نام فارسی: پیت\nسال: 2025', link: 'https://t.me/Vizosten/72' });
    assert.equal(draft.fields.titleFa, 'پیت');
    assert.equal(draft.source.label, 'text');
    await assert.rejects(fetchPublicTelegramPost('https://t.me.evil.example/Vizosten/72'), (error) => error.status === 422);
  } finally { globalThis.fetch = old; }
});

test('only asset, version and type hashtags are required', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const parsed = parseDirectives(`#اثر ${uuid} #نسخه DigiMovies #نوع دوبله`);
  assert.equal(parsed.assetUuid, uuid);
  assert.equal(parsed.audioType, 'dubbed');
  assert.equal(parsed.resolution, null);
  assert.equal(parsed.subtitleType, null);
  assert.match(parseDirectives(`#اثر ${uuid} #نوع دوبله`).error, /#نسخه/);
  assert.match(parseDirectives(`#اثر ${uuid} #نسخه DigiMovies`).error, /#نوع/);
  assert.match(parseDirectives(`#اثر ${uuid} #نسخه #نوع دوبله`).error, /#نسخه/);
});

test('infers season, episode, resolution, quality and encoder from a Telegram filename', () => {
  const { resolveMediaDirectives } = require('../bots/adminBot');
  const d = parseDirectives('#اثر 550e8400-e29b-41d4-a716-446655440000 #نسخه DigiMovies #نوع دوبله');
  const result = resolveMediaDirectives(d, 'The.Pitt.S02.E15.720p.WEB-DL.Doble.mp4');
  assert.equal(result.seasonNumber, 2);
  assert.equal(result.episodeNumber, 15);
  assert.equal(result.resolution, '720p');
  assert.equal(result.quality, 'WEB-DL');
  assert.equal(result.audioType, 'dubbed');
  assert.equal(result.subtitleType, 'none');
  assert.equal(result.encoder, null);
  const extra = resolveMediaDirectives(d, 'Show.S01E02.1080p.WEBRip.x265.SoftSub.mkv');
  assert.equal(extra.episodeNumber, 2);
  assert.equal(extra.subtitleType, 'embedded');
  assert.equal(extra.encoder, 'x265');
});

test('explicit optional directives override the filename; unknown fields are not invented', () => {
  const { resolveMediaDirectives } = require('../bots/adminBot');
  const d = parseDirectives('#اثر 550e8400-e29b-41d4-a716-446655440000 #نسخه A #نوع سافتساب #سریال S03.E04 #رزولوشن 480p #زیرنویس مجزا #کیفیت Bluray #انکودر x264');
  const parsed = resolveMediaDirectives(d, 'The.Pitt.S02.E15.720p.WEB-DL.x265.SoftSub.mp4');
  assert.equal(parsed.seasonNumber, 3);
  assert.equal(parsed.episodeNumber, 4);
  assert.equal(parsed.resolution, '480p');
  assert.equal(parsed.subtitleType, 'separate');
  assert.equal(parsed.quality, 'Bluray');
  assert.equal(parsed.encoder, 'x264');
  const unknown = resolveMediaDirectives(parseDirectives('#اثر 550e8400-e29b-41d4-a716-446655440000 #نسخه A #نوع دوبله'), 'random-file.mp4');
  assert.equal(unknown.resolution, 'نامشخص');
  assert.equal(unknown.seasonNumber, null);
  assert.equal(unknown.episodeNumber, null);
  assert.equal(unknown.subtitleType, 'none');
  assert.equal(resolveMediaDirectives(unknown, null).resolution, 'نامشخص');
});
