'use strict';

(() => {
  const API_ROOT = '/api';
  const storageKey = 'filmwork_session';
  const state = {
    token: localStorage.getItem(storageKey) || '',
    user: null,
    config: { authBotUrl: null, placementPrices: [] },
    routeVersion: 0,
    currentContent: null,
    mediaMap: new Map(),
    pendingAfterAuth: null,
    modalTimer: null,
    player: null,
    searchTimer: null,
    routeVisits: 0,
  };

  function onlinePlaybackVisible() {
    return state.config?.player?.enabled !== false && state.config?.player?.buttonVisible !== false;
  }

  const app = document.getElementById('app');
  const loader = document.getElementById('initial-loader');
  const modalRoot = document.getElementById('modal-root');
  const toastElement = document.getElementById('toast');
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const icons = {
    play: '<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="m8 5 11 7-11 7V5Z"/></svg>',
    download: '<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/></svg>',
    heart: '<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.7a5.4 5.4 0 0 0-7.7 0L12 5.8l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7l1.1 1.1L12 21l7.7-7.5 1.1-1.1a5.4 5.4 0 0 0 0-7.7Z"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7.5"/><path d="m20 20-3.6-3.6"/></svg>',
    film: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m10 0h4M3 15h4m10 0h4"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></svg>',
    megaphone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11v2a2 2 0 0 0 2 2h2l2 5h3l-2-5 9 3V6L8 9H5a2 2 0 0 0-2 2Z"/></svg>',
    close: '×',
  };

  const PERSIAN = /[\u0600-\u06FF]/;
  const LATIN = /[A-Za-z]/;


  function titleFa(content) {
    const title = String(content?.title || '').trim();
    const original = String(content?.originalTitle || '').trim();
    if (PERSIAN.test(title) || !original || !PERSIAN.test(original)) return title;
    return original;
  }

  function titleEn(content) {
    const title = String(content?.title || '').trim();
    const original = String(content?.originalTitle || '').trim();
    if (LATIN.test(title)) return title;
    return LATIN.test(original) ? original : '';
  }

  /** Filmwork shows both scripts wherever a title fits: `پیت` above `The Pitt`. */
  function titleMarkup(content, { tag = 'h3', className = '', enClass = 'title-en' } = {}) {
    const fa = titleFa(content);
    const en = titleEn(content);
    const showEn = en && en !== fa;
    const main = `<${tag} class="${className}">${escapeHtml(fa || en)}</${tag}>`;
    return showEn
      ? `${main}<p class="${enClass}" dir="ltr" lang="en">${escapeHtml(en)}</p>`
      : main;
  }

  // A pair is one focusable link, with isolated scripts in a predictable order.
  function namesMarkup(values) {
    const entries = (Array.isArray(values) ? values : []).filter(Boolean);
    if (!entries.length) return 'ثبت نشده';
    return `<span class="name-list">${entries.map((entry) => {
      const aliases = String(entry).split(/\s*\|\s*/u).map((x) => x.trim()).filter(Boolean)
        .sort((a, b) => Number(LATIN.test(a)) - Number(LATIN.test(b)));
      const params = new URLSearchParams(); aliases.forEach((name) => params.append('person', name));
      const label = aliases.map((name) => `<bdi ${LATIN.test(name) ? 'dir="ltr" lang="en"' : 'dir="rtl"'}>${escapeHtml(name)}</bdi>`).join('<span class="name-divider" aria-hidden="true"> | </span>');
      return `<a class="name-pair" href="#/person?${escapeHtml(params.toString())}">${label}</a>`;
    }).join('<span class="name-separator">، </span>')}</span>`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function safeUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, window.location.origin);
      if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return '';
      return escapeHtml(url.toString());
    } catch {
      return '';
    }
  }

  function safeTelegramBotUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_]{5,32}$/.test(url.pathname)) return '';
      return safeUrl(url.href);
    } catch { return ''; }
  }

  function firstLetter(value) {
    return [...String(value || 'م').trim()][0] || 'م';
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('fa-IR');
  }

  function formatMoney(value, currency = 'IRR') {
    const suffix = currency === 'IRR' ? 'ریال' : escapeHtml(currency);
    return `${Number(value || 0).toLocaleString('fa-IR')} ${suffix}`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${formatNumber(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let unit = units[0];
    for (let index = 1; index < units.length && size >= 1024; index += 1) {
      size /= 1024;
      unit = units[index];
    }
    return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    try {
      return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(value));
    } catch {
      return '—';
    }
  }

  function apiErrorMessage(error) {
    const message = error?.message || 'ارتباط با سرور برقرار نشد.';
    return error?.requestId ? `${message} (شناسه پیگیری: ${error.requestId})` : message;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    let response;
    try {
      response = await fetch(`${API_ROOT}${path}`, { ...options, headers });
    } catch {
      const error = new Error('دسترسی به سرور ممکن نیست. اتصال اینترنت را بررسی کنید.');
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.token && !path.startsWith('/auth/')) {
        state.token = '';
        state.user = null;
        localStorage.removeItem(storageKey);
        updateAccountUI();
      }
      const error = new Error(data.error?.message || 'درخواست انجام نشد.');
      error.code = data.error?.code || `HTTP_${response.status}`;
      error.status = response.status;
      if (response.status >= 500 && /^[a-f0-9-]{36}$/i.test(data.error?.requestId || '')) error.requestId = data.error.requestId;
      throw error;
    }
    return data;
  }

  function toast(message, type = '') {
    toastElement.textContent = message;
    toastElement.className = `toast show ${type}`.trim();
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { toastElement.className = 'toast'; }, 3200);
  }

  function updateAccountUI() {
    const avatar = document.getElementById('header-avatar');
    if (avatar) avatar.textContent = firstLetter(state.user?.accountName || 'م');
  }

  function navigate(path) {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (window.location.hash === `#${normalized}`) route();
    else window.location.hash = normalized;
  }

  function routeParts() {
    const raw = window.location.hash.replace(/^#/, '') || '/home';
    return raw.split('?')[0].split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  }

  function setActiveNav(section) {
    $$('.dock-item').forEach((item) => item.classList.toggle('active', item.dataset.nav === section));
    // Desktop header mirrors the dock; keep both in sync from one place.
    $$('.header-nav-item').forEach((item) => item.classList.toggle('active', Boolean(section) && item.dataset.nav === section));
  }

  function setHeaderLabel(label, back = false) {
    const element = document.getElementById('header-page-label');
    if (element) element.textContent = label;
    const tool = document.querySelector('.header-tool');
    if (!tool) return;
    if (back) {
      tool.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
      tool.setAttribute('aria-label', 'بازگشت');
      tool.removeAttribute('data-route');
      tool.setAttribute('data-go-back', '');
    } else {
      tool.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h3m4 0h9M4 18h7m4 0h5"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="13" cy="18" r="2"/></svg>';
      tool.setAttribute('aria-label', 'جستجو و فیلترها');
      tool.setAttribute('data-route', '/search');
      tool.removeAttribute('data-go-back');
    }
  }

  function pageLoading() {
    app.innerHTML = '<div class="page-shell page-top"><div class="skeleton hero-skeleton"></div></div>';
  }

  function emptyState(title, description, action = '') {
    return `<section class="empty-state"><div class="empty-icon">${icons.film}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>${action}</section>`;
  }

  function posterMarkup(content, className = '') {
    const poster = safeUrl(content.posterUrl);
    return `<div class="poster-frame ${className}">
      ${poster ? `<img src="${poster}" alt="پوستر ${escapeHtml(titleFa(content) || titleEn(content))}" loading="lazy">` : `<span class="poster-letter" aria-hidden="true">${escapeHtml(firstLetter(titleFa(content) || titleEn(content)))}</span>`}
      ${content.imdbScore !== null && content.imdbScore !== undefined ? `<span class="card-rating"><b>★</b> ${escapeHtml(content.imdbScore)}</span>` : ''}
      <span class="card-type">${content.type === 'series' ? 'سریال' : 'فیلم'}</span>
    </div>`;
  }

  function yearLabel(content) {
    if (!content.releaseYear) return 'سال نامشخص';
    return `${content.releaseYear}${content.type === 'series' ? `–${content.lastAirYear || 'نامشخص'}` : ''}`;
  }

  function mediaCard(content) {
    const fa = titleFa(content);
    const en = titleEn(content);
    const label = [fa, en].filter(Boolean).join(' / ');
    return `<article class="media-card" tabindex="0" role="button" data-route="/content/${encodeURIComponent(content.id)}" aria-label="${escapeHtml(label)}">
      ${posterMarkup(content)}
      ${titleMarkup(content, { enClass: 'title-en title-en--card' })}
      <p>${escapeHtml(yearLabel(content))}${content.genres?.[0] ? ` · ${escapeHtml(content.genres[0])}` : ''}</p>
    </article>`;
  }

  function continueCard(entry) {
    const content = entry.content;
    const image = safeUrl(content.backdropUrl || content.posterUrl);
    const duration = Number(entry.durationSeconds || 0);
    const position = Number(entry.positionSeconds || 0);
    const progress = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
    const remaining = duration > position ? Math.max(1, Math.round((duration - position) / 60)) : 0;
    return `<article class="resume-card" role="button" tabindex="0" data-route="/player/${encodeURIComponent(content.id)}">
      <div class="resume-media">${image ? `<img src="${image}" alt="" loading="lazy">` : `<span class="poster-letter">${escapeHtml(firstLetter(titleFa(content) || titleEn(content)))}</span>`}<span class="resume-play">${icons.play}</span>${remaining ? `<small>${formatNumber(remaining)} دقیقه باقی‌مانده</small>` : ''}<i><b style="width:${progress.toFixed(1)}%"></b></i></div>
      <div class="resume-copy"><div class="resume-names"><strong>${escapeHtml(titleFa(content) || titleEn(content))}</strong>${titleEn(content) && titleEn(content) !== titleFa(content) ? `<small class="title-en title-en--card" dir="ltr" lang="en">${escapeHtml(titleEn(content))}</small>` : ''}</div><span>${formatTime(position)} از ${formatTime(duration)}</span></div>
    </article>`;
  }

  function heroMarkup(content) {
    const backdrop = safeUrl(content.backdropUrl || content.posterUrl);
    const genres = (content.genres || []).slice(0, 3).map(escapeHtml).join('، ');
    return `<section class="hero">
      ${backdrop ? `<img class="hero-media" src="${backdrop}" alt="" fetchpriority="high">` : '<div class="hero-placeholder"></div>'}
      <div class="hero-vignette"></div>
      <div class="page-shell hero-content">
        <div class="eyebrow">انتخاب ویژه Vizosten</div>
        <h1>${escapeHtml(titleFa(content) || titleEn(content))}</h1>
        ${titleEn(content) && titleEn(content) !== titleFa(content) ? `<p class="hero-en-title" dir="ltr" lang="en">${escapeHtml(titleEn(content))}</p>` : ''}
        <div class="hero-meta">
          ${content.imdbScore !== null ? `<span class="rating"><b>★</b> IMDb ${escapeHtml(content.imdbScore)}</span>` : ''}
          ${content.releaseYear ? `<span class="meta-dot">${escapeHtml(yearLabel(content))}</span>` : ''}
          <span class="meta-dot">${content.type === 'series' ? 'سریال' : 'فیلم سینمایی'}</span>
          ${genres ? `<span class="meta-dot">${genres}</span>` : ''}
        </div>
        ${content.description ? `<p class="hero-description">${escapeHtml(content.description)}</p>` : ''}
        <div class="action-row">
          ${onlinePlaybackVisible() ? `<button type="button" class="primary-button" data-route="/player/${encodeURIComponent(content.id)}">${icons.play} پخش آنلاین</button>` : ''}
          <button type="button" class="secondary-button" data-open-download="${escapeHtml(content.id)}">${icons.download} دریافت فایل</button>
          <button type="button" class="icon-button" data-favorite="${escapeHtml(content.id)}" aria-label="افزودن به علاقه‌مندی‌ها">${icons.heart}</button>
        </div>
      </div>
    </section>`;
  }

  let cinemaGame = null;
  function gameCard(items) {
    const eligible = items.filter((item) => item.imdbScore !== null && item.imdbScore !== undefined && Number.isFinite(Number(item.imdbScore)));
    if (new Set(eligible.map((item) => Number(item.imdbScore))).size < 2) { cinemaGame = null; return ''; }
    cinemaGame = { items: eligible, score: 0, rounds: 0, options: [], answered: false };
    return `<section class="cinema-game" aria-labelledby="game-title"><div class="game-copy"><span class="game-kicker">VIZOSTEN / MINI GAME</span><h2 id="game-title">یک انتخاب، یک چالش.</h2><p>فکر می‌کنی کدوم اثر امتیاز IMDb بالاتری داره؟ دو عنوان، یک حدس؛ فقط برای سرگرمی.</p><button type="button" class="game-start" data-game-start>شروع چالش <span aria-hidden="true">←</span></button></div><div class="game-screen" id="game-screen"><div class="game-art" aria-hidden="true"><span>01</span><b>VS</b><span>02</span></div><p>سینما رو چقدر می‌شناسی؟</p><small>بدون زمان‌سنج · بدون نیاز به ورود</small></div></section>`;
  }
  function nextGameRound() {
    if (!cinemaGame) return;
    const pool = cinemaGame.items;
    const first = pool[Math.floor(Math.random() * pool.length)];
    const different = pool.filter((item) => Number(item.imdbScore) !== Number(first.imdbScore));
    if (!different.length) return;
    const second = different[Math.floor(Math.random() * different.length)];
    cinemaGame.options = Math.random() < .5 ? [first, second] : [second, first];
    cinemaGame.answered = false;
    const screen = $('#game-screen'); if (!screen) return;
    screen.innerHTML = `<div class="game-round-head"><span>کدوم امتیاز بیشتری داره؟</span><small>امتیاز تو ${formatNumber(cinemaGame.score)} از ${formatNumber(cinemaGame.rounds)}</small></div><div class="game-options">${cinemaGame.options.map((item, i) => `<button type="button" class="game-option" data-game-answer="${i}"><span>0${i + 1}</span><strong>${escapeHtml(titleFa(item) || titleEn(item))}</strong>${titleEn(item) && titleEn(item) !== titleFa(item) ? `<small dir="ltr">${escapeHtml(titleEn(item))}</small>` : ''}</button>`).join('<span class="game-vs">VS</span>')}</div><div id="game-feedback" class="game-feedback" aria-live="polite"></div>`;
    $('.game-start')?.setAttribute('hidden', '');
  }
  function answerGame(index) {
    if (!cinemaGame || cinemaGame.answered || !cinemaGame.options[index]) return;
    cinemaGame.answered = true;
    const [a, b] = cinemaGame.options;
    const winner = Number(a.imdbScore) > Number(b.imdbScore) ? a : b;
    const correct = cinemaGame.options[index] === winner;
    cinemaGame.rounds += 1; if (correct) cinemaGame.score += 1;
    $$('.game-option').forEach((button, i) => {
      button.disabled = true;
      button.classList.toggle('is-correct', cinemaGame.options[i] === winner);
      button.insertAdjacentHTML('beforeend', `<em>★ ${escapeHtml(cinemaGame.options[i].imdbScore)}</em>`);
    });
    const count = $('.game-round-head small'); if (count) count.textContent = `امتیاز تو ${formatNumber(cinemaGame.score)} از ${formatNumber(cinemaGame.rounds)}`;
    $('#game-feedback').innerHTML = `<span>${correct ? 'درست حدس زدی!' : 'این بار نزدیک بود!'}</span><button type="button" data-game-next>چالش بعدی ←</button><button type="button" data-route="/content/${encodeURIComponent(winner.id)}">دیدن اثر برنده</button>`;
  }

  async function renderHome(version) {
    setActiveNav('home');
    setHeaderLabel('خانه');
    const [data, progressData, facets] = await Promise.all([
      api('/contents?limit=30'),
      state.user ? api('/progress').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      api('/contents-facets'),
    ]);
    if (version !== state.routeVersion) return;
    const items = data.items || [];
    const continueItems = (progressData.items || []).filter((entry) => !entry.completed && entry.positionSeconds > 0).slice(0, 8);
    if (!items.length) {
      app.innerHTML = `<div class="page-shell page-top">${emptyState('کتابخانه آماده دریافت محتواست', 'اولین پست فیلم یا سریال را برای ربات خصوصی مدیریت فوروارد کنید؛ اثر بلافاصله در اینجا منتشر می‌شود.')}</div>`;
      return;
    }
    // The owner console promotes one title into the hero banner; fall back to the
    // newest published item so the homepage is never empty.
    const hero = items.find((item) => item.featuredHero) || items[0];
    const latest = items.filter((item) => item.id !== hero.id).slice(0, 12);
    const topRated = [...items].filter((item) => item.imdbScore !== null).sort((a, b) => b.imdbScore - a.imdbScore).slice(0, 12);
    app.innerHTML = `<div class="page-shell home-desktop-top">
        <div><div class="home-greeting">کتابخانه شخصی شما</div><h1 class="home-title">امشب چه ببینیم؟</h1></div>
        <form class="home-search" id="home-search" role="search">
          ${icons.search}<input type="search" name="q" maxlength="100" autocomplete="off" aria-label="جستجو در ویزوستن" placeholder="نام فیلم، سریال، بازیگر یا کارگردان…">
          <button class="primary-button" type="submit">جستجو</button>
        </form>
      </div>
      <div class="page-shell home-category-strip" aria-label="دسته‌بندی‌ها">
        <button class="chip active" data-route="/home">منتخب</button>
        ${facets.genres.slice(0, 6).map(({name}) => `<button class="chip" data-route="/search?genre=${encodeURIComponent(name)}">${escapeHtml(name)}</button>`).join('')}
      </div>
      ${heroMarkup(hero)}
      <div class="page-shell">
        <div class="page-ad-slots"><div id="ad-banner-home"></div><div id="ad-text-home"></div></div>
        ${continueItems.length && onlinePlaybackVisible() ? `<section class="content-section resume-section"><div class="section-head"><div><h2>ادامه تماشا</h2><p>از همان‌جایی که رها کردید</p></div></div><div class="resume-scroller">${continueItems.map(continueCard).join('')}</div></section>` : ''}
        ${gameCard(items)}
        <section class="content-section">
          <div class="section-head"><div><h2>تازه‌های ویزوستن</h2><p>جدیدترین فیلم‌ها و سریال‌های اضافه‌شده</p></div><button class="text-button" data-route="/search">مشاهده همه</button></div>
          <div class="media-scroller">${latest.length ? latest.map(mediaCard).join('') : mediaCard(hero)}</div>
        </section>
        ${topRated.length ? `<section class="content-section"><div class="section-head"><div><h2>بالاترین امتیاز</h2><p>انتخاب‌ها بر اساس امتیاز IMDb</p></div></div><div class="media-scroller">${topRated.map(mediaCard).join('')}</div></section>` : ''}
      </div>`;
    loadPageAd('banner_home', '#ad-banner-home', version);
    loadPageAd('text_home', '#ad-text-home', version);
  }

  let searchSequence = 0;
  let personFilters = null;
  async function renderSearch(version, initialQuery = '', initialGenre = '', person = null) {
    setActiveNav('search');
    setHeaderLabel(person ? 'آثار عوامل' : 'جستجو');
    personFilters = person;
    const facets = await api('/contents-facets');
    if (version !== state.routeVersion) return;
    const range = (label, prefix, bounds, step) => bounds ? `<fieldset class="filter-range"><legend>${label}<small dir="ltr">${escapeHtml(bounds.min)} — ${escapeHtml(bounds.max)}</small></legend><div class="filter-range-fields"><label><span>از</span><input type="number" data-catalog-filter id="${prefix}-from" min="${bounds.min}" max="${bounds.max}" step="${step}" placeholder="${bounds.min}"></label><span class="range-dash">—</span><label><span>تا</span><input type="number" data-catalog-filter id="${prefix}-to" min="${bounds.min}" max="${bounds.max}" step="${step}" placeholder="${bounds.max}"></label></div></fieldset>` : '';
    const multi = (label, key, values) => values.length ? `<details class="filter-dropdown"><summary>${label}<span aria-hidden="true">+</span></summary><div>${values.map((value) => `<label><input type="checkbox" data-catalog-filter name="${key}" value="${escapeHtml(value)}"><span>${escapeHtml(value)}</span></label>`).join('')}</div></details>` : '';
    app.innerHTML = `<div class="page-shell page-top search-page">
      <header class="discovery-heading"><div><span class="editorial-kicker">THE VIZOSTEN ARCHIVE <i></i> کشف کن</span><h1>${person ? `آثار ${person.names.map(escapeHtml).join(' | ')}` : 'قصهٔ بعدی‌ات را پیدا کن.'}</h1><p>از میان فیلم‌ها و سریال‌های آرشیو، انتخابی که به حال‌وهوایت می‌خورد.</p></div><span class="discovery-mark" aria-hidden="true">✳</span></header>
      <label class="search-box discovery-search">${icons.search}<input id="search-input" type="search" maxlength="100" autocomplete="off" placeholder="نام فیلم، سریال، بازیگر یا کارگردان…" value="${escapeHtml(initialQuery)}"><span class="sr-only">جستجو</span><span class="search-box-end">SEARCH</span></label>
      <section class="search-discovery"><div class="discovery-section-label"><h2>حال‌وهوای تو</h2><span>ژانرها را ورق بزن</span></div><div class="genre-chip-row">
        <button type="button" class="genre-chip ${initialGenre ? '' : 'active'}" data-search-genre="">همه</button>
        ${facets.genres.map(({name, count}) => `<button type="button" class="genre-chip ${initialGenre === name ? 'active' : ''}" data-search-genre="${escapeHtml(name)}">${escapeHtml(name)} <small>${formatNumber(count)}</small></button>`).join('')}
      </div></section>
      <div class="page-ad-slots"><div id="ad-banner-search"></div><div id="ad-text-search"></div></div>
      <div class="discovery-layout"><details class="filter-panel" ${window.matchMedia('(min-width: 900px)').matches ? 'open' : ''}><summary><span><b>فیلترهای جستجو</b><small>انتخاب دقیق‌تر</small></span><i aria-hidden="true">＋</i></summary><div class="catalog-filters">
        ${range('سال ساخت', 'search-year', facets.years, 1)}${range('امتیاز IMDb', 'search-rating', facets.ratings, 0.1)}
        ${multi('کشور سازنده', 'country', facets.countries)}${multi('رده سنی', 'age', facets.ages)}${multi('شبکه پخش', 'network', facets.networks)}
        <label class="filter-select"><span>زبان نسخه</span><select id="search-audio" data-catalog-filter><option value="">همه نسخه‌ها</option><option value="sub">زیرنویس</option><option value="dub">دوبله</option><option value="both">دوبله و زیرنویس</option></select></label>
        <label class="filter-running"><input type="checkbox" id="search-running" data-catalog-filter><span>فقط سریال‌های در حال پخش</span></label>
        <button type="button" class="filter-reset" data-filter-reset>پاک کردن فیلترها ↺</button>
      </div></details><div class="discovery-results">
        <div class="results-toolbar"><div class="chip-row" aria-label="فیلتر نوع"><button type="button" class="chip active" data-search-type="">همه آثار</button><button type="button" class="chip" data-search-type="movie">فیلم</button><button type="button" class="chip" data-search-type="series">سریال</button></div>
          <label class="sort-control"><span>مرتب‌سازی</span><select id="search-sort" data-catalog-filter><option value="recent">تازه اضافه‌شده</option><option value="title">الفبایی</option><option value="year">سال ساخت</option><option value="rating">امتیاز IMDb</option></select></label></div>
        <div class="search-status" id="search-status" aria-live="polite">در حال دریافت کتابخانه…</div><div class="media-grid" id="search-results"></div><div id="search-more"></div>
      </div></div>
    </div>`;
    loadPageAd('banner_search', '#ad-banner-search', version);
    loadPageAd('text_search', '#ad-text-search', version);
    await runSearch('', initialQuery, version, initialGenre);
  }

  async function runSearch(type = '', queryText = '', version = state.routeVersion, genre = null, page = 1) {
    const status = $('#search-status'); const results = $('#search-results');
    if (!status || !results) return;
    const sequence = ++searchSequence;
    status.textContent = 'در حال جستجو…';
    try {
      const params = new URLSearchParams({ limit: '48', page: String(page) });
      const selectedGenre = genre === null ? ($('[data-search-genre].active')?.dataset.searchGenre || '') : genre;
      if (type) params.set('type', type);
      if (queryText.trim()) params.set('q', queryText.trim());
      if (selectedGenre) params.set('genre', selectedGenre);
      for (const [id, key] of [['search-year-from','yearFrom'], ['search-year-to','yearTo'], ['search-rating-from','minRating'], ['search-rating-to','maxRating'], ['search-audio','audio'], ['search-sort','sort']]) {
        const value = document.getElementById(id)?.value;
        if (value !== undefined && value !== '') params.set(key, value);
      }
      $$('input[data-catalog-filter][name]:checked').forEach((input) => params.append(input.name, input.value));
      if ($('#search-running')?.checked) params.set('running', '1');
      if (personFilters) { personFilters.names.forEach((name) => params.append('person', name)); if (personFilters.role) params.set('role', personFilters.role); }
      const data = await api(`/contents?${params}`);
      if (version !== state.routeVersion || sequence !== searchSequence || !$('#search-results')) return;
      status.textContent = `${formatNumber(data.pagination.total)} نتیجه`;
      const html = data.items.length ? data.items.map(mediaCard).join('') : `<div style="grid-column:1/-1">${emptyState('نتیجه‌ای پیدا نشد', 'فیلترها یا عبارت جستجو را تغییر دهید.')}</div>`;
      if (page === 1) results.innerHTML = html; else results.insertAdjacentHTML('beforeend', html);
      $('#search-more').innerHTML = page < data.pagination.pages ? `<button class="secondary-button" data-search-more="${page + 1}">نمایش بیشتر</button>` : '';
    } catch (error) {
      if (version !== state.routeVersion || sequence !== searchSequence) return;
      status.textContent = apiErrorMessage(error); if (page === 1) results.innerHTML = ''; $('#search-more').innerHTML = '';
    }
  }

  async function renderFavorites(version) {
    setActiveNav('favorites');
    setHeaderLabel('نشان‌شده‌ها');
    if (!state.user) {
      app.innerHTML = `<div class="page-shell page-top">${emptyState('فهرست شخصی شما', 'برای همگام‌سازی علاقه‌مندی‌ها ابتدا با کد تلگرام وارد شوید.', '<button class="primary-button" style="margin-top:18px" data-login>ورود با تلگرام</button>')}</div>`;
      return;
    }
    const data = await api('/favorites');
    if (version !== state.routeVersion) return;
    app.innerHTML = `<div class="page-shell page-top"><div class="section-head"><div><h1 class="page-title">علاقه‌مندی‌ها</h1><p>فهرستی که برای بعد نگه داشته‌اید</p></div></div>${data.items.length ? `<div class="media-grid">${data.items.map(mediaCard).join('')}</div>` : emptyState('هنوز چیزی نشان نکرده‌اید', 'از صفحه هر اثر، دکمه قلب را بزنید تا اینجا دیده شود.')}</div>`;
  }

  async function renderDownloads(version) {
    setActiveNav('downloads');
    setHeaderLabel('دانلودها');
    if (!state.user) {
      app.innerHTML = `<div class="page-shell page-top">${emptyState('دانلودهای شما', 'برای دیدن تاریخچه فایل‌های ارسالی ابتدا با تلگرام وارد شوید.', '<button class="primary-button" style="margin-top:18px" data-login>ورود با تلگرام</button>')}</div>`;
      return;
    }
    const data = await api('/downloads');
    if (version !== state.routeVersion) return;
    const items = data.items || [];
    app.innerHTML = `<div class="page-shell page-top downloads-page">
      <div class="section-head"><div><h1 class="page-title">دانلودها</h1><p>فایل‌هایی که به ربات تلگرام شما فرستاده شده‌اند</p></div><span class="count-badge">${formatNumber(items.length)} فایل</span></div>
      ${items.length ? `<div class="download-history">${items.map((item) => {
        const image = safeUrl(item.content.posterUrl);
        return `<article class="download-history-card">
          <button type="button" class="download-history-poster" data-route="/content/${encodeURIComponent(item.content.id)}">${image ? `<img src="${image}" alt="">` : `<span>${escapeHtml(firstLetter(item.content.title))}</span>`}</button>
          <div><h2>${escapeHtml(titleFa(item.content) || titleEn(item.content))}</h2>${titleEn(item.content) && titleEn(item.content) !== titleFa(item.content) ? `<p class="title-en" dir="ltr" lang="en">${escapeHtml(titleEn(item.content))}</p>` : ''}<p>${[item.media.season ? `فصل ${formatNumber(item.media.season)}` : '', item.media.episode ? `قسمت ${formatNumber(item.media.episode)}` : '', item.media.resolution, item.media.version].filter(Boolean).map(escapeHtml).join(' · ')}</p><small>${formatBytes(item.media.fileSizeBytes)} · ${formatDate(item.downloadedAt)}</small></div>
          <button type="button" class="secondary-button compact" data-open-download="${escapeHtml(item.content.id)}">${icons.download} دریافت دوباره</button>
        </article>`;
      }).join('')}</div>` : emptyState('هنوز فایلی دریافت نکرده‌اید', 'از صفحه یک اثر، نسخه دلخواه را انتخاب کنید تا ربات فایل را برایتان بفرستد.', '<button class="primary-button" style="margin-top:18px" data-route="/home">مرور آثار</button>')}
    </div>`;
  }

  async function contentBundle(assetId) {
    const [contentData, mediaData, commentsData] = await Promise.all([
      api(`/contents/${encodeURIComponent(assetId)}`),
      api(`/contents/${encodeURIComponent(assetId)}/media-options`),
      api(`/contents/${encodeURIComponent(assetId)}/comments?limit=20`),
    ]);
    return { content: contentData.content, media: mediaData.items, comments: commentsData.items };
  }

  function commentsMarkup(comments) {
    if (!comments.length) return '<p class="muted" style="color:#71717a;font-size:12px">هنوز دیدگاهی ثبت نشده است.</p>';
    return comments.map((comment) => `<article class="comment"><div class="comment-head"><div class="comment-author"><span class="mini-avatar">${escapeHtml(firstLetter(comment.accountName))}</span><span>${escapeHtml(comment.accountName)}</span></div><time>${formatDate(comment.createdAt)}</time></div><p>${escapeHtml(comment.body)}</p></article>`).join('');
  }

  async function renderDetail(assetId, version) {
    setActiveNav('');
    setHeaderLabel('جزئیات', true);
    const { content, media, comments } = await contentBundle(assetId);
    if (version !== state.routeVersion) return;
    state.currentContent = content;
    const backdrop = safeUrl(content.backdropUrl || content.posterUrl);
    const poster = safeUrl(content.posterUrl || content.backdropUrl);
    const facts = [
      ['نوع', content.type === 'series' ? 'سریال' : 'فیلم سینمایی'],
      ['سال انتشار', content.releaseYear ? `${content.releaseYear}${content.type === 'series' ? ` – ${content.lastAirYear || 'نامشخص'}` : ''}` : 'نامشخص'],
      ['امتیاز IMDb', content.imdbScore ?? 'ثبت نشده'],
      ['ژانر', (content.genres || []).join('، ') || 'ثبت نشده'],
      ['کارگردان', namesMarkup(content.directors)],
      ['بازیگران', namesMarkup(content.cast)],
      ['کشور', (content.countries || []).join('، ') || 'ثبت نشده'],
      ['شبکه', content.network || 'ثبت نشده'],
      ['رده سنی', content.ageRating || 'ثبت نشده'],
      ['تعداد نسخه‌ها', formatNumber(media.length)],
    ];
    app.innerHTML = `<section class="detail-hero">
      ${backdrop ? `<img class="detail-backdrop" src="${backdrop}" alt="">` : '<div class="hero-placeholder"></div>'}<div class="detail-overlay"></div>
      <div class="page-shell detail-content">
        ${poster ? `<img class="detail-poster" src="${poster}" alt="پوستر ${escapeHtml(titleFa(content) || titleEn(content))}">` : `<div class="detail-poster poster-frame"><span class="poster-letter">${escapeHtml(firstLetter(titleFa(content) || titleEn(content)))}</span></div>`}
        <div class="detail-copy"><div class="eyebrow">${content.type === 'series' ? 'سریال' : 'فیلم سینمایی'}</div><h1>${escapeHtml(titleFa(content) || titleEn(content))}</h1>
          ${titleEn(content) && titleEn(content) !== titleFa(content) ? `<p class="detail-en-title" dir="ltr" lang="en">${escapeHtml(titleEn(content))}</p>` : ''}
          <div class="meta-row">${content.imdbScore !== null ? `<span class="rating"><b>★</b> IMDb ${escapeHtml(content.imdbScore)}</span>` : ''}${content.releaseYear ? `<span class="meta-dot">${escapeHtml(content.releaseYear)}${content.type === 'series' ? `–${escapeHtml(content.lastAirYear || 'نامشخص')}` : ''}</span>` : ''}${content.runtimeMinutes ? `<span class="meta-dot">${formatNumber(content.runtimeMinutes)} دقیقه</span>` : ''}${content.seriesRunning && content.currentSeason ? `<span class="meta-dot status-live">فصل ${formatNumber(content.currentSeason)} در حال پخش</span>` : ''}</div>
          <p class="detail-view-count" aria-live="polite"><span id="detail-views">${formatNumber(content.views || 0)}</span> بازدید</p>
          <div class="action-row">${onlinePlaybackVisible() ? `<button class="primary-button" data-route="/player/${encodeURIComponent(content.id)}">${icons.play} پخش آنلاین</button>` : ''}<button class="secondary-button" data-open-download="${escapeHtml(content.id)}">${icons.download} انتخاب نسخه</button><button class="icon-button" data-favorite="${escapeHtml(content.id)}" aria-label="علاقه‌مندی">${icons.heart}</button></div>
        </div>
      </div>
    </section>
    <div class="page-shell detail-layout">
      <div class="detail-story"><div class="page-ad-slots"><div id="ad-banner-detail"></div><div id="ad-text-detail"></div></div><section class="detail-synopsis"><span class="editorial-kicker">THE STORY / داستان</span><h2>دربارهٔ این اثر</h2><p>${content.description ? escapeHtml(content.description) : 'توضیحی برای این اثر ثبت نشده است.'}</p></section>
        ${(content.posterGallery || []).map(safeUrl).filter(Boolean).length ? `<section class="detail-posters"><div class="detail-section-heading"><div><span class="editorial-kicker">THE POSTERS</span><h2>گالری پوسترها</h2></div></div><div class="poster-gallery">${content.posterGallery.map(safeUrl).filter(Boolean).map((url, i) => `<a href="${url}" target="_blank" rel="noopener noreferrer" aria-label="نمایش پوستر ${i + 1}"><img src="${url}" loading="lazy" alt="پوستر ${i + 1}"></a>`).join('')}</div></section>` : ''}
        ${(content.directors?.length || content.cast?.length) ? `<section class="detail-credits"><div class="detail-section-heading"><div><span class="editorial-kicker">THE PEOPLE / عوامل</span><h2>جلوی دوربین و پشت صحنه</h2></div></div>${content.directors?.length ? `<div class="credit-block"><span>کارگردان</span><div>${namesMarkup(content.directors)}</div></div>` : ''}${content.cast?.length ? `<div class="credit-block"><span>بازیگران</span><div>${namesMarkup(content.cast)}</div></div>` : ''}</section>` : ''}
      </div>
      <aside class="surface-panel detail-facts"><span class="editorial-kicker">THE DETAILS</span><h2>اطلاعات اثر</h2><div class="fact-list">${facts.filter(([label]) => !['کارگردان','بازیگران'].includes(label)).map(([label, value]) => `<div class="fact"><span>${escapeHtml(label)}</span><div class="fact-value">${escapeHtml(value)}</div></div>`).join('')}</div></aside>
      <section class="surface-panel detail-comments"><span class="editorial-kicker">THE CONVERSATION</span><h2>دیدگاه تماشاگران</h2>
        ${state.user ? '<form class="comment-form" id="comment-form"><input name="body" maxlength="1200" required placeholder="دیدگاه خود را بنویسید…"><button class="primary-button" type="submit">ارسال</button></form>' : '<button class="secondary-button" data-login style="margin-bottom:16px">برای ثبت دیدگاه وارد شوید</button>'}
        <div class="comments" id="comments-list">${commentsMarkup(comments)}</div>
      </section>
    </div>`;
    recordContentView(assetId, version);
    loadPageAd('banner_detail', '#ad-banner-detail', version);
    loadPageAd('text_detail', '#ad-text-detail', version);
  }

  async function recordContentView(assetId, version) {
    // A fresh token per navigation, reused on retry, avoids double increments.
    const bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    const visitId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await api(`/contents/${encodeURIComponent(assetId)}/views`, { method:'POST', keepalive:true, body:JSON.stringify({ visitId }) });
        if (version === state.routeVersion && $('#detail-views')) $('#detail-views').textContent = formatNumber(result.views);
        return;
      } catch (error) {
        if (attempt === 2 || (error.status && error.status < 500 && error.status !== 429)) return;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  // A version is an administrator-provided stream, not a user-supplied URL.
  function playbackVersions(content, mediaItems, sources) {
    const versions = [];
    const valid = (raw) => {
      try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
    };
    const sameEpisode = (a, b) => String(a.season ?? '') === String(b.season ?? '') && String(a.episode ?? '') === String(b.episode ?? '');
    const append = (item) => {
      if (!valid(item.streamUrl)) return;
      const linked = sources.filter((source) => source.streamUrl === item.streamUrl &&
        (source.season == null && source.episode == null || sameEpisode(source, item)));
      const bits = [item.season ? `فصل ${item.season}` : '', item.episode ? `قسمت ${item.episode}` : '',
        item.resolution, item.version, item.quality, item.encoder, item.audioLabel, item.episodeTitle]
        .filter(Boolean).map(String).filter((value, index, all) => all.indexOf(value) === index);
      // Do not render an accidental URL that was saved as a human-readable label.
      const label = bits.join(' · ').replace(/https?:\/\/\S+/gi, '').trim() || 'نسخه پخش';
      versions.push({ label, streamUrl: item.streamUrl, season: item.season ?? null, episode: item.episode ?? null,
        subtitleUrls: [...new Set(linked.map((source) => source.subtitleUrl).filter(Boolean))],
        audioUrls: [...new Set(linked.map((source) => source.audioUrl).filter(Boolean))] });
    };
    mediaItems.filter((item) => valid(item.streamUrl)).forEach(append);
    sources.filter((item) => valid(item.streamUrl) && !versions.some((version) => version.streamUrl === item.streamUrl && sameEpisode(version, item))).forEach(append);
    if (valid(content.streamUrl) && !versions.some((item) => item.streamUrl === content.streamUrl))
      append({ streamUrl: content.streamUrl, version: 'نسخه پیش‌فرض' });
    return versions;
  }

  function playerControlMarkup(title, versions) {
    return `<div class="player-topbar"><button type="button" class="player-back" data-go-back aria-label="بازگشت">‹</button><strong class="player-top-title">${escapeHtml(title)}</strong><div id="pause-ad-slot"></div><div class="player-top-actions">${versions.length > 1 ? `<select id="player-version" aria-label="انتخاب نسخه پخش">${versions.map((item, i) => `<option value="${i}">${escapeHtml(item.label)}</option>`).join('')}</select>` : ''}<button type="button" id="player-audio-menu">صدا</button><button type="button" id="player-subtitle-menu">زیرنویس</button></div></div>
      <div class="player-center-controls"><button type="button" id="skip-back" aria-label="ده ثانیه عقب">↶<small>۱۰</small></button><button type="button" id="center-play" aria-label="پخش">▶</button><button type="button" id="skip-forward" aria-label="ده ثانیه جلو">↷<small>۱۰</small></button></div>
      <div class="subtitle-overlay" id="external-subtitle" aria-live="off"></div>
      <div class="player-controls">
        <div class="progress-row"><time id="current-time">00:00</time><input class="media-range" id="seek" type="range" min="0" max="1000" value="0" aria-label="زمان پخش"><time id="duration">00:00</time></div>
        <div class="control-row">
          <div class="control-cluster">
            <button class="control-button" id="fullscreen" type="button" aria-label="تمام‌صفحه"><svg viewBox="0 0 24 24"><path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5"/></svg></button>
            <button class="control-button" id="settings-button" type="button" aria-label="تنظیمات"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63h.01A1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9v.01A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/></svg></button>
            <button class="control-button" id="caption-button" type="button" aria-label="زیرنویس"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10H7a2 2 0 0 0 0 4h3m7-4h-3a2 2 0 0 0 0 4h3"/></svg></button>
          </div>
          <div class="control-cluster"><input class="media-range volume-range" id="volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="صدا"><button class="control-button" id="mute" type="button" aria-label="قطع صدا"><svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5Zm4 5a3 3 0 0 1 0 4m3-7a7 7 0 0 1 0 10"/></svg></button><button class="control-button" id="play-toggle" type="button" aria-label="پخش"><svg viewBox="0 0 24 24"><path class="fill" d="m8 5 11 7-11 7V5Z"/></svg></button></div>
        </div>
      </div>
      <div class="settings-menu" id="settings-menu"><div class="settings-title">مسیر صدا</div><div id="audio-options"></div><div class="settings-title">زیرنویس</div><div id="subtitle-options"></div><div class="settings-title">ظاهر و زمان زیرنویس</div>
      <div class="subtitle-settings">
        <label>اندازه <input id="subtitle-size" type="range" min="12" max="48" step="1" value="24"><output id="subtitle-size-value">24px</output></label>
        <label>رنگ <input id="subtitle-color" type="color" value="#ffffff"></label>
        <label>فونت <select id="subtitle-font"><option value="Vazirmatn, sans-serif">وزیرمتن</option><option value="sans-serif">ساده</option><option value="serif">سریف</option><option value="monospace">تک‌فاصله</option></select></label>
        <label>تأخیر (ثانیه) <input id="subtitle-delay" type="number" min="-60" max="60" step="0.5" value="0"></label>
      </div><div class="settings-title">سرعت</div><div id="speed-options"></div></div>`;
  }

  async function renderPlayer(assetId, version) {
    setActiveNav('');
    if (state.config?.player?.enabled === false) {
      app.innerHTML = `<div class="page-shell page-top">${emptyState('پخش آنلاین غیرفعال است', 'برای دریافت نسخه‌ها از دکمه دریافت فایل استفاده کنید.')}</div>`;
      return;
    }
    setHeaderLabel('پخش و دانلود', true);
    const [contentData, mediaData, progressData, sourceData] = await Promise.all([
      api(`/contents/${encodeURIComponent(assetId)}`),
      api(`/contents/${encodeURIComponent(assetId)}/media-options`),
      state.user ? api('/progress').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
      api(`/contents/${encodeURIComponent(assetId)}/player-sources`).catch(() => ({ sources: [] })),
    ]);
    if (version !== state.routeVersion) return;
    const content = contentData.content;
    const resumeEntry = (progressData.items || []).find((entry) => entry.content.id === content.id && !entry.completed);
    const relatedData = content.genres?.[0]
      ? await api(`/contents?limit=9&genre=${encodeURIComponent(content.genres[0])}`).catch(() => ({ items: [] }))
      : { items: [] };
    if (version !== state.routeVersion) return;
    const related = (relatedData.items || []).filter((item) => item.id !== content.id).slice(0, 8);
    const isAndroid = /\bVizostenAndroid\//.test(navigator.userAgent);
    const versions = playbackVersions(content, mediaData.items || [], sourceData.sources || [])
      .filter((item) => !isAndroid || new URL(item.streamUrl).protocol === 'https:');
    const preferred = versions.findIndex((item) => item.streamUrl === content.streamUrl);
    const initialIndex = preferred >= 0 ? preferred : 0;
    const selected = versions[initialIndex];
    const streamUrl = selected?.streamUrl || '';
    const safeStream = safeUrl(streamUrl);
    // Android uses the native renderer, never an HTML video fallback. The marker
    // also lets us show a useful error on old WebViews without message support.
    if (isAndroid) {
      renderAndroidPlayerLaunch(content, versions, initialIndex, resumeEntry);
      return;
    }
    app.innerHTML = `<div class="page-shell player-page">
      <div class="player-shell controls-visible" id="player-shell">
        <video id="video" class="${safeStream ? '' : 'pixelated'}" playsinline preload="metadata" ${safeStream ? `src="${safeStream}"` : ''}></video>
        ${!safeStream ? `<div class="player-unavailable" id="unavailable-overlay">${icons.film}<strong>پخش آنلاین در دسترس نیست - دریافت از تلگرام</strong><span>در حال حاضر منبعی برای پخش این محتوا تنظیم نشده است.</span></div>` : ''}
        ${playerControlMarkup(titleFa(content) || titleEn(content), versions)}<div id="player-ad-slot"></div>
      </div>
      <div id="timed-banner-slot"></div>
      <section class="player-info">
        <div class="player-info-main"><div class="player-title-row"><div><h1>${escapeHtml(titleFa(content) || titleEn(content))}</h1>${titleEn(content) && titleEn(content) !== titleFa(content) ? `<p class="original-title" dir="ltr" lang="en">${escapeHtml(titleEn(content))}</p>` : ''}</div><button class="icon-button" data-favorite="${escapeHtml(content.id)}" aria-label="نشان کردن">${icons.heart}</button></div>
          <div class="hero-meta">${content.imdbScore !== null ? `<span class="rating"><b>★</b> IMDb ${escapeHtml(content.imdbScore)}</span>` : ''}${content.releaseYear ? `<span class="meta-dot">${escapeHtml(yearLabel(content))}</span>` : ''}<span class="meta-dot">${content.type === 'series' ? 'سریال' : 'فیلم سینمایی'}</span>${content.genres?.length ? `<span class="meta-dot">${content.genres.slice(0, 3).map(escapeHtml).join('، ')}</span>` : ''}</div>
          ${content.description ? `<p class="player-description">${escapeHtml(content.description)}</p>` : ''}
        </div>
        <aside class="offline-card"><div><span class="offline-icon">${icons.download}</span><div><strong>دانلود و تماشای آفلاین</strong><small>${formatNumber(mediaData.items.length)} نسخه آماده ارسال امن با تلگرام</small></div></div><button class="primary-button" data-open-download="${escapeHtml(content.id)}">انتخاب نسخه</button></aside>
      </section>
      ${related.length ? `<section class="content-section"><div class="section-head"><div><h2>شاید بپسندید</h2><p>آثار مشابه در همین ژانر</p></div></div><div class="media-scroller">${related.map(mediaCard).join('')}</div></section>` : ''}
    </div>`;
    let localResume = 0;
    try { localResume = Number(JSON.parse(localStorage.getItem(`vizosten-progress:${content.id}`) || 'null')?.position || 0); } catch { /* storage is optional */ }
    initializePlayer(content.id, state.user ? Number(resumeEntry?.positionSeconds || 0) : localResume, versions, initialIndex);
    if (selected) bindVersionTracks(selected);
  }

  function renderAndroidPlayerLaunch(content, versions, initialIndex, resumeEntry) {
    app.innerHTML = `<div class="page-shell page-top"><section class="surface-panel">
      <h1>${escapeHtml(titleFa(content) || titleEn(content))}</h1>
      <p id="native-player-status" role="status">در حال باز کردن پلیر…</p>
      <button class="primary-button" id="native-player-open" type="button" hidden>تلاش دوباره</button></section></div>`;
    const bridge = window.VizostenNative;
    const status = $('#native-player-status');
    const retry = $('#native-player-open');
    if (!bridge || typeof bridge.postMessage !== 'function') {
      status.textContent = 'پلیر بومی در این نسخه از برنامه در دسترس نیست؛ WebView اندروید را به‌روزرسانی کنید.';
      return;
    }
    bridge.onmessage = (event) => {
      if (!status.isConnected) return;
      status.textContent = event.data === 'ok' ? 'پلیر باز شد.' : 'باز کردن پلیر ممکن نشد؛ دوباره تلاش کنید.';
      retry.hidden = false;
    };
    const open = () => {
      let uri;
      try {
        uri = new URL(versions[initialIndex]?.streamUrl);
        if (uri.protocol !== 'https:' || uri.username || uri.password) throw new Error();
      } catch { status.textContent = 'منبع پخش معتبری برای این محتوا تنظیم نشده است.'; retry.hidden = true; return; }
      let nativeVersions = versions.filter((item) => {
        try { return new URL(item.streamUrl).protocol === 'https:'; } catch { return false; }
      });
      // Android's bridge and Binder impose size limits; keep the selected item.
      if (nativeVersions.length > 1000) {
        nativeVersions = [versions[initialIndex], ...nativeVersions.filter((item) => item !== versions[initialIndex])].slice(0, 1000);
      }
      const nativeIndex = nativeVersions.indexOf(versions[initialIndex]);
      let localResume = 0;
      try { localResume = Number(JSON.parse(localStorage.getItem(`vizosten-progress:${content.id}`) || 'null')?.position || 0); } catch { /* storage is optional */ }
      const seconds = state.user ? Number(resumeEntry?.positionSeconds || 0) : localResume;
      const payload = { action: 'openPlayer', contentId: content.id, title: titleFa(content) || titleEn(content),
        streamUrl: uri.href, subtitleUrls: versions[initialIndex].subtitleUrls.slice(0, 30), audioUrls: versions[initialIndex].audioUrls.slice(0, 30),
        versions: nativeVersions, selectedVersion: Math.max(0, nativeIndex),
        resumeMillis: Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds * 1000)) : 0,
        sessionToken: state.user ? state.token : '' };
      status.textContent = 'در حال باز کردن پلیر…'; retry.hidden = true;
      try { bridge.postMessage(JSON.stringify(payload)); }
      catch { status.textContent = 'باز کردن پلیر بومی ممکن نشد.'; retry.hidden = false; }
    };
    retry.addEventListener('click', open);
    open();
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '00:00';
    const value = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function parseSubtitleTime(value) {
    const match = String(value).trim().match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
    if (!match) return NaN;
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(String(match[4]).padEnd(3, '0')) / 1000;
  }

  function parseSrt(text) {
    return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n+/).map((block) => {
      const lines = block.split('\n');
      // WebVTT metadata/comments do not contain cues. A cue identifier can be
      // arbitrary text (not just an SRT numeric index).
      if (/^(?:WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE\s*$|REGION\s*$)/.test(lines[0]?.trim() || '')) return null;
      const timingIndex = lines.findIndex((line, index) => index <= 1 && line.includes('-->'));
      if (timingIndex < 0) return null;
      const timing = lines[timingIndex].match(/^\s*(\S+)\s*-->\s*(\S+)(?:\s.*)?$/);
      if (!timing) return null;
      const start = parseSubtitleTime(timing[1]);
      const end = parseSubtitleTime(timing[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      const cueText = lines.slice(timingIndex + 1).join('\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim();
      return cueText ? { start, end, text: cueText } : null;
    }).filter(Boolean).sort((a, b) => a.start - b.start);
  }

  function destroyPlayer() {
    if (!state.player) return;
    clearTimeout(state.player.bannerTimer);
    clearTimeout(state.player.pauseBannerTimer);
    clearTimeout(state.player.controlsTimer);
    state.player.cancelAd?.();
    state.player.saveProgress?.(true);
    state.player.externalAudios.forEach((track) => track.audio.pause());
    state.player.cleanup.forEach((cleanup) => cleanup());
    state.player = null;
  }

  function initializePlayer(assetId, resumeSeconds = 0, versions = [], initialIndex = 0) {
    destroyPlayer();
    const video = $('#video');
    const shell = $('#player-shell');
    if (!video || !shell) return;
    const player = {
      video,
      shell,
      versions,
      versionIndex: initialIndex,
      trackGeneration: 0,
      switchingVersion: false,
      pendingVersionSeek: null,
      externalAudio: null,
      externalAudioEnabled: false,
      externalAudios: [],
      externalCues: [],
      subtitles: [],
      selectedSubtitle: 'off',
      subtitleDelay: 0,
      externalSubtitlesEnabled: false,
      preRollChecked: false,
      midRollChecked: false,
      adActive: false,
      cleanup: [],
      controlsTimer: null,
      pauseAdLoaded: false,
      bannerTimer: null,
      lastProgressSave: 0,
      hasAppliedResume: false,
      saveProgress: null,
    };
    state.player = player;
    const on = (target, event, listener, options) => {
      target.addEventListener(event, listener, options);
      player.cleanup.push(() => target.removeEventListener(event, listener, options));
    };
    const playButton = $('#play-toggle');
    const seek = $('#seek');
    const volume = $('#volume');
    const subtitleOverlay = $('#external-subtitle');

    function showControls() {
      shell.classList.add('controls-visible');
      clearTimeout(player.controlsTimer);
      if (!video.paused) player.controlsTimer = setTimeout(() => shell.classList.remove('controls-visible'), 2200);
    }
    function syncPlayIcon() {
      playButton.innerHTML = video.paused
        ? '<svg viewBox="0 0 24 24"><path class="fill" d="m8 5 11 7-11 7V5Z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path class="fill" d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';
      playButton.setAttribute('aria-label', video.paused ? 'پخش' : 'توقف');
      $('#center-play').textContent = video.paused ? '▶' : '❚❚';
      $('#center-play').setAttribute('aria-label', video.paused ? 'پخش' : 'توقف');
    }
    async function togglePlay() {
      if (player.adActive) return;
      try {
        if (!video.paused) { video.pause(); return; }
        if (!player.preRollChecked) {
          player.preRollChecked = true;
          await playPlayerAd('pre_roll', player);
          if (state.player !== player) return;
        }
        await video.play();
      } catch { toast('پخش ممکن نشد؛ دوباره دکمه پخش را بزنید و فرمت و نشانی فایل را بررسی کنید.', 'error'); }
    }
    function syncExternalAudio(force = false) {
      const audio = player.externalAudio;
      if (!audio || !player.externalAudioEnabled) return;
      if (force || Math.abs(audio.currentTime - video.currentTime) > 0.22) { try { audio.currentTime = video.currentTime; } catch { /* wait for metadata */ } }
      audio.playbackRate = video.playbackRate;
    }
    function renderExternalCue() {
      let cues = [];
      if (player.selectedSubtitle.startsWith('external-')) {
        cues = player.subtitles[Number(player.selectedSubtitle.slice(9))]?.cues || [];
      } else if (player.selectedSubtitle.startsWith('text-')) {
        const track = video.textTracks[Number(player.selectedSubtitle.slice(5))];
        if (track?.cues) cues = [...track.cues].map((cue) => ({ start: cue.startTime, end: cue.endTime, text: cue.text }));
      }
      const time = video.currentTime - player.subtitleDelay;
      const active = cues.filter((cue) => cue.start <= time && time < cue.end);
      subtitleOverlay.textContent = active.map((cue) => String(cue.text).replace(/<[^>]*>/g, '')).join('\n');
      subtitleOverlay.style.display = active.length ? 'block' : 'none';
    }
    function saveProgress(force = false) {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.currentTime < 1) return;
      const now = Date.now();
      if (!force && now - player.lastProgressSave < 15_000) return;
      player.lastProgressSave = now;
      if (!state.user) {
        try { localStorage.setItem(`vizosten-progress:${assetId}`, JSON.stringify({ position: video.currentTime / video.duration >= 0.92 ? 0 : Math.floor(video.currentTime) })); } catch { /* storage is optional */ }
        return;
      }
      api(`/contents/${encodeURIComponent(assetId)}/progress`, {
        method: 'POST',
        keepalive: force,
        body: JSON.stringify({
          positionSeconds: Math.floor(video.currentTime),
          durationSeconds: Math.floor(video.duration),
        }),
      }).catch(() => {});
    }
    player.saveProgress = saveProgress;

    function updateProgress() {
      const progress = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      seek.value = String(Math.round(progress * 10));
      seek.style.setProperty('--progress', `${progress}%`);
      $('#current-time').textContent = formatTime(video.currentTime);
      $('#duration').textContent = formatTime(video.duration);
      syncExternalAudio(false);
      renderExternalCue();
      saveProgress(false);
      if (!player.midRollChecked && !player.adActive && !video.paused && Number.isFinite(video.duration) && video.duration > 60 && video.currentTime >= video.duration / 2) {
        player.midRollChecked = true;
        player.adActive = true;
        video.pause();
        playPlayerAd('mid_roll', player).then(() => {
          if (state.player === player && !video.ended) video.play().catch(() => toast('برای ادامه دکمه پخش را بزنید.', 'error'));
        });
      }
    }
    function refreshSettings() {
      const audioContainer = $('#audio-options');
      const subtitleContainer = $('#subtitle-options');
      if (!audioContainer || !subtitleContainer) return;
      const audioOptions = [];
      if (video.audioTracks?.length) {
        for (let index = 0; index < video.audioTracks.length; index += 1) {
          const track = video.audioTracks[index];
          audioOptions.push({ id: `audio-${index}`, label: track.label || track.language || `مسیر داخلی ${index + 1}`, active: track.enabled && !player.externalAudioEnabled });
        }
      } else audioOptions.push({ id: 'embedded-default', label: 'صدای پیش‌فرض (انتخاب ترک داخلی در این مرورگر ممکن نیست)', active: !player.externalAudioEnabled });
      player.externalAudios.forEach((track, index) => audioOptions.push({ id: `external-audio-${index}`, label: track.label, active: player.externalAudioEnabled && player.externalAudio === track.audio }));
      audioContainer.innerHTML = audioOptions.map((option) => `<button type="button" class="setting-option ${option.active ? 'active' : ''}" data-audio-track="${option.id}">${escapeHtml(option.label)}</button>`).join('');
      const subtitleOptions = [{ id: 'off', label: 'خاموش', active: player.selectedSubtitle === 'off' }];
      player.subtitles.forEach((track, index) => subtitleOptions.push({ id: `external-${index}`, label: track.label, active: player.selectedSubtitle === `external-${index}` }));
      for (let index = 0; index < video.textTracks.length; index += 1) {
        const track = video.textTracks[index];
        if (!['subtitles', 'captions'].includes(track.kind)) continue;
        subtitleOptions.push({ id: `text-${index}`, label: track.label || track.language || `زیرنویس داخلی ${index + 1}`, active: player.selectedSubtitle === `text-${index}` });
      }
      subtitleContainer.innerHTML = subtitleOptions.map((option) => `<button type="button" class="setting-option ${option.active ? 'active' : ''}" data-subtitle-track="${option.id}">${escapeHtml(option.label)}</button>`).join('');
      $('#player-audio-menu').textContent = video.audioTracks?.length ? `صدا ${formatNumber(audioOptions.length)}` : player.externalAudios.length ? `صدا · ${formatNumber(player.externalAudios.length)} خارجی` : 'صدا';
      $('#player-subtitle-menu').textContent = `زیرنویس ${formatNumber(subtitleOptions.length - 1)}`;
      $('#speed-options').innerHTML = [0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => `<button type="button" class="setting-option ${video.playbackRate === speed ? 'active' : ''}" data-speed="${speed}">${speed === 1 ? 'عادی' : `${speed}×`}</button>`).join('');
    }

    player.refreshSettings = refreshSettings;
    const versionSelector = $('#player-version');
    if (versionSelector) {
      versionSelector.value = String(initialIndex);
      on(versionSelector, 'change', () => {
        const index = Number(versionSelector.value);
        const next = versions[index];
        const old = versions[player.versionIndex];
        if (!next || player.adActive) { versionSelector.value = String(player.versionIndex); return; }
        if (index === player.versionIndex) return;
        const wasPlaying = !video.paused;
        const sameEpisode = String(old?.season ?? '') === String(next.season ?? '') && String(old?.episode ?? '') === String(next.episode ?? '');
        const position = sameEpisode ? video.currentTime : 0;
        saveProgress(true);
        player.switchingVersion = true;
        video.pause();
        player.externalAudios.forEach((track) => track.audio.pause());
        player.externalAudios = []; player.externalAudio = null; player.externalAudioEnabled = false;
        video.muted = false; player.subtitles = []; player.selectedSubtitle = 'off';
        subtitleOverlay.textContent = ''; subtitleOverlay.style.display = 'none';
        player.trackGeneration += 1;
        player.versionIndex = index;
        player.pendingVersionSeek = position;
        player.hasAppliedResume = true;
        if (!sameEpisode) { player.midRollChecked = false; player.postRollShown = false; }
        video.src = next.streamUrl;
        video.load();
        bindVersionTracks(next);
        refreshSettings();
        if (wasPlaying) video.play().catch(() => toast('برای ادامه دکمه پخش را بزنید.', 'error'));
      });
    }
    on(playButton, 'click', togglePlay);
    on($('#center-play'), 'click', togglePlay);
    on($('#skip-back'), 'click', () => { if (!player.adActive) video.currentTime = Math.max(0, video.currentTime - 10); });
    on($('#skip-forward'), 'click', () => { if (!player.adActive && Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10); });
    function openTrackSettings(target) {
      refreshSettings();
      $('#settings-menu').classList.add('open');
      $(`#${target}`)?.scrollIntoView?.({ block: 'nearest' });
    }
    on($('#player-audio-menu'), 'click', () => openTrackSettings('audio-options'));
    on($('#player-subtitle-menu'), 'click', () => openTrackSettings('subtitle-options'));
    on(video, 'click', togglePlay);
    on(video, 'play', async () => {
      if (player.adActive) { video.pause(); return; }
      syncPlayIcon(); showControls();
      if (player.externalAudioEnabled && player.externalAudio) {
        syncExternalAudio(true);
        try { await player.externalAudio.play(); } catch { toast('پخش صدای خارجی ممکن نشد.', 'error'); }
      }
      player.pauseAdGeneration = (player.pauseAdGeneration || 0) + 1;
      clearAdSlot($('#pause-ad-slot'));
    });
    on(video, 'pause', () => {
      syncPlayIcon(); showControls(); player.externalAudio?.pause();
      if (player.switchingVersion) return;
      saveProgress(true);
      if (video.currentTime > 1 && !video.ended && !player.adActive && !player.switchingVersion) { player.pauseAdGeneration = (player.pauseAdGeneration || 0) + 1; loadPlayerAd('banner_pause', '#pause-ad-slot', player); }
    });
    on(video, 'waiting', () => { if (player.externalAudioEnabled) player.externalAudio?.pause(); });
    on(video, 'playing', () => {
      if (!player.externalAudioEnabled || !player.externalAudio || player.adActive) return;
      syncExternalAudio(true);
      player.externalAudio.play().catch(() => toast('پخش صدای خارجی ممکن نشد.', 'error'));
    });
    on(video, 'timeupdate', updateProgress);
    on(video, 'loadedmetadata', () => {
      if (player.pendingVersionSeek !== null) {
        video.currentTime = Math.max(0, Math.min(player.pendingVersionSeek, Math.max(0, video.duration - 1)));
        player.pendingVersionSeek = null;
      }
      player.switchingVersion = false;
      if (!player.hasAppliedResume && resumeSeconds > 3 && resumeSeconds < video.duration * 0.92) {
        video.currentTime = Math.min(resumeSeconds, Math.max(0, video.duration - 2));
        toast(`پخش از ${formatTime(resumeSeconds)} ادامه پیدا می‌کند.`, 'success');
      }
      player.hasAppliedResume = true;
      updateProgress(); refreshSettings();
    });
    on(video, 'durationchange', updateProgress);
    on(video, 'seeking', () => { syncExternalAudio(true); renderExternalCue(); });
    on(video, 'ratechange', () => { if (player.externalAudio) player.externalAudio.playbackRate = video.playbackRate; refreshSettings(); });
    on(video, 'ended', () => {
      player.externalAudio?.pause();
      saveProgress(true);
      // Post-roll: the owner's "پس از پخش" slot, if it is switched on.
      if (video.currentTime > 0 && !player.postRollShown) {
        player.postRollShown = true;
        playPlayerAd('timed_banner', player);
      }
    });
    on(seek, 'input', () => { if (video.duration) video.currentTime = (Number(seek.value) / 1000) * video.duration; });
    on(volume, 'input', () => {
      const value = Number(volume.value);
      if (player.externalAudioEnabled && player.externalAudio) player.externalAudio.volume = value;
      else video.volume = value;
    });
    on($('#mute'), 'click', () => {
      if (player.externalAudioEnabled && player.externalAudio) player.externalAudio.muted = !player.externalAudio.muted;
      else video.muted = !video.muted;
    });
    on($('#fullscreen'), 'click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else shell.requestFullscreen?.().catch(() => toast('تمام‌صفحه در این مرورگر پشتیبانی نمی‌شود.', 'error'));
    });
    on($('#settings-button'), 'click', () => { refreshSettings(); $('#settings-menu').classList.toggle('open'); });
    on($('#caption-button'), 'click', () => { refreshSettings(); $('#settings-menu').classList.toggle('open'); });
    function updateSubtitleStyle() {
      const settings = {
        size: Number($('#subtitle-size').value), color: $('#subtitle-color').value,
        font: $('#subtitle-font').value,
        delay: Math.max(-60, Math.min(60, Number($('#subtitle-delay').value) || 0)),
      };
      subtitleOverlay.style.fontSize = `${settings.size}px`;
      subtitleOverlay.style.color = settings.color;
      subtitleOverlay.style.fontFamily = settings.font;
      player.subtitleDelay = settings.delay;
      $('#subtitle-size-value').textContent = `${settings.size}px`;
      try { localStorage.setItem('vizosten-subtitle-settings', JSON.stringify(settings)); } catch { /* storage is optional */ }
      renderExternalCue();
    }
    try {
      const saved = JSON.parse(localStorage.getItem('vizosten-subtitle-settings') || '{}');
      if (Number.isFinite(saved.size) && saved.size >= 12 && saved.size <= 48) $('#subtitle-size').value = saved.size;
      if (/^#[0-9a-f]{6}$/i.test(saved.color || '')) $('#subtitle-color').value = saved.color;
      if ([...$('#subtitle-font').options].some((option) => option.value === saved.font)) $('#subtitle-font').value = saved.font;
      if (Number.isFinite(saved.delay) && saved.delay >= -60 && saved.delay <= 60) $('#subtitle-delay').value = saved.delay;
    } catch { /* malformed or unavailable local storage */ }
    updateSubtitleStyle();
    for (const id of ['subtitle-size', 'subtitle-color', 'subtitle-font', 'subtitle-delay']) on($(`#${id}`), 'input', updateSubtitleStyle);
    for (const list of [video.textTracks, video.audioTracks]) if (list?.addEventListener) {
      on(list, 'addtrack', refreshSettings); on(list, 'removetrack', refreshSettings);
    }
    on(video, 'error', () => { if (video.currentSrc) toast('پخش فایل ممکن نشد؛ نشانی، دسترسی و فرمت فایل را بررسی کنید.', 'error'); });
    on(shell, 'pointermove', showControls);
    on(shell, 'pointerleave', () => { if (!video.paused) shell.classList.remove('controls-visible'); });
    on(shell, 'keydown', (event) => {
      if (['INPUT', 'BUTTON', 'SELECT'].includes(event.target.tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      if (event.code === 'ArrowRight') video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
      if (event.code === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
    });
    shell.tabIndex = 0;
    syncPlayIcon(); refreshSettings();
    // The owner controls both which slots exist and how long they show, so the
    // banner slots are scheduled from config instead of a hardcoded placement.
    // "پس از پخش" follows the player's own clip; the banner strip under the player
    // is the owner's banner_player slot.
    player.bannerTimer = setTimeout(() => loadPlayerAd('banner_player', '#timed-banner-slot', player), 8000);

  }

  function bindVersionTracks(version) {
    for (const url of version.subtitleUrls) bindPlayerSource('subtitle', url);
    for (const url of version.audioUrls) bindPlayerSource('audio', url);
  }

  // Only tracks associated with the selected administrator-configured source.
  async function bindPlayerSource(type, sourceUrl) {
    const player = state.player;
    if (!player || !['subtitle', 'audio'].includes(type)) return;
    const generation = player.trackGeneration;
    let url;
    try {
      const parsed = new URL(sourceUrl, window.location.origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      url = parsed.toString();
    } catch { return; }
    if (type === 'audio') {
      const audio = new Audio(url);
      audio.preload = 'metadata';
      audio.volume = Number($('#volume')?.value ?? 1);
      player.externalAudios.push({ audio, label: `صدای خارجی ${player.externalAudios.length + 1}` });
      player.refreshSettings?.();
      return;
    }
    try {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) return;
      const cues = parseSrt(await response.text());
      if (!cues.length || state.player !== player || generation !== player.trackGeneration) return;
      player.subtitles.push({ cues, label: `زیرنویس خارجی ${player.subtitles.length + 1}` });
      player.refreshSettings?.();
    } catch { /* A track host may not allow CORS. Other tracks remain usable. */ }
  }

  // Count a rendered creative, not merely an ad-server response. This is an
  // observable client-side signal, not proof that a person saw the advert.
  function observeAdImpression(ad, element) {
    if (!element) return () => {};
    let reported = false;
    let intersecting = false;
    const isVideo = element.tagName === 'VIDEO';
    const isImage = element.tagName === 'IMG';
    let mediaReady = isVideo ? false : isImage ? Boolean(element.complete && element.naturalWidth) : true;
    let observer;
    const fallbackVisible = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      return rect.width > 0 && rect.height > 0 && width * height >= rect.width * rect.height * 0.5;
    };
    const cleanup = () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', check);
      element.removeEventListener('playing', onReady);
      element.removeEventListener('load', onReady);
      window.removeEventListener('scroll', check, true);
      window.removeEventListener('resize', check);
    };
    function check() {
      if (reported || !element.isConnected || document.visibilityState !== 'visible' || !mediaReady) return;
      if (isVideo && (element.paused || element.ended)) return;
      if (!(observer ? intersecting : fallbackVisible())) return;
      reported = true;
      recordAdEvent(ad, 'impression');
      cleanup();
    }
    function onReady() { mediaReady = true; check(); }
    document.addEventListener('visibilitychange', check);
    element.addEventListener(isVideo ? 'playing' : 'load', onReady);
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        const entry = entries.find((item) => item.target === element);
        intersecting = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5);
        check();
      }, { threshold: [0, 0.5] });
      observer.observe(element);
    } else {
      window.addEventListener('scroll', check, true);
      window.addEventListener('resize', check);
    }
    check();
    return cleanup;
  }

  const pageAdCleanups = [];
  async function loadPageAd(placement, selector, version) {
    try {
      const { ad } = await api(`/ads/serve?placement=${encodeURIComponent(placement)}`);
      const host = $(selector);
      if (!ad || version !== state.routeVersion || !host) return;
      const image = !placement.startsWith('text_') && safeUrl(ad.creativeUrl);
      if (!placement.startsWith('text_') && !image) return;
      host.innerHTML = `<a class="page-ad ${image ? 'page-ad--banner' : 'page-ad--text'}" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener noreferrer" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}"><span class="page-ad-label">تبلیغ</span>${image ? `<img src="${image}" loading="lazy" alt="">` : ''}<span class="page-ad-copy"><strong>${escapeHtml(ad.headline)}</strong>${ad.body ? `<span>${escapeHtml(ad.body)}</span>` : ''}</span><b aria-hidden="true">↗</b></a>`;
      pageAdCleanups.push(observeAdImpression(ad, image ? $('img', host) : $('a', host)));
    } catch { /* Content remains usable when the ad server is unavailable. */ }
  }

  function clearAdSlot(host) {
    if (!host) return;
    host._adCleanup?.();
    host._adCleanup = null;
    host.replaceChildren();
  }

  // Ad requests fail open: playback must not be held hostage by an unavailable ad server.
  async function playPlayerAd(placement, player) {
    if (state.player !== player) return;
    player.adActive = true;
    let requestTimer;
    let ad;
    try {
      const result = await Promise.race([
        api(`/ads/serve?placement=${placement}`),
        new Promise((resolve) => { requestTimer = setTimeout(() => resolve({ ad: null }), 4000); }),
      ]);
      ad = result.ad;
    } catch { ad = null; }
    clearTimeout(requestTimer);
    if (state.player !== player) return;
    const host = $('#player-ad-slot');
    if (!ad || !host || !safeUrl(ad.creativeUrl)) { player.adActive = false; return; }
    await new Promise((resolve) => {
      let finished = false;
      let elapsed = 0;
      const duration = Math.max(1, Math.min(120, Number(ad.durationSeconds) || 15));
      const skipAt = Math.max(0, Math.min(120, Number(ad.skipAfterSeconds) || 0));
      const media = ad.assetType === 'video'
        ? `<video class="player-ad-video" src="${safeUrl(ad.creativeUrl)}" playsinline controls></video>`
        : `<img class="player-ad-image" src="${safeUrl(ad.creativeUrl)}" alt="${escapeHtml(ad.headline)}">`;
      host.innerHTML = `<div class="player-ad-stage" role="region" aria-label="تبلیغ"><span class="player-ad-label">تبلیغ</span>${media}<a class="player-ad-link" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}">${escapeHtml(ad.headline)} ↗</a><button class="player-ad-skip" type="button" disabled>رد کردن</button></div>`;
      const creative = $('.player-ad-video', host);
      const image = $('.player-ad-image', host);
      const skip = $('.player-ad-skip', host);
      let lastVideoTime = 0;
      let stalledFor = 0;
      const stopObserving = observeAdImpression(ad, creative || image);
      function finish(eventType) {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        stopObserving();
        creative?.pause();
        host.replaceChildren();
        if (eventType) recordAdEvent(ad, eventType);
        player.cancelAd = null;
        player.adActive = false;
        resolve();
      }
      player.cancelAd = () => finish(null);
      function updateSkip() {
        const left = Math.max(0, Math.ceil(skipAt - elapsed));
        skip.disabled = left > 0;
        skip.textContent = left ? `رد کردن · ${formatNumber(left)}` : 'رد کردن تبلیغ';
      }
      updateSkip();
      skip.addEventListener('click', () => finish('skip'));
      creative?.addEventListener('ended', () => finish('complete'), { once: true });
      creative?.addEventListener('error', () => finish(null), { once: true });
      image?.addEventListener('error', () => finish(null), { once: true });
      const timer = setInterval(() => {
        if (state.player !== player) { finish(null); return; }
        if (creative) {
          const current = creative.currentTime;
          if (!creative.paused && current > lastVideoTime) { elapsed += Math.min(1, current - lastVideoTime); stalledFor = 0; }
          else if (!creative.paused) stalledFor += 1;
          lastVideoTime = current;
          if (stalledFor >= 15) { finish(null); return; }
        } else { elapsed += 1; if (elapsed >= duration) { finish('complete'); return; } }
        updateSkip();
      }, 1000);
      if (creative) { creative.muted = true; creative.play().catch(() => { /* native controls let the viewer start it */ }); }
    });
  }

  async function loadPlayerAd(placement, selector, player) {
    const pauseGeneration = player.pauseAdGeneration;
    try {
      const { ad } = await api(`/ads/serve?placement=${placement}`);
      if (!ad || state.player !== player || (placement === 'banner_pause' && (ad.assetType !== 'image' || pauseGeneration !== player.pauseAdGeneration || !player.video.paused || player.adActive || player.video.ended))) return;
      const host = $(selector);
      if (!host) return;
      // The owner sets how many seconds a creative stays on screen.
      document.documentElement.style.setProperty(`--ad-duration-${placement}`, `${Number(ad.durationSeconds || 8)}s`);
      const displayId = `${ad.id}:${ad.session}`;
      clearAdSlot(host);
      host.dataset.displayId = displayId;
      if (ad.durationSeconds && placement !== 'banner_pause') {
        setTimeout(() => {
          if (state.player === player && host.dataset.displayId === displayId) clearAdSlot(host);
        }, Number(ad.durationSeconds) * 1000);
      }
      const media = ad.assetType === 'video'
        ? `<video src="${safeUrl(ad.creativeUrl)}" muted autoplay playsinline loop></video>`
        : `<img src="${safeUrl(ad.creativeUrl)}" alt="${escapeHtml(ad.headline)}">`;
      host.innerHTML = placement === 'banner_pause'
        ? `<a class="pause-ad-card" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}"><span>تبلیغ</span>${media}<strong>${escapeHtml(ad.headline)}</strong></a>`
        : `<a class="timed-banner" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}">${media}<div><small>پیشنهاد ویژه</small><strong>${escapeHtml(ad.headline)}</strong><p>${escapeHtml(ad.body || '')}</p></div><b>مشاهده</b></a>`;
      host._adCleanup = observeAdImpression(ad, $('video, img', host));
      player.cleanup.push(() => clearAdSlot(host));
    } catch {
      // Ad inventory must never interrupt playback.
    }
  }

  function roleSwitcher(active = 'user') {
    return `<nav class="role-switcher" aria-label="انتخاب محیط">
      <button class="${active === 'user' ? 'active' : ''}" data-route="/profile">کاربر</button>
      ${state.user ? `<button class="${active === 'advertiser' ? 'active' : ''}" data-route="/advertiser">تبلیغ‌دهنده</button>` : ''}
    </nav>`;
  }

  async function renderProfile(version) {
    setActiveNav('');
    setHeaderLabel('پروفایل');
    if (!state.user) {
      app.innerHTML = `<div class="page-shell page-top">${emptyState('ورود امن با تلگرام', 'بدون رمز عبور و تنها با یک کد شش‌رقمی وارد شوید. شماره تلفن شما به‌صورت رمزگذاری‌شده نگه‌داری می‌شود.', '<button class="primary-button" style="margin-top:18px" data-login>دریافت کد ورود</button>')}</div>`;
      return;
    }
    const [stats, progressData] = await Promise.all([
      api('/me/stats'),
      api('/progress').catch(() => ({ items: [] })),
    ]);
    if (version !== state.routeVersion) return;
    const progress = (progressData.items || []).slice(0, 8);
    const watchedHours = Math.floor(Number(stats.watchedSeconds || 0) / 3600);
    app.innerHTML = `<div class="page-shell page-top account-page">
      ${roleSwitcher('user')}
      <section class="account-hero">
        <div class="large-avatar">${escapeHtml(firstLetter(state.user.accountName))}</div>
        <div><h1>${escapeHtml(state.user.accountName)}</h1><p>عضو و تبلیغ‌دهنده ویزوستن · از ${formatDate(state.user.createdAt)}</p></div>
      </section>
      <section class="account-stats" aria-label="آمار حساب">
        <div><strong>${formatNumber(watchedHours)}</strong><span>ساعت تماشا</span></div>
        <div><strong>${formatNumber(stats.completed)}</strong><span>اثر کامل‌شده</span></div>
        <div><strong>${formatNumber(stats.favorites)}</strong><span>نشان‌شده</span></div>
      </section>
      ${progress.length && onlinePlaybackVisible() ? `<section class="content-section account-progress"><div class="section-head"><div><h2>ادامه تماشا</h2><p>آخرین فعالیت پخش شما</p></div><button class="text-button" data-route="/home">مشاهده همه</button></div><div class="resume-scroller">${progress.map(continueCard).join('')}</div></section>` : ''}
      <div class="account-groups">
        <section><h2>کتابخانه من</h2><div class="menu-list surface-panel">
          <button class="menu-row" data-route="/favorites"><div><span class="menu-icon">♡</span><span>نشان‌شده‌ها</span></div><small>${formatNumber(stats.favorites)} ←</small></button>
          <button class="menu-row" data-route="/downloads"><div><span class="menu-icon">↓</span><span>تاریخچه دانلود</span></div><small>${formatNumber(stats.downloads)} ←</small></button>
          <button class="menu-row" data-route="/search"><div>${icons.search}<span>کشف آثار تازه</span></div><small>جستجو ←</small></button>
        </div></section>
        <section><h2>حساب و دسترسی</h2><div class="menu-list surface-panel">
          <button class="menu-row" data-route="/advertiser"><div>${icons.megaphone}<span>مرکز تبلیغ‌دهندگان</span></div><small>ورود ←</small></button>
          <button class="menu-row" type="button"><div><span class="menu-icon">✓</span><span>ورود امن تلگرام</span></div><small>فعال</small></button>
          <button class="menu-row danger-row" id="logout-user"><div><span class="menu-icon">↪</span><span>خروج از این دستگاه</span></div><small>←</small></button>
        </div></section>
      </div>
    </div>`;
  }

  async function renderAdvertiser(version) {
    setActiveNav('');
    setHeaderLabel('تبلیغات');
    if (!state.user) {
      app.innerHTML = `<div class="page-shell page-top">${emptyState('مرکز تبلیغ‌دهندگان', 'برای مشاهده کیف پول و ساخت کمپین ابتدا وارد شوید.', '<button class="primary-button" style="margin-top:18px" data-login>ورود با تلگرام</button>')}</div>`;
      return;
    }
    const data = await api('/advertiser/profile');
    if (version !== state.routeVersion) return;
    const prices = state.config.placementPrices || [];
    const typeLabels = { video:'ویدیو', image:'تصویر / بنر', text:'متن', link:'دکمهٔ زیر فایل تلگرام' };
    const availableTypes = [...new Set(prices.map((price) => price.asset))];
    const typeOptions = availableTypes.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(typeLabels[type] || type)}</option>`).join('');
    const priceCards = prices.map((price) => `<label class="price-card" data-slot-type="${escapeHtml(price.asset)}" hidden><input type="checkbox" name="placements" value="${escapeHtml(price.placement)}"><strong>${escapeHtml(price.label)}</strong><span>تعرفهٔ پایه: ${formatMoney(price.cpm, price.currency)} / ${price.group === 'link' ? 'هزار ارسال فایل' : 'هزار نمایش'}</span></label>`).join('');
    const statusLabels = { active: 'فعال', paused: 'متوقف', pending: 'در بررسی', rejected: 'ردشده', completed: 'پایان‌یافته', cancelled: 'لغوشده' };
    const campaigns = data.campaigns.length ? data.campaigns.map((campaign) => {
      const percent = campaign.budget > 0 ? Math.min(100, (campaign.spent / campaign.budget) * 100) : 0;
      return `<article class="campaign-card">
        <div class="campaign-creative">${campaign.creativeUrl ? (campaign.assetType === 'video' ? `<video src="${safeUrl(campaign.creativeUrl)}" muted preload="metadata"></video>` : `<img src="${safeUrl(campaign.creativeUrl)}" alt="">`) : '<span>AD</span>'}<i class="status-dot status-${escapeHtml(campaign.status)}"></i></div>
        <div class="campaign-main"><div class="campaign-title"><div><h3>${escapeHtml(campaign.name)}</h3><p>${escapeHtml(campaign.headline)}</p></div><span class="status-pill status-${escapeHtml(campaign.status)}">${escapeHtml(statusLabels[campaign.status] || campaign.status)}</span></div>
          <p class="muted">جایگاه‌ها: ${escapeHtml((campaign.placements || [campaign.placement]).map((key) => prices.find((price) => price.placement === key)?.label || key).join('، '))}</p><div class="campaign-metrics"><span><b>${formatNumber(campaign.impressions)}</b> نمایش</span><span>${campaign.placement === 'link_file_button' && campaign.telegramClickMode === 'direct' ? 'کلیک مستقیم قابل ثبت نیست' : `<b>${formatNumber(campaign.clicks)}</b> کلیک`}</span><span><b>${formatNumber(campaign.completes)}</b> پایان</span><span><b>${formatNumber(campaign.skips)}</b> رد</span><span><b>${formatMoney(campaign.spent)}</b> هزینه</span></div>
          <div class="budget-progress"><i><b style="width:${percent.toFixed(1)}%"></b></i><small>${formatNumber(percent.toFixed(0))}٪ بودجه · تا ${formatDate(campaign.endsAt)}</small></div>
        </div>
        ${['active', 'paused'].includes(campaign.status) ? `<button type="button" class="campaign-toggle" data-campaign-status="${campaign.status === 'active' ? 'paused' : 'active'}" data-campaign-id="${escapeHtml(campaign.id)}">${campaign.status === 'active' ? 'توقف' : 'ادامه'}</button>` : ''}
        <button type="button" class="campaign-toggle campaign-delete" data-campaign-delete="${escapeHtml(campaign.id)}">حذف کمپین</button>
      </article>`;
    }).join('') : '<p style="color:#71717a;font-size:12px">هنوز کمپینی ساخته نشده است.</p>';
    app.innerHTML = `<div class="page-shell page-top advertiser-page">
      ${roleSwitcher('advertiser')}
      <div class="section-head"><div><h1 class="page-title">داشبورد تبلیغ‌دهنده</h1><p>مدیریت بودجه، جایگاه‌ها و عملکرد کمپین</p></div><button type="button" class="primary-button" data-scroll-campaign>+ کمپین جدید</button></div>
      <section class="ad-metrics">
        <div><span>نمایش کل</span><strong>${formatNumber(data.analytics?.impressions)}</strong><small>رویدادهای معتبر</small></div>
        <div><span>کلیک کل</span><strong>${formatNumber(data.analytics?.clicks)}</strong><small>نرخ کلیک ${formatNumber(data.analytics?.ctr)}٪</small></div>
        <div><span>هزینه کل</span><strong>${formatMoney(data.analytics?.spent)}</strong><small>کسرشده از کیف پول</small></div>
      </section>
      <div class="advertiser-top">
        <section class="surface-panel wallet-card"><span class="wallet-label">موجودی قابل استفاده</span><strong class="wallet-balance">${formatMoney(data.wallet.balance, data.wallet.currency)}</strong><span class="wallet-currency">کیف پول امن کمپین‌ها</span>
          <form id="coupon-redemption-form" class="coupon-redemption"><label class="form-field"><span>کد افزایش موجودی</span><input class="form-input" name="code" maxlength="32" dir="ltr" autocomplete="off" required placeholder="کد تخفیف"></label><button class="primary-button" type="submit">اعمال کد</button></form>
        </section>
        <section class="surface-panel"><h2>چگونه تبلیغ بسازیم؟</h2><p class="muted">ابتدا نوع محتوا را انتخاب کنید، سپس یک یا چند جایگاه سازگار را علامت بزنید. یک بودجه برای همهٔ جایگاه‌ها رزرو می‌شود و تعرفهٔ هر جایگاه جداگانه است.</p></section>
      </div>
      <div class="hub-layout">
        <section class="surface-panel campaigns-panel"><h2>کمپین‌های من</h2><div class="campaign-list">${campaigns}</div></section>
        <section class="surface-panel" id="new-campaign"><h2>ساخت کمپین</h2><form id="campaign-form">
          <label class="form-field"><span>۱. نوع محتوای تبلیغ</span><select class="form-select" name="creativeType" required><option value="">نوع محتوا را انتخاب کنید</option>${typeOptions}</select></label>
          <fieldset class="campaign-placements"><legend>۲. جایگاه‌های نمایش</legend><p data-slot-prompt>ابتدا نوع محتوا را انتخاب کنید.</p><div class="price-cards">${priceCards}</div><small>می‌توانید چند جایگاه انتخاب کنید؛ بودجه بین آن‌ها مشترک است.</small></fieldset>
          <label class="form-field"><span>نام داخلی کمپین</span><input class="form-input" name="campaignName" minlength="3" maxlength="180" required></label>
          <label class="form-field"><span>عنوان قابل نمایش</span><input class="form-input" name="headline" minlength="3" maxlength="180" required></label>
          <label class="form-field"><span>توضیح کوتاه</span><textarea class="form-textarea" name="body" maxlength="1000"></textarea></label>
          <label class="form-field"><span>بودجهٔ مشترک (ریال)</span><input class="form-input" name="budget" type="number" min="1" required><small>مبلغ یک‌بار رزرو می‌شود؛ حداقل بودجه باید حداقل به اندازهٔ بالاترین حداقل جایگاه‌های انتخابی باشد.</small></label>
          <label class="form-field" data-creative-field><span>نشانی HTTPS فایل تبلیغ</span><input class="form-input" name="creativeUrl" type="url" inputmode="url" required placeholder="https://cdn.example.com/ad.mp4"></label>
          <label class="form-field" data-bid-field><span>ضریب پیشنهاد (اولویت نمایش)</span><input class="form-input" name="bidMultiplier" type="range" min="1" max="${escapeHtml(state.config.maxPriorityMultiplier || 10)}" step="0.01" value="1" required><output data-bid-value>۱×</output><small>تعرفهٔ هر هزار نمایش برابر تعرفهٔ پایه × ضریب است. ضریب بالاتر احتمال انتخاب را بیشتر می‌کند.</small></label>
          <label class="form-field"><span>نشانی مقصد</span><input class="form-input" name="targetUrl" type="url" inputmode="url" placeholder="https://…"></label>
          <label class="form-field" data-landing-mode hidden><span>پس از کلیک</span><select class="form-select" name="landingMode"><option value="direct">مستقیم به مقصد (با ثبت کلیک)</option><option value="intermediate">صفحهٔ واسط سایت، سپس مقصد</option></select></label>
          <label class="form-field" data-telegram-mode hidden><span>شیوهٔ باز شدن دکمهٔ ربات</span><select class="form-select" name="telegramClickMode"><option value="tracked">از طریق سایت · با ثبت کلیک</option><option value="direct">مستقیم به تلگرام · بدون آمار کلیک</option></select><small>نشانی مقصد باید لینک کانال یا ربات در t.me باشد. هزینه بر اساس هر هزار ارسال فایل است و ضریب ندارد.</small></label>
          <div class="form-grid"><label class="form-field"><span>شروع</span><input class="form-input" name="startsAt" type="datetime-local" required></label><label class="form-field"><span>پایان</span><input class="form-input" name="endsAt" type="datetime-local" required></label></div>
          <div data-landing-fields hidden><label class="form-field"><span>متن صفحهٔ واسط (اختیاری)</span><textarea class="form-textarea" name="telegramPostText" maxlength="5000"></textarea></label>
          <div class="form-grid"><label class="form-field"><span>عنوان دکمهٔ اضافی (اختیاری)</span><input class="form-input" name="buttonText" maxlength="60" placeholder="مشاهده پیشنهاد"></label><label class="form-field"><span>نشانی دکمه</span><input class="form-input" name="buttonUrl" type="url" inputmode="url" placeholder="https://…"></label></div></div>
          <button class="primary-button" type="submit" style="width:100%">رزرو بودجه و ارسال برای بررسی</button>
        </form></section>
      </div>
    </div>`;
    setCampaignDateDefaults();
    setCampaignCreativeType();
  }

  function setCampaignCreativeType() {
    const form = $('#campaign-form'); if (!form) return;
    const type = $('[name="creativeType"]', form).value;
    $$('[data-slot-type]', form).forEach((label) => {
      const visible = type && label.dataset.slotType === type;
      label.hidden = !visible;
      const box = $('input', label); box.disabled = !visible; if (!visible) box.checked = false;
    });
    $('[data-slot-prompt]', form).hidden = Boolean(type);
    const creativeField = $('[data-creative-field]', form), creative = $('[name="creativeUrl"]', form);
    creativeField.hidden = !['image','video'].includes(type); creative.required = !creativeField.hidden;
    const bidField = $('[data-bid-field]', form); bidField.hidden = !type || type === 'link';
    if (type === 'link') { $('[name="bidMultiplier"]', form).value = '1'; $('[data-bid-value]', form).textContent = '۱×'; }
    $('[data-telegram-mode]', form).hidden = type !== 'link';
    $('[data-landing-mode]', form).hidden = !type || type === 'link';
    const intermediate = type && type !== 'link' && $('[name="landingMode"]', form).value === 'intermediate';
    $('[data-landing-fields]', form).hidden = !intermediate;
    $('[name="targetUrl"]', form).required = type === 'link' || (Boolean(type) && !intermediate);
    $('[name="headline"]', form).maxLength = type === 'link' ? 64 : 180;
  }

  function setCampaignDateDefaults() {
    const start = $('#campaign-form [name="startsAt"]');
    const end = $('#campaign-form [name="endsAt"]');
    if (!start || !end) return;
    const toLocal = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const now = new Date(Date.now() + 15 * 60000);
    const week = new Date(now.getTime() + 7 * 86400_000);
    start.value = toLocal(now);
    end.value = toLocal(week);
  }

  async function route() {
    const version = ++state.routeVersion;
    state.routeVisits += 1;
    closeModal();
    while (pageAdCleanups.length) pageAdCleanups.pop()();
    destroyPlayer();
    window.scrollTo({ top: 0, behavior: 'instant' });
    const parts = routeParts();
    const hashQuery = new URLSearchParams((window.location.hash.split('?')[1] || '').split('#')[0]);
    pageLoading();
    try {
      if (parts[0] === 'home' || !parts[0]) await renderHome(version);
      else if (parts[0] === 'search') await renderSearch(version, hashQuery.get('q') || '', hashQuery.get('genre') || '');
      else if (parts[0] === 'person') {
        const names = hashQuery.getAll('person').map((name) => name.trim()).filter(Boolean).slice(0, 4);
        if (!names.length) throw new Error('نام عوامل مشخص نشده است.');
        await renderSearch(version, '', '', { names, role: hashQuery.get('role') || '' });
      }
      else if (parts[0] === 'favorites') await renderFavorites(version);
      else if (parts[0] === 'downloads') await renderDownloads(version);
      else if (parts[0] === 'content' && parts[1]) await renderDetail(parts[1], version);
      else if (parts[0] === 'player' && parts[1]) await renderPlayer(parts[1], version);
      else if (parts[0] === 'profile') await renderProfile(version);
      else if (parts[0] === 'advertiser') await renderAdvertiser(version);
      else {
        setActiveNav('');
        setHeaderLabel('صفحه نامعتبر', true);
        app.innerHTML = `<div class="page-shell page-top">${emptyState('صفحه پیدا نشد', 'نشانی واردشده معتبر نیست.', '<button class="primary-button" style="margin-top:18px" data-route="/home">بازگشت به خانه</button>')}</div>`;
      }
      if (version === state.routeVersion) await refreshFavoriteButtons(version);
    } catch (error) {
      if (version !== state.routeVersion) return;
      setActiveNav('');
      app.innerHTML = `<div class="page-shell page-top">${emptyState('بارگذاری انجام نشد', apiErrorMessage(error), '<button class="primary-button" style="margin-top:18px" data-retry>تلاش دوباره</button>')}</div>`;
    }
  }

  function openModal(content, options = {}) {
    closeModal();
    modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><section class="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-handle"></div>${content}</section></div>`;
    document.body.style.overflow = 'hidden';
    if (options.locked) $('[data-modal-backdrop]')?.removeAttribute('data-modal-backdrop');
    requestAnimationFrame(() => $('.modal-sheet button, .modal-sheet input, .modal-sheet a')?.focus({ preventScroll: true }));
  }

  function closeModal() {
    state.modalAdCleanup?.();
    state.modalAdCleanup = null;
    clearInterval(state.modalTimer);
    state.modalTimer = null;
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
  }

  function modalHeader(title, subtitle = '') {
    return `<div class="modal-head"><div><h2 id="modal-title">${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div><button class="modal-close" type="button" data-modal-close aria-label="بستن">${icons.close}</button></div>`;
  }

  async function openAuth(afterLogin = null) {
    state.pendingAfterAuth = afterLogin;
    const botUrl = safeUrl(state.config.authBotUrl);
    openModal(`${modalHeader('ورود با تلگرام', 'کد شش‌رقمی، بدون ساخت رمز عبور')}
      <div class="telegram-login"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 3.4 18.5 20c-.2 1.2-.9 1.5-1.9.9l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6 13.7l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20 3.5c.9-.3 1.7.2 1.7-.1Z"/></svg><p>ربات عمومی را باز کنید، دکمه اشتراک شماره خودتان را بزنید و کدی را که ربات می‌فرستد اینجا وارد کنید.</p></div>
      ${botUrl ? `<a class="secondary-button" style="width:100%;margin-bottom:13px" href="${botUrl}?start=login" target="_blank" rel="noopener">باز کردن ربات ورود</a>` : '<div class="warning-box" style="margin-bottom:13px">ربات ورود هنوز توسط مدیر پیکربندی نشده است.</div>'}
      <form id="auth-form"><label class="form-field"><span>کد ورود</span><input class="form-input login-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="••••••"></label><button class="primary-button" type="submit" style="width:100%">تأیید و ورود</button></form>`);
  }

  async function verifyLogin(form) {
    const button = $('button[type="submit"]', form);
    const code = new FormData(form).get('code');
    if (!/^\d{6}$/.test(String(code))) {
      toast('کد باید دقیقاً شش رقم باشد.', 'error');
      return;
    }
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> در حال بررسی';
    try {
      const data = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ code }) });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem(storageKey, data.token);
      updateAccountUI();
      const callback = state.pendingAfterAuth;
      state.pendingAfterAuth = null;
      closeModal();
      toast(`خوش آمدید، ${state.user.accountName}`, 'success');
      if (callback) await callback(); else route();
    } catch (error) {
      toast(apiErrorMessage(error), 'error');
      button.disabled = false;
      button.textContent = 'تأیید و ورود';
    }
  }

  async function openDownload(assetId) {
    openModal(`${modalHeader('انتخاب نسخه دانلود')}<div style="display:grid;place-items:center;min-height:180px"><span class="spinner"></span></div>`);
    try {
      const data = await api(`/contents/${encodeURIComponent(assetId)}/media-options`);
      state.mediaMap.clear();
      data.items.forEach((item) => state.mediaMap.set(item.id, item));
      if (!data.items.length) {
        openModal(`${modalHeader('دریافت فایل')}${emptyState('نسخه‌ای ثبت نشده است', 'فایل‌های این اثر هنوز در ربات مدیریت بارگذاری نشده‌اند.')}`);
        return;
      }
      const seasons = new Map();
      for (const item of data.items) {
        const seasonKey = item.season ? `فصل ${formatNumber(item.season)}` : 'فیلم';
        if (!seasons.has(seasonKey)) seasons.set(seasonKey, new Map());
        const audioGroups = seasons.get(seasonKey);
        if (!audioGroups.has(item.audioLabel)) audioGroups.set(item.audioLabel, new Map());
        const resolutions = audioGroups.get(item.audioLabel);
        if (!resolutions.has(item.resolution)) resolutions.set(item.resolution, []);
        resolutions.get(item.resolution).push(item);
      }
      const renderVersions = (resolutions) => [...resolutions.entries()].map(([resolution, items]) => `<div class="resolution-label">${escapeHtml(resolution)}</div>${items.map((item) => `<button class="download-option" type="button" data-download-media="${escapeHtml(item.id)}"><span><strong>${item.episode ? `قسمت ${formatNumber(item.episode)} · ` : ''}${escapeHtml(item.version)}${item.encoder ? ` · ${escapeHtml(item.encoder)}` : ''}</strong><span>${escapeHtml(item.quality || item.subtitleType)}${item.episodeTitle ? ` · ${escapeHtml(item.episodeTitle)}` : ''}</span></span><b>${item.sizeText ? escapeHtml(item.sizeText) : formatBytes(item.fileSizeBytes)}</b></button>`).join('')}`).join('');
      const renderAudioGroups = (audioGroups, openFirst = true) => [...audioGroups.entries()].map(([audioLabel, resolutions], index) => `<details class="tree-group ${seasons.size > 1 || !seasons.has('فیلم') ? 'nested' : ''}" ${openFirst && index === 0 ? 'open' : ''}><summary><span>${escapeHtml(audioLabel)}</span><small>${formatNumber([...resolutions.values()].flat().length)} نسخه</small></summary><div class="tree-children">${renderVersions(resolutions)}</div></details>`).join('');
      const isSeriesTree = seasons.size > 1 || !seasons.has('فیلم');
      const tree = isSeriesTree
        ? [...seasons.entries()].map(([seasonLabel, audioGroups], index) => `<details class="tree-season" ${index === 0 ? 'open' : ''}><summary><span>${escapeHtml(seasonLabel)}</span><small>${formatNumber([...audioGroups.values()].flatMap((resolutions) => [...resolutions.values()].flat()).length)} فایل</small></summary><div class="tree-season-children">${renderAudioGroups(audioGroups)}</div></details>`).join('')
        : renderAudioGroups(seasons.get('فیلم'));
      openModal(`${modalHeader('انتخاب نسخه دانلود', isSeriesTree ? 'فصل ← نوع صدا ← رزولوشن و قسمت' : 'نوع صدا ← رزولوشن ← کیفیت و حجم')}<div>${tree}</div>`);
    } catch (error) {
      openModal(`${modalHeader('دریافت فایل')}<div class="warning-box">${escapeHtml(apiErrorMessage(error))}</div>`);
    }
  }

  async function beginDownload(mediaId) {
    const media = state.mediaMap.get(mediaId);
    if (!media) return;
    if (!state.user) {
      closeModal();
      await openAuth(() => beginDownload(mediaId));
      return;
    }
    openModal(`${modalHeader('آماده‌سازی دریافت')}<div style="display:grid;place-items:center;min-height:180px"><span class="spinner"></span></div>`, { locked: true });
    try {
      const { ad } = await api('/ads/serve?placement=video_download');
      if (!ad || ad.assetType !== 'video') {
        showDownloadWarning(mediaId);
        return;
      }
      showPreRoll(ad, mediaId);
    } catch {
      showDownloadWarning(mediaId);
    }
  }

  const adEventQueues = new Map();
  async function sendAdEvent(ad, eventType) {
    // A session/event pair is idempotent on the server. Retry transient errors;
    // do not retry validation/authentication failures or keep playback waiting.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await api(`/ads/${encodeURIComponent(ad.id)}/events`, {
          method: 'POST', keepalive: true,
          headers: { 'X-Ad-Session': ad.session },
          body: JSON.stringify({ eventType, session: ad.session }),
        });
        return;
      } catch (error) {
        if (attempt === 2 || (error.status && error.status < 500 && error.status !== 429)) return;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  function recordAdEvent(ad, eventType) {
    if (!ad?.id || !ad?.session) return Promise.resolve();
    const key = `${ad.id}:${ad.session}`;
    const previous = adEventQueues.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(() => sendAdEvent(ad, eventType));
    adEventQueues.set(key, queued);
    queued.finally(() => { if (adEventQueues.get(key) === queued) adEventQueues.delete(key); });
    return queued;
  }

  function showPreRoll(ad, mediaId) {
    const media = ad.assetType === 'video'
      ? `<video id="preroll-video" src="${safeUrl(ad.creativeUrl)}" autoplay playsinline muted></video>`
      : `<img src="${safeUrl(ad.creativeUrl)}" alt="${escapeHtml(ad.headline)}">`;
    let seconds = Math.max(0, Number(ad.skipAfterSeconds || 0));
    openModal(`${modalHeader('پیام حامی Vizosten')}<div class="ad-stage"><span class="ad-label">تبلیغ</span>${media}<button class="ad-skip" id="skip-ad" type="button" ${seconds ? 'disabled' : ''}>${seconds ? `رد کردن · ${formatNumber(seconds)}` : 'رد کردن تبلیغ'}</button></div><div class="ad-copy"><h3>${escapeHtml(ad.headline)}</h3><p>${escapeHtml(ad.body || '')}</p><a class="text-button" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}">مشاهده آگهی</a></div>`, { locked: true });
    const stopObserving = observeAdImpression(ad, $('.ad-stage video, .ad-stage img', modalRoot));
    state.modalAdCleanup = stopObserving;
    const skip = $('#skip-ad');
    skip.dataset.mediaId = mediaId;
    skip.dataset.adId = ad.id;
    skip.dataset.adSession = ad.session;
    const video = $('#preroll-video');
    if (video) {
      video.muted = false;
      video.addEventListener('ended', () => { recordAdEvent(ad, 'complete'); showDownloadWarning(mediaId); }, { once: true });
      video.addEventListener('error', () => showDownloadWarning(mediaId), { once: true });
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    }
    if (seconds > 0) {
      state.modalTimer = setInterval(() => {
        seconds -= 1;
        if (!$('#skip-ad')) return clearInterval(state.modalTimer);
        if (seconds <= 0) {
          clearInterval(state.modalTimer);
          skip.disabled = false;
          skip.textContent = 'رد کردن تبلیغ';
        } else skip.textContent = `رد کردن · ${formatNumber(seconds)}`;
      }, 1000);
    }
  }

  async function loadDownloadBanner(host) {
    try {
      const { ad } = await api('/ads/serve?placement=banner_download');
      if (!ad || !host.isConnected || !safeUrl(ad.creativeUrl)) return;
      host.innerHTML = `<a class="timed-banner" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}"><img src="${safeUrl(ad.creativeUrl)}" alt="${escapeHtml(ad.headline)}"><div><small>تبلیغ</small><strong>${escapeHtml(ad.headline)}</strong><p>${escapeHtml(ad.body || '')}</p></div><b>مشاهده</b></a>`;
      const cleanup = observeAdImpression(ad, $('img', host));
      const timer = setTimeout(() => { cleanup(); if (host.isConnected) host.replaceChildren(); }, Math.max(1, Number(ad.durationSeconds) || 8) * 1000);
      state.modalAdCleanup = () => { clearTimeout(timer); cleanup(); };
    } catch { /* Download remains available when advertising is unavailable. */ }
  }

  function showDownloadWarning(mediaId) {
    openModal(`${modalHeader('ارسال فایل به تلگرام')}<div class="warning-box">کاربر گرامی، برای دریافت فایل حتما فیلترشکن یا پروکسی تلگرام خود را روشن کنید</div><p style="color:#a1a1aa;font-size:11px;line-height:1.9;margin:13px 4px">سامانه ابتدا نسخه اصلی را بررسی می‌کند و اگر حذف شده باشد، بدون وقفه نسخه پشتیبان را جایگزین خواهد کرد.</p><div id="download-banner-slot"></div><button class="primary-button" id="confirm-delivery" data-media-id="${escapeHtml(mediaId)}" type="button" style="width:100%">تأیید و ارسال در ربات</button>`);
    loadDownloadBanner($('#download-banner-slot'));
  }

  async function invokeDelivery(mediaId) {
    const button = $('#confirm-delivery');
    if (button) { button.disabled = true; button.innerHTML = '<span class="spinner"></span> در حال بررسی نسخه‌های ذخیره‌شده'; }
    try {
      const result = await api('/download', { method: 'POST', body: JSON.stringify({ mediaId }) });
      const link = safeTelegramBotUrl(result.downloadBotUrl) || safeTelegramBotUrl(state.config.downloadBotUrl);
      openModal(`${modalHeader(result.deliveryMethod === 'telegram_link' ? 'لینک ارسال شد' : 'فایل ارسال شد')}<div class="empty-state"><div class="empty-icon" style="color:#86efac">✓</div><h2>تلگرام خود را بررسی کنید</h2><p>${escapeHtml(result.message)}${result.subtitleDelivered ? ' زیرنویس مجزا نیز پس از ویدیو ارسال شد.' : ''}</p>${link ? `<a class="primary-button" style="margin-top:18px" href="${link}" target="_blank" rel="noopener">باز کردن ربات دریافت</a>` : '<p>برای مشاهده پیام، ربات دریافت را در تلگرام باز کنید.</p>'}</div>`);
    } catch (error) {
      toast(apiErrorMessage(error), 'error');
      if (button) { button.disabled = false; button.textContent = 'تلاش دوباره'; }
    }
  }

  async function submitComment(form) {
    if (!state.currentContent) return;
    const input = form.elements.body;
    const body = input.value.trim();
    if (!body) return;
    const button = $('button', form);
    button.disabled = true;
    try {
      const data = await api(`/contents/${encodeURIComponent(state.currentContent.id)}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      const list = $('#comments-list');
      if (list) list.insertAdjacentHTML('afterbegin', commentsMarkup([data.comment]));
      input.value = '';
      toast('دیدگاه ثبت شد.', 'success');
    } catch (error) { toast(apiErrorMessage(error), 'error'); }
    finally { button.disabled = false; }
  }

  async function refreshFavoriteButtons(version = state.routeVersion) {
    const buttons = $$('[data-favorite]');
    if (!buttons.length) return;
    buttons.forEach((button) => { button.disabled = true; });
    if (!state.user) { buttons.forEach((button) => { button.disabled = false; }); return; }
    try {
      const data = await api('/favorites');
      if (version !== state.routeVersion) return;
      const ids = new Set(data.items.map((item) => item.id));
      buttons.forEach((button) => {
        const active = ids.has(button.dataset.favorite);
        button.classList.toggle('is-favorite', active);
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', active ? 'حذف از نشان‌شده‌ها' : 'افزودن به نشان‌شده‌ها');
        button.disabled = false;
      });
    } catch (error) { if (version === state.routeVersion) toast('دریافت وضعیت نشان‌شده‌ها ناموفق بود: ' + apiErrorMessage(error), 'error'); }
  }

  async function toggleFavorite(assetId) {
    if (!state.user) return openAuth(() => toggleFavorite(assetId));
    const buttons = $$('[data-favorite]').filter((button) => button.dataset.favorite === assetId);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const data = await api('/favorites');
      const active = data.items.some((item) => item.id === assetId);
      await api(`/contents/${encodeURIComponent(assetId)}/favorite`, { method: active ? 'DELETE' : 'POST' });
      toast(active ? 'از نشان‌شده‌ها حذف شد.' : 'به نشان‌شده‌ها افزوده شد.', 'success');
      if (routeParts()[0] === 'favorites') await route(); else await refreshFavoriteButtons();
    } catch (error) { toast(apiErrorMessage(error), 'error'); buttons.forEach((button) => { button.disabled = false; }); }
  }

  async function redeemAdvertiserCoupon(form) {
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      const result = await api('/advertiser/coupons/redeem', {
        method: 'POST', body: JSON.stringify({ code: new FormData(form).get('code') }),
      });
      toast(`کد پذیرفته شد؛ ${formatMoney(result.wallet.added, result.wallet.currency)} به کیف پول اضافه شد.`);
      await route();
    } catch (error) {
      toast(error.message || 'اعمال کد ناموفق بود.');
      button.disabled = false;
    }
  }

  async function submitCampaign(form) {
    const button = $('button[type="submit"]', form);
    const values = Object.fromEntries(new FormData(form));
    const placements = new FormData(form).getAll('placements');
    if (!placements.length) { toast('حداقل یک جایگاه انتخاب کنید.', 'error'); return; }
    if (values.landingMode === 'intermediate' && Boolean(values.buttonText) !== Boolean(values.buttonUrl)) {
      toast('برای دکمه تعاملی، عنوان و نشانی را با هم وارد کنید.', 'error');
      return;
    }
    const interactiveButtons = values.buttonText && values.buttonUrl
      ? [{ text: values.buttonText, url: values.buttonUrl }]
      : [];
    delete values.buttonText;
    delete values.buttonUrl;
    const payload = {
      ...values,
      placements,
      startsAt: new Date(values.startsAt).toISOString(),
      endsAt: new Date(values.endsAt).toISOString(),
      telegramButtons: interactiveButtons,
      skipAfterSeconds: placements.includes('pre_roll') ? 5 : 0,
    };
    payload.assetType = values.creativeType === 'video' ? 'video' : 'image';
    delete payload.creativeType;
    if (values.landingMode !== 'intermediate') { payload.telegramPostText = ''; payload.telegramButtons = []; }
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> در حال رزرو بودجه';
    try {
      await api('/advertiser/campaigns', { method: 'POST', body: JSON.stringify(payload) });
      toast('کمپین برای بررسی مالک ارسال شد.', 'success');
      route();
    } catch (error) {
      toast(apiErrorMessage(error), 'error');
      button.disabled = false;
      button.textContent = 'رزرو بودجه و ارسال برای بررسی';
    }
  }

  document.addEventListener('click', async (event) => {
    const backTarget = event.target.closest('[data-go-back]');
    if (backTarget) {
      event.preventDefault();
      if (state.routeVisits > 1 && window.history.length > 1) window.history.back(); else navigate('/home');
      return;
    }
    const routeTarget = event.target.closest('[data-route]');
    if (routeTarget) {
      event.preventDefault();
      navigate(routeTarget.dataset.route);
      return;
    }
    if (event.target.closest('[data-modal-close]') || event.target.matches('[data-modal-backdrop]')) {
      closeModal(); return;
    }
    if (event.target.closest('[data-login]')) { openAuth(); return; }
    if (event.target.closest('[data-retry]')) { route(); return; }
    const download = event.target.closest('[data-open-download]');
    if (download) { openDownload(download.dataset.openDownload); return; }
    const option = event.target.closest('[data-download-media]');
    if (option) { beginDownload(option.dataset.downloadMedia); return; }
    const favorite = event.target.closest('[data-favorite]');
    if (favorite) { toggleFavorite(favorite.dataset.favorite); return; }
    const skip = event.target.closest('#skip-ad');
    if (skip && !skip.disabled) {
      recordAdEvent({ id: skip.dataset.adId, session: skip.dataset.adSession }, 'skip');
      showDownloadWarning(skip.dataset.mediaId); return;
    }
    const delivery = event.target.closest('#confirm-delivery');
    if (delivery) { invokeDelivery(delivery.dataset.mediaId); return; }
    const campaignScroll = event.target.closest('[data-scroll-campaign]');
    if (campaignScroll) { $('#new-campaign')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const campaignDelete = event.target.closest('[data-campaign-delete]');
    if (campaignDelete) {
      if (!window.confirm('کمپین و آمار آن برای همیشه حذف شود؟ بودجهٔ مصرف‌نشده به کیف پول برمی‌گردد و سوابق مالی حفظ می‌شود.')) return;
      campaignDelete.disabled = true;
      try {
        await api(`/advertiser/campaigns/${encodeURIComponent(campaignDelete.dataset.campaignDelete)}`, { method:'DELETE' });
        toast('کمپین حذف شد و بودجهٔ مصرف‌نشده بازگردانده شد.', 'success'); route();
      } catch (error) { toast(apiErrorMessage(error), 'error'); campaignDelete.disabled = false; }
      return;
    }
    const campaignToggle = event.target.closest('[data-campaign-status]');
    if (campaignToggle) {
      campaignToggle.disabled = true;
      try {
        await api(`/advertiser/campaigns/${encodeURIComponent(campaignToggle.dataset.campaignId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: campaignToggle.dataset.campaignStatus }),
        });
        toast('وضعیت کمپین به‌روزرسانی شد.', 'success');
        route();
      } catch (error) {
        toast(apiErrorMessage(error), 'error');
        campaignToggle.disabled = false;
      }
      return;
    }
    const adClick = event.target.closest('[data-ad-click]');
    if (adClick) recordAdEvent({ id: adClick.dataset.adClick, session: adClick.dataset.adSession }, 'click');
    if (event.target.closest('#logout-user')) {
      state.token = ''; state.user = null; localStorage.removeItem(storageKey); updateAccountUI(); toast('از حساب خارج شدید.', 'success'); route();
    }
  });

  document.addEventListener('dblclick', (event) => {
    if (!state.player || !event.target.closest('#player-shell') || event.target.closest('a, button, input, select, #pause-ad-slot')) return;
    const rect = state.player.shell.getBoundingClientRect();
    const forward = event.clientX < rect.left + rect.width / 2; // RTL visual: left is forward.
    state.player.video.currentTime = Math.max(0, Math.min(state.player.video.duration || Infinity, state.player.video.currentTime + (forward ? 10 : -10)));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modalRoot.children.length) closeModal();
    const card = event.target.closest('.media-card, .resume-card');
    if (card && ['Enter', ' '].includes(event.key)) { event.preventDefault(); navigate(card.dataset.route); }
  });

  document.addEventListener('input', (event) => {
    if (event.target.matches('#campaign-form [name=bidMultiplier]')) $('[data-bid-value]', event.target.form).textContent = `${formatNumber(Number(event.target.value))}×`;
    if (event.target.id !== 'search-input') return;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      const activeType = $('[data-search-type].active')?.dataset.searchType || '';
      runSearch(activeType, event.target.value);
    }, 320);
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-game-start], [data-game-next]')) { nextGameRound(); return; }
    const answer = event.target.closest('[data-game-answer]');
    if (answer) { answerGame(Number(answer.dataset.gameAnswer)); return; }
    if (event.target.closest('[data-filter-reset]')) {
      $$('[data-catalog-filter]').forEach((input) => { if (input.type === 'checkbox') input.checked = false; else input.value = input.id === 'search-sort' ? 'recent' : ''; });
      $$('[data-search-type]').forEach((chip) => chip.classList.toggle('active', !chip.dataset.searchType));
      $$('[data-search-genre]').forEach((chip) => chip.classList.toggle('active', !chip.dataset.searchGenre));
      runSearch('', $('#search-input')?.value || ''); return;
    }
    const more = event.target.closest('[data-search-more]');
    if (more) { runSearch($('[data-search-type].active')?.dataset.searchType || '', $('#search-input')?.value || '', state.routeVersion, null, Number(more.dataset.searchMore)); return; }
    const filter = event.target.closest('[data-search-type]');
    if (filter) {
      $$('[data-search-type]').forEach((chip) => chip.classList.toggle('active', chip === filter));
      runSearch(filter.dataset.searchType, $('#search-input')?.value || '');
      return;
    }
    const genre = event.target.closest('[data-search-genre]');
    if (genre) {
      $$('[data-search-genre]').forEach((chip) => chip.classList.toggle('active', chip === genre));
      const type = $('[data-search-type].active')?.dataset.searchType || '';
      runSearch(type, $('#search-input')?.value || '', state.routeVersion, genre.dataset.searchGenre);
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.closest('#campaign-form') && event.target.matches('[name=creativeType], [name=landingMode]')) { setCampaignCreativeType(); return; }
    if (!event.target.matches('[data-catalog-filter]')) return;
    const type = $('[data-search-type].active')?.dataset.searchType || '';
    runSearch(type, $('#search-input')?.value || '');
  });

  document.addEventListener('click', (event) => {
    if (!state.player) return;
    const audioOption = event.target.closest('[data-audio-track]');
    if (audioOption) {
      const player = state.player;
      const value = audioOption.dataset.audioTrack;
      player.externalAudio?.pause();
      if (value.startsWith('external-audio-')) {
        const audio = player.externalAudios[Number(value.slice(15))]?.audio;
        if (!audio) return;
        player.externalAudio = audio;
        player.externalAudioEnabled = true;
        player.video.muted = true;
        try { audio.currentTime = player.video.currentTime; } catch { /* wait for metadata */ }
        if (!player.video.paused) audio.play().catch(() => toast('پخش صدای خارجی ممکن نشد.', 'error'));
      } else {
        player.externalAudioEnabled = false;
        player.video.muted = false;
        if (player.video.audioTracks) {
          const selected = value.startsWith('audio-') ? Number(value.slice(6)) : 0;
          for (let index = 0; index < player.video.audioTracks.length; index += 1) player.video.audioTracks[index].enabled = index === selected;
        }
      }
      $('#settings-button')?.click(); $('#settings-button')?.click();
      return;
    }
    const subtitleOption = event.target.closest('[data-subtitle-track]');
    if (subtitleOption) {
      const player = state.player;
      const value = subtitleOption.dataset.subtitleTrack;
      player.selectedSubtitle = value;
      for (let index = 0; index < player.video.textTracks.length; index += 1) player.video.textTracks[index].mode = value === `text-${index}` ? 'hidden' : 'disabled';
      $('#external-subtitle').textContent = '';
      $('#external-subtitle').style.display = 'none';
      $('#settings-button')?.click(); $('#settings-button')?.click();
      return;
    }
    const speed = event.target.closest('[data-speed]');
    if (speed) {
      state.player.video.playbackRate = Number(speed.dataset.speed);
      $('#settings-button')?.click(); $('#settings-button')?.click();
    }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'auth-form') { event.preventDefault(); verifyLogin(event.target); }
    if (event.target.id === 'comment-form') { event.preventDefault(); submitComment(event.target); }
    if (event.target.id === 'campaign-form') { event.preventDefault(); submitCampaign(event.target); }
    if (event.target.id === 'coupon-redemption-form') { event.preventDefault(); redeemAdvertiserCoupon(event.target); }
    if (event.target.id === 'home-search') {
      event.preventDefault();
      const term = String(new FormData(event.target).get('q') || '').trim();
      navigate(term ? `/search?q=${encodeURIComponent(term)}` : '/search');
    }
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('pagehide', () => state.player?.saveProgress?.(true));

  async function initialize() {
    try {
      const tasks = [api('/config')];
      if (state.token) tasks.push(api('/me').catch(() => null));
      const [config, me] = await Promise.all(tasks);
      state.config = config;
      const siteName = 'Vizosten';
      document.title = 'Vizosten | ویزوستن';
      const brand = $('.header-brand-center strong');
      if (brand) brand.textContent = siteName;
      const brandButton = $('.header-brand-center');
      if (brandButton) brandButton.setAttribute('aria-label', `${siteName}، صفحه نخست`);
      if (config.site?.tagline) $('meta[name="description"]')?.setAttribute('content', config.site.tagline);
      if (me?.user) state.user = me.user;
    } catch (error) {
      console.warn('Initial configuration could not be loaded:', error);
    } finally {
      loader?.remove();
      updateAccountUI();
      if (!window.location.hash) window.location.hash = '/home';
      else route();
    }
  }

  initialize();
})();
