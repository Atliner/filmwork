'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '../..');
const script = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup({ ad = null, midAd = null, downloadAd = null, sources = [], stored = 0, signedIn = false, mediaItems = [], prices = [], native = false, noNativeBridge = false, streamUrl = 'https://media.example/video.mp4' } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.com/#/player/asset', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const requests = [];
  const nativeMessages = [];
  if (native) {
    Object.defineProperty(w.navigator, 'userAgent', { value: 'Android VizostenAndroid/1.5' });
    if (!noNativeBridge) w.VizostenNative = { postMessage: (message) => nativeMessages.push(JSON.parse(message)) };
  }
  w.scrollTo = () => {};
  w.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 });
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  if (stored) w.localStorage.setItem('vizosten-progress:asset', JSON.stringify({ position: stored }));
  if (signedIn) w.localStorage.setItem('filmwork_session', 'test-token');
  Object.defineProperty(w.HTMLMediaElement.prototype, 'duration', { configurable: true, get() { return 120; } });
  Object.defineProperty(w.HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return !this._playing; } });
  w.HTMLMediaElement.prototype.play = function () { this._playing = true; this.dispatchEvent(new w.Event('play')); this.dispatchEvent(new w.Event('playing')); return Promise.resolve(); };
  w.HTMLMediaElement.prototype.pause = function () { if (this._playing) { this._playing = false; this.dispatchEvent(new w.Event('pause')); } };
  w.HTMLMediaElement.prototype.load = function () {};
  w.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    let data;
    if (url === '/api/config') data = { player: { enabled: true }, placementPrices: prices };
    else if (url === '/api/me') data = { user: { id: '1', accountName: 'آزمایش' } };
    else if (url === '/api/progress') data = { items: [] };
    else if (url === '/api/advertiser/profile') data = { campaigns: [], wallet: { balance: 0, currency: 'IRR' }, analytics: {} };
    else if (url === '/api/contents/asset') data = { content: { id: 'asset', title: 'فیلم', type: 'movie', genres: [], imdbScore: null, streamUrl } };
    else if (url === '/api/contents/asset/media-options') data = { items: mediaItems };
    else if (url === '/api/contents/asset/player-sources') data = { sources };
    else if (String(url).startsWith('/api/ads/serve')) data = { ad: String(url).includes('pre_roll') ? ad : String(url).includes('mid_roll') ? midAd : String(url).includes('banner_download') ? downloadAd : null };
    else if (String(url).startsWith('/api/ads/')) data = { ok: true };
    else if (String(url).includes('subtitle')) return { ok: true, text: async () => String(url).includes('named.vtt') ? 'WEBVTT\n\ncue-name\n00:00:01.000 --> 00:00:04.000 align:start\nمتن وب\n' : '1\n00:00:01,000 --> 00:00:04,000\nسلام\n' };
    else throw new Error(`Unexpected URL ${url}`);
    return { ok: true, json: async () => data };
  };
  w.eval(script);
  const selector = native ? '#native-player-open' : '#video';
  for (let i = 0; i < 30 && !w.document.querySelector(selector); i++) await delay();
  assert.ok(w.document.querySelector(selector), w.document.querySelector('#app').textContent);
  return { dom, w, d: w.document, requests, nativeMessages };
}

test('player adds and selects several subtitles and audio tracks, styles and resumes', async () => {
  const sources = [1, 2].map(n => ({ streamUrl: 'https://media.example/video.mp4', subtitleUrl: `https://media.example/subtitle${n}.srt`, audioUrl: `https://media.example/audio${n}.mp3` }));
  const { dom, w, d } = await setup({ stored: 35, sources });
  try {
    const video = d.querySelector('#video');
    video.dispatchEvent(new w.Event('loadedmetadata'));
    assert.equal(video.currentTime, 35);
    await delay();
    assert.equal(d.querySelector('.source-tools'), null);
    assert.equal(d.querySelector('[data-bind]'), null);
    d.querySelector('#settings-button').click();
    assert.equal(d.querySelectorAll('[data-subtitle-track^="external-"]').length, 2);
    assert.equal(d.querySelectorAll('[data-audio-track^="external-audio-"]').length, 2);
    d.querySelector('[data-subtitle-track="external-0"]').click();
    video.currentTime = 2; video.dispatchEvent(new w.Event('timeupdate'));
    assert.equal(d.querySelector('#external-subtitle').textContent, 'سلام');
    d.querySelector('#subtitle-delay').value = '3';
    d.querySelector('#subtitle-delay').dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(d.querySelector('#external-subtitle').textContent, '');
    d.querySelector('#subtitle-size').value = '32';
    d.querySelector('#subtitle-size').dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(d.querySelector('#external-subtitle').style.fontSize, '32px');
    d.querySelector('[data-subtitle-track="off"]').click();
    assert.equal(d.querySelector('#external-subtitle').style.display, 'none');
    d.querySelector('[data-audio-track="external-audio-0"]').click();
    assert.equal(video.muted, true);
    d.querySelector('[data-audio-track="embedded-default"]').click();
    assert.equal(video.muted, false);
    video.currentTime = 51; video.dispatchEvent(new w.Event('pause'));
    assert.equal(JSON.parse(w.localStorage.getItem('vizosten-progress:asset')).position, 51);
  } finally { dom.window.close(); }
});

test('preroll blocks main video, records impression and skip, then starts video', async () => {
  const ad = { id: 'ad1', session: 'session', creativeUrl: 'https://media.example/ad.mp4', tunnelUrl: '/go', headline: 'آگهی', assetType: 'video', skipAfterSeconds: 0, durationSeconds: 10 };
  const { dom, d, requests } = await setup({ ad });
  try {
    const video = d.querySelector('#video');
    d.querySelector('#play-toggle').click(); await delay();
    assert.equal(video.paused, true);
    assert.ok(d.querySelector('.player-ad-video'));
    assert.equal(d.querySelector('.player-ad-skip').disabled, false);
    d.querySelector('.player-ad-skip').click(); await delay();
    assert.equal(video.paused, false);
    const events = requests.filter((r) => r.url.includes('/events')).map((r) => JSON.parse(r.options.body).eventType);
    assert.deepEqual(events, ['impression', 'skip']);
  } finally { dom.window.close(); }
});


test('admin-provided external tracks for the selected source appear in settings', async () => {
  const sources = [
    { streamUrl: 'https://media.example/video.mp4', subtitleUrl: 'https://media.example/subtitle1.srt', audioUrl: 'https://media.example/audio1.mp3' },
    { streamUrl: 'https://media.example/video.mp4', subtitleUrl: 'https://media.example/subtitle2.srt', audioUrl: 'https://media.example/audio2.mp3' },
    { streamUrl: 'https://media.example/other.mp4', subtitleUrl: 'https://media.example/subtitle3.srt' },
  ];
  const { dom, d } = await setup({ sources });
  try {
    await delay();
    d.querySelector('#settings-button').click();
    assert.equal(d.querySelectorAll('[data-subtitle-track^="external-"]').length, 2);
    assert.equal(d.querySelectorAll('[data-audio-track^="external-audio-"]').length, 2);
    assert.equal(d.querySelector('[data-subtitle-track="off"]').classList.contains('active'), true);
  } finally { dom.window.close(); }
});

test('midroll pauses playback at the midpoint and resumes after an ad', async () => {
  const midAd = { id: 'mid', session: 's', creativeUrl: 'https://media.example/ad.mp4', tunnelUrl: '/go', headline: 'آگهی', assetType: 'video', skipAfterSeconds: 0 };
  const { dom, w, d, requests } = await setup({ midAd });
  try {
    const video = d.querySelector('#video');
    d.querySelector('#play-toggle').click(); await delay();
    assert.equal(video.paused, false);
    video.currentTime = 65; video.dispatchEvent(new w.Event('timeupdate')); await delay();
    assert.equal(video.paused, true);
    assert.ok(d.querySelector('.player-ad-video'));
    d.querySelector('.player-ad-skip').click(); await delay();
    assert.equal(video.paused, false);
    video.dispatchEvent(new w.Event('timeupdate')); await delay();
    assert.equal(requests.filter((r) => r.url === '/api/ads/serve?placement=mid_roll').length, 1);
  } finally { dom.window.close(); }
});

test('does not count a creative that never plays and is skipped', async () => {
  const ad = { id: 'ad1', session: 's', creativeUrl: 'https://media.example/ad.mp4', tunnelUrl: '/go', headline: 'آگهی', assetType: 'video', skipAfterSeconds: 0 };
  const { dom, w, d, requests } = await setup({ ad });
  try {
    const play = w.HTMLMediaElement.prototype.play;
    w.HTMLMediaElement.prototype.play = function () {
      if (this.classList.contains('player-ad-video')) return Promise.reject(new Error('blocked'));
      return play.call(this);
    };
    d.querySelector('#play-toggle').click(); await delay();
    assert.equal(requests.filter((r) => r.url.includes('/events')).length, 0);
    d.querySelector('.player-ad-skip').click(); await delay();
    assert.deepEqual(requests.filter((r) => r.url.includes('/events')).map((r) => JSON.parse(r.options.body).eventType), ['skip']);
  } finally { dom.window.close(); }
});

test('ad impression waits for visibility and is sent once', async () => {
  const ad = { id: 'ad1', session: 's', creativeUrl: 'https://media.example/ad.mp4', tunnelUrl: '/go', headline: 'آگهی', assetType: 'video', skipAfterSeconds: 0 };
  const { dom, w, d, requests } = await setup({ ad });
  try {
    let visible = 'hidden';
    Object.defineProperty(d, 'visibilityState', { configurable: true, get: () => visible });
    d.querySelector('#play-toggle').click(); await delay();
    assert.equal(requests.filter((r) => r.url.includes('/events')).length, 0);
    visible = 'visible'; d.dispatchEvent(new w.Event('visibilitychange')); await delay();
    d.querySelector('.player-ad-video').dispatchEvent(new w.Event('playing')); await delay();
    assert.deepEqual(requests.filter((r) => r.url.includes('/events')).map((r) => JSON.parse(r.options.body).eventType), ['impression']);
  } finally { dom.window.close(); }
});

test('transient event failure retries before sending skip', async () => {
  const ad = { id: 'ad1', session: 'retry', creativeUrl: 'https://media.example/ad.mp4', tunnelUrl: '/go', headline: 'آگهی', assetType: 'video', skipAfterSeconds: 0 };
  const { dom, w, d, requests } = await setup({ ad });
  try {
    const original = w.fetch;
    let failed = false;
    w.fetch = async (url, options) => {
      if (String(url).includes('/events') && !failed) {
        failed = true;
        requests.push({ url: String(url), options });
        throw new Error('connection lost');
      }
      return original(url, options);
    };
    d.querySelector('#play-toggle').click(); await delay();
    d.querySelector('.player-ad-skip').click();
    await delay(400);
    assert.deepEqual(requests.filter((r) => r.url.includes('/events')).map((r) => JSON.parse(r.options.body).eventType), ['impression', 'impression', 'skip']);
  } finally { dom.window.close(); }
});


test('download banner uses its own placement and counts only after image load', async () => {
  const downloadAd = { id: 'banner', session: 'b', creativeUrl: 'https://media.example/ad.jpg', tunnelUrl: '/go', headline: 'پیشنهاد', durationSeconds: 30 };
  const mediaItems = [{ id: 'm1', audioLabel: 'اصلی', resolution: '720p', version: '720p', streamUrl: null, fileSizeBytes: 100 }];
  const { dom, w, d, requests } = await setup({ signedIn: true, downloadAd, mediaItems });
  try {
    d.querySelector('[data-open-download]').click(); await delay();
    assert.ok(d.querySelector('[data-download-media="m1"]'));
    d.querySelector('[data-download-media="m1"]').click(); await delay(); await delay();
    assert.ok(d.querySelector('#confirm-delivery'));
    const image = d.querySelector('#download-banner-slot img');
    assert.ok(image);
    assert.equal(requests.filter((r) => r.url.includes('/events')).length, 0);
    image.dispatchEvent(new w.Event('load')); await delay();
    assert.deepEqual(requests.filter((r) => r.url.includes('/events')).map((r) => JSON.parse(r.options.body).eventType), ['impression']);
    assert.ok(requests.some((r) => r.url === '/api/ads/serve?placement=banner_download'));
  } finally { dom.window.close(); }
});


test('advertiser creative type follows the selected placement', async () => {
  const prices = [
    { placement: 'pre_roll', group: 'video', label: 'پیش پخش', cpm: 1, currency: 'IRR' },
    { placement: 'banner_player', group: 'banner', label: 'بنر', cpm: 1, currency: 'IRR' },
  ];
  const { dom, w, d } = await setup({ signedIn: true, prices });
  try {
    w.location.hash = '#/advertiser';
    for (let i = 0; i < 30 && !d.querySelector('#campaign-form'); i++) await delay();
    const select = d.querySelector('#campaign-form [name="assetType"]');
    assert.equal(select.value, 'video');
    d.querySelector('[data-placement="banner_player"]').click();
    assert.equal(select.value, 'image');
    assert.equal([...select.options].find((o) => o.value === 'video').disabled, true);
    d.querySelector('[data-placement="pre_roll"]').click();
    assert.equal(select.value, 'video');
  } finally { dom.window.close(); }
});


test('WebVTT cue identifiers and cue settings are parsed', async () => {
  const { dom, w, d } = await setup({ sources: [{ streamUrl: 'https://media.example/video.mp4', subtitleUrl: 'https://media.example/subtitle-named.vtt' }] });
  try {
    const video = d.querySelector('#video');
    await delay();
    d.querySelector('#settings-button').click();
    d.querySelector('[data-subtitle-track="external-0"]').click();
    video.currentTime = 2; video.dispatchEvent(new w.Event('timeupdate'));
    assert.equal(d.querySelector('#external-subtitle').textContent, 'متن وب');
  } finally { dom.window.close(); }
});

test('center controls seek ten seconds, clamp to the file and expose track settings', async () => {
  const { dom, w, d } = await setup();
  try {
    const video = d.querySelector('#video');
    video.currentTime = 3;
    d.querySelector('#skip-back').click();
    assert.equal(video.currentTime, 0);
    d.querySelector('#skip-forward').click();
    assert.equal(video.currentTime, 10);
    video.currentTime = 118;
    d.querySelector('#skip-forward').click();
    assert.equal(video.currentTime, 120);
    d.querySelector('#player-subtitle-menu').click();
    assert.ok(d.querySelector('#settings-menu').classList.contains('open'));
    assert.equal(d.querySelector('.player-top-title').textContent, 'فیلم');
    d.querySelector('#center-play').click(); await delay();
    assert.equal(video.paused, false);
    assert.equal(d.querySelector('#center-play').getAttribute('aria-label'), 'توقف');
  } finally { dom.window.close(); }
});


test('Android sends selected source, tracks and account session to native player without a web video', async () => {
  const sources = [
    { streamUrl: 'https://media.example/video.mp4', subtitleUrl: 'https://media.example/a.srt', audioUrl: 'https://media.example/a.mp3' },
    { streamUrl: 'https://media.example/video.mp4', subtitleUrl: 'https://media.example/b.vtt', audioUrl: 'https://media.example/b.mp3' },
    { streamUrl: 'https://media.example/other.mp4', subtitleUrl: 'https://media.example/not-selected.srt' },
  ];
  const { dom, d, nativeMessages } = await setup({ native: true, signedIn: true, sources });
  try {
    assert.equal(d.querySelector('#video'), null);
    assert.equal(nativeMessages.length, 1);
    const message = nativeMessages[0];
    assert.equal(message.action, 'openPlayer');
    assert.equal(message.contentId, 'asset');
    assert.equal(message.sessionToken, 'test-token');
    assert.deepEqual(message.subtitleUrls, ['https://media.example/a.srt', 'https://media.example/b.vtt']);
    assert.deepEqual(message.audioUrls, ['https://media.example/a.mp3', 'https://media.example/b.mp3']);
    assert.equal(d.querySelector('#native-video-url'), null);
    assert.equal(d.querySelector('input[type="url"]'), null);
    assert.equal(d.querySelector('#native-player-status').textContent.includes('media.example'), false);
    d.querySelector('#native-player-open').click();
    assert.equal(nativeMessages.length, 2);
    assert.equal(nativeMessages[1].streamUrl, message.streamUrl);
    assert.deepEqual(nativeMessages[1].subtitleUrls, message.subtitleUrls);
  } finally { dom.window.close(); }
});

test('Android without a supported native bridge reports an error and does not fall back to web playback', async () => {
  const { dom, d } = await setup({ native: true, noNativeBridge: true });
  try {
    assert.equal(d.querySelector('#video'), null);
    assert.match(d.querySelector('#native-player-status').textContent, /WebView/);
  } finally { dom.window.close(); }
});


test('missing administrator source does not offer a manual URL field', async () => {
  for (const native of [false, true]) {
    const { dom, d, nativeMessages } = await setup({ native, streamUrl: '' });
    try {
      assert.equal(d.querySelector('input[type="url"]'), null);
      assert.equal(d.querySelector('[data-bind]'), null);
      if (native) {
        assert.equal(nativeMessages.length, 0);
        assert.match(d.querySelector('#native-player-status').textContent, /منبع پخش/);
      } else assert.ok(d.querySelector('#unavailable-overlay'));
    } finally { dom.window.close(); }
  }
});


test('web version picker exposes labels only and switches between admin sources without losing same-episode progress', async () => {
  const mediaItems = [
    { id: 'a', streamUrl: 'https://media.example/a.mp4', resolution: '720p', version: 'WEB-DL', encoder: 'Kingmovie', season: 1, episode: 1 },
    { id: 'b', streamUrl: 'https://media.example/b.mp4', resolution: '720p', version: 'WEB-DL', encoder: 'Valamovie', season: 1, episode: 1 },
    { id: 'c', streamUrl: 'https://media.example/c.mp4', resolution: '1080p', version: 'Blu-ray', encoder: 'Kingmovie', season: 1, episode: 2 },
    { id: 'd', streamUrl: '', resolution: '4K', version: 'download only' },
  ];
  const sources = [
    { streamUrl: mediaItems[0].streamUrl, season: 1, episode: 1, subtitleUrl: 'https://media.example/subtitle1.srt' },
    { streamUrl: mediaItems[1].streamUrl, season: 1, episode: 1, subtitleUrl: 'https://media.example/subtitle2.srt' },
  ];
  const { dom, w, d } = await setup({ mediaItems, sources, streamUrl: '' });
  try {
    const select = d.querySelector('#player-version'), video = d.querySelector('#video');
    assert.equal(select.options.length, 3);
    assert.match(select.options[0].textContent, /720p.*WEB-DL.*Kingmovie/);
    assert.match(select.options[1].textContent, /Valamovie/);
    assert.ok(!select.outerHTML.includes('https://'));
    video.currentTime = 35; await video.play();
    select.value = '1'; select.dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(video.src, 'https://media.example/b.mp4');
    video.dispatchEvent(new w.Event('loadedmetadata'));
    assert.equal(video.currentTime, 35); assert.equal(video.paused, false);
    await delay(); d.querySelector('#settings-button').click();
    assert.equal(d.querySelectorAll('[data-subtitle-track^="external-"]').length, 1);
    select.value = '2'; select.dispatchEvent(new w.Event('change', { bubbles: true }));
    video.dispatchEvent(new w.Event('loadedmetadata'));
    assert.equal(video.currentTime, 0);
  } finally { dom.window.close(); }
});

test('Android bridge receives named admin versions with associated tracks, not download-only versions', async () => {
  const sources = [
    { streamUrl: 'https://media.example/a.mp4', version: 'WEB-DL', resolution: '720p', quality: 'Kingmovie', season: 1, episode: 1, subtitleUrl: 'https://media.example/subtitle1.srt' },
    { streamUrl: 'https://media.example/b.mp4', version: 'WEB-DL', resolution: '720p', quality: 'Valamovie', season: 1, episode: 1, audioUrl: 'https://media.example/audio2.mp3' },
  ];
  const { dom, d, nativeMessages } = await setup({ native: true, streamUrl: '', sources });
  try {
    assert.equal(nativeMessages.length, 1);
    assert.equal(nativeMessages[0].versions.length, 2);
    assert.match(nativeMessages[0].versions[1].label, /Valamovie/);
    assert.deepEqual(nativeMessages[0].versions[1].audioUrls, ['https://media.example/audio2.mp3']);
    assert.ok(!d.querySelector('#native-player-status').textContent.includes('https://'));
  } finally { dom.window.close(); }
});
