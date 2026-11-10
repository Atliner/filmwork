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
    selectedPlacement: 'pre_roll',
    routeVisits: 0,
  };

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
  const byScript = (value, wanted) => String(value || '').split(/[,،؛;|/]+/u)
    .map((part) => part.trim())
    .filter((part) => part && (wanted === 'fa' ? PERSIAN.test(part) : LATIN.test(part)));

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

  /**
   * Crew names arrive as `Persian | English` for the same person. Rendering both
   * scripts side by side keeps the site consistent with the channel post and makes
   * either spelling findable.
   */
  function bilingualNames(values) {
    const list = Array.isArray(values) ? values.flatMap((value) => String(value || '').split(/\s*\|\s*/u)) : [];
    const seen = new Set();
    const fa = [];
    const en = [];
    for (const raw of list) {
      const name = String(raw || '').trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      if (PERSIAN.test(name) && !LATIN.test(name)) fa.push(name);
      else if (LATIN.test(name)) en.push(name);
      else if (name) fa.push(name);
    }
    return { fa, en };
  }

  function namesMarkup(values, { limit = 6 } = {}) {
    const { fa, en } = bilingualNames(values);
    if (!fa.length && !en.length) return 'ثبت نشده';
    const faPart = fa.slice(0, limit).map(escapeHtml).join('، ');
    const enPart = en.slice(0, limit).map(escapeHtml).join('، ');
    if (faPart && enPart) {
      return `<span class="name-pair"><span class="name-fa">${faPart}</span><span class="name-en" dir="ltr" lang="en">${enPart}</span></span>`;
    }
    return faPart
      ? `<span class="name-fa">${faPart}</span>`
      : `<span class="name-en" dir="ltr" lang="en">${enPart}</span>`;
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
    return error?.message || 'ارتباط با سرور برقرار نشد.';
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

  function mediaCard(content) {
    const fa = titleFa(content);
    const en = titleEn(content);
    const label = [fa, en].filter(Boolean).join(' / ');
    return `<article class="media-card" tabindex="0" role="button" data-route="/content/${encodeURIComponent(content.id)}" aria-label="${escapeHtml(label)}">
      ${posterMarkup(content)}
      ${titleMarkup(content, { enClass: 'title-en title-en--card' })}
      <p>${content.releaseYear ? escapeHtml(content.releaseYear) : 'سال نامشخص'}${content.genres?.[0] ? ` · ${escapeHtml(content.genres[0])}` : ''}</p>
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
        <div class="eyebrow">انتخاب ویژه Filmwork</div>
        <h1>${escapeHtml(titleFa(content) || titleEn(content))}</h1>
        ${titleEn(content) && titleEn(content) !== titleFa(content) ? `<p class="hero-en-title" dir="ltr" lang="en">${escapeHtml(titleEn(content))}</p>` : ''}
        <div class="hero-meta">
          ${content.imdbScore !== null ? `<span class="rating"><b>★</b> IMDb ${escapeHtml(content.imdbScore)}</span>` : ''}
          ${content.releaseYear ? `<span class="meta-dot">${escapeHtml(content.releaseYear)}</span>` : ''}
          <span class="meta-dot">${content.type === 'series' ? 'سریال' : 'فیلم سینمایی'}</span>
          ${genres ? `<span class="meta-dot">${genres}</span>` : ''}
        </div>
        ${content.description ? `<p class="hero-description">${escapeHtml(content.description)}</p>` : ''}
        <div class="action-row">
          <button type="button" class="primary-button" data-route="/player/${encodeURIComponent(content.id)}">${icons.play} پخش آنلاین</button>
          <button type="button" class="secondary-button" data-open-download="${escapeHtml(content.id)}">${icons.download} دریافت فایل</button>
          <button type="button" class="icon-button" data-favorite="${escapeHtml(content.id)}" aria-label="افزودن به علاقه‌مندی‌ها">${icons.heart}</button>
        </div>
      </div>
    </section>`;
  }

  async function renderHome(version) {
    setActiveNav('home');
    setHeaderLabel('خانه');
    const [data, progressData] = await Promise.all([
      api('/contents?limit=30'),
      state.user ? api('/progress').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
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
          ${icons.search}<input type="search" name="q" maxlength="100" autocomplete="off" aria-label="جستجو در فیلم‌ورک" placeholder="نام فیلم، سریال، بازیگر یا کارگردان…">
          <button class="primary-button" type="submit">جستجو</button>
        </form>
      </div>
      <div class="page-shell home-category-strip" aria-label="دسته‌بندی‌ها">
        <button class="chip active" data-route="/home">منتخب</button>
        <button class="chip" data-route="/search?genre=درام">درام</button>
        <button class="chip" data-route="/search?genre=علمی تخیلی">علمی‌تخیلی</button>
        <button class="chip" data-route="/search?genre=اکشن">اکشن</button>
        <button class="chip" data-route="/search?genre=کمدی">کمدی</button>
      </div>
      ${heroMarkup(hero)}
      <div class="page-shell">
        ${continueItems.length ? `<section class="content-section resume-section"><div class="section-head"><div><h2>ادامه تماشا</h2><p>از همان‌جایی که رها کردید</p></div></div><div class="resume-scroller">${continueItems.map(continueCard).join('')}</div></section>` : ''}
        <section class="content-section">
          <div class="section-head"><div><h2>تازه‌های فیلم‌ورک</h2><p>جدیدترین فیلم‌ها و سریال‌های اضافه‌شده</p></div><button class="text-button" data-route="/search">مشاهده همه</button></div>
          <div class="media-scroller">${latest.length ? latest.map(mediaCard).join('') : mediaCard(hero)}</div>
        </section>
        ${topRated.length ? `<section class="content-section"><div class="section-head"><div><h2>بالاترین امتیاز</h2><p>انتخاب‌ها بر اساس امتیاز IMDb</p></div></div><div class="media-scroller">${topRated.map(mediaCard).join('')}</div></section>` : ''}
      </div>`;
  }

  async function renderSearch(version, initialQuery = '', initialGenre = '') {
    setActiveNav('search');
    setHeaderLabel('جستجو');
    const genres = ['اکشن', 'درام', 'کمدی', 'جنایی', 'علمی تخیلی', 'انیمیشن'];
    app.innerHTML = `<div class="page-shell page-top search-page">
      <div class="section-head search-title"><div><h1 class="page-title">جستجو</h1><p>در میان فیلم‌ها و سریال‌های فیلم‌ورک</p></div></div>
      <label class="search-box">${icons.search}<input id="search-input" type="search" maxlength="100" autocomplete="off" placeholder="نام فارسی یا انگلیسی فیلم، سریال، بازیگر یا کارگردان…" value="${escapeHtml(initialQuery)}"><span class="sr-only">جستجو</span></label>
      <p class="search-hint">هر دو زبان جستجو می‌شود: «پیت» و «The Pitt» هر دو همین اثر را پیدا می‌کنند؛ نام بازیگران و کارگردانان هم در فهرست نتایج می‌آید.</p>
      <section class="search-discovery"><h2>ژانرهای محبوب</h2><div class="genre-chip-row">
        <button class="genre-chip ${initialGenre ? '' : 'active'}" data-search-genre="">همه</button>
        ${genres.map((genre) => `<button class="genre-chip ${initialGenre === genre ? 'active' : ''}" data-search-genre="${escapeHtml(genre)}">${escapeHtml(genre)}</button>`).join('')}
      </div></section>
      <div class="search-toolbar">
        <div class="chip-row" aria-label="فیلتر نوع"><button class="chip active" data-search-type="">همه آثار</button><button class="chip" data-search-type="movie">فیلم</button><button class="chip" data-search-type="series">سریال</button></div>
        <div class="search-selects">
          <label><span>سال</span><select id="search-year"><option value="">همه</option><option value="2020">۲۰۲۰ به بعد</option><option value="2010">۲۰۱۰ به بعد</option><option value="2000">۲۰۰۰ به بعد</option></select></label>
          <label><span>امتیاز</span><select id="search-rating"><option value="">همه</option><option value="8">۸ به بالا</option><option value="7">۷ به بالا</option><option value="6">۶ به بالا</option></select></label>
        </div>
      </div>
      <div class="search-status" id="search-status">در حال دریافت کتابخانه…</div>
      <div class="media-grid" id="search-results"></div>
    </div>`;
    const input = $('#search-input');
    input?.focus({ preventScroll: true });
    await runSearch('', initialQuery, version, initialGenre);
  }

  async function runSearch(type = '', queryText = '', version = state.routeVersion, genre = null) {
    const status = $('#search-status');
    const results = $('#search-results');
    if (!status || !results) return;
    status.textContent = 'در حال جستجو…';
    try {
      const params = new URLSearchParams({ limit: '48' });
      const selectedGenre = genre === null ? ($('[data-search-genre].active')?.dataset.searchGenre || '') : genre;
      const yearFrom = $('#search-year')?.value || '';
      const minRating = $('#search-rating')?.value || '';
      if (type) params.set('type', type);
      if (queryText.trim()) params.set('q', queryText.trim());
      if (selectedGenre) params.set('genre', selectedGenre);
      if (yearFrom) params.set('yearFrom', yearFrom);
      if (minRating) params.set('minRating', minRating);
      const data = await api(`/contents?${params}`);
      if (version !== state.routeVersion || !$('#search-results')) return;
      status.textContent = `${formatNumber(data.pagination.total)} نتیجه`;
      results.innerHTML = data.items.length
        ? data.items.map(mediaCard).join('')
        : `<div style="grid-column:1/-1">${emptyState('نتیجه‌ای پیدا نشد', 'عبارت دیگری را امتحان کنید؛ جستجو عنوان فارسی، عنوان انگلیسی، بازیگران، کارگردانان و ژانرها را هم می‌گردد.')}</div>`;
    } catch (error) {
      status.textContent = apiErrorMessage(error);
      results.innerHTML = '';
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
      ['سال انتشار', content.releaseYear ? `${content.releaseYear}${content.lastAirYear ? ` – ${content.lastAirYear}` : ''}` : 'نامشخص'],
      ['امتیاز IMDb', content.imdbScore ?? 'ثبت نشده'],
      ['ژانر', (content.genres || []).join('، ') || 'ثبت نشده'],
      ['کارگردان', namesMarkup(content.directors, { limit: 4 })],
      ['بازیگران', namesMarkup(content.cast, { limit: 8 })],
      ['کشور', (content.countries || []).map(escapeHtml).join('، ') || 'ثبت نشده'],
      ['شبکه', content.network ? escapeHtml(content.network) : 'ثبت نشده'],
      ['رده سنی', content.ageRating ? escapeHtml(content.ageRating) : 'ثبت نشده'],
      ['تعداد نسخه‌ها', formatNumber(media.length)],
    ];
    app.innerHTML = `<section class="detail-hero">
      ${backdrop ? `<img class="detail-backdrop" src="${backdrop}" alt="">` : '<div class="hero-placeholder"></div>'}<div class="detail-overlay"></div>
      <div class="page-shell detail-content">
        ${poster ? `<img class="detail-poster" src="${poster}" alt="پوستر ${escapeHtml(titleFa(content) || titleEn(content))}">` : `<div class="detail-poster poster-frame"><span class="poster-letter">${escapeHtml(firstLetter(titleFa(content) || titleEn(content)))}</span></div>`}
        <div class="detail-copy"><div class="eyebrow">${content.type === 'series' ? 'سریال' : 'فیلم سینمایی'}</div><h1>${escapeHtml(titleFa(content) || titleEn(content))}</h1>
          ${titleEn(content) && titleEn(content) !== titleFa(content) ? `<p class="detail-en-title" dir="ltr" lang="en">${escapeHtml(titleEn(content))}</p>` : ''}
          <div class="meta-row">${content.imdbScore !== null ? `<span class="rating"><b>★</b> IMDb ${escapeHtml(content.imdbScore)}</span>` : ''}${content.releaseYear ? `<span class="meta-dot">${escapeHtml(content.releaseYear)}${content.lastAirYear ? `–${escapeHtml(content.lastAirYear)}` : ''}</span>` : ''}${content.runtimeMinutes ? `<span class="meta-dot">${formatNumber(content.runtimeMinutes)} دقیقه</span>` : ''}${content.seriesRunning && content.currentSeason ? `<span class="meta-dot status-live">فصل ${formatNumber(content.currentSeason)} در حال پخش</span>` : ''}</div>
          ${(content.directors?.length || content.cast?.length) ? `<div class="credit-line"><span>کارگردان</span> ${namesMarkup(content.directors, { limit: 3 })}</div>` : ''}
          ${content.cast?.length ? `<div class="credit-line"><span>بازیگران</span> ${namesMarkup(content.cast, { limit: 5 })}</div>` : ''}
          ${content.description ? `<p class="description">${escapeHtml(content.description)}</p>` : ''}
          <div class="action-row"><button class="primary-button" data-route="/player/${encodeURIComponent(content.id)}">${icons.play} پخش آنلاین</button><button class="secondary-button" data-open-download="${escapeHtml(content.id)}">${icons.download} انتخاب نسخه</button><button class="icon-button" data-favorite="${escapeHtml(content.id)}" aria-label="علاقه‌مندی">${icons.heart}</button></div>
        </div>
      </div>
    </section>
    <div class="page-shell detail-layout">
      <section class="surface-panel"><h2>دیدگاه تماشاگران</h2>
        ${state.user ? '<form class="comment-form" id="comment-form"><input name="body" maxlength="1200" required placeholder="دیدگاه خود را بنویسید…"><button class="primary-button" type="submit">ارسال</button></form>' : '<button class="secondary-button" data-login style="margin-bottom:16px">برای ثبت دیدگاه وارد شوید</button>'}
        <div class="comments" id="comments-list">${commentsMarkup(comments)}</div>
      </section>
      <aside class="surface-panel"><h2>اطلاعات اثر</h2><div class="fact-list">${facts.map(([label, value]) => `<div class="fact"><span>${escapeHtml(label)}</span><div class="fact-value">${String(value).startsWith('<span') ? value : escapeHtml(value)}</div></div>`).join('')}</div></aside>
    </div>`;
  }

  function playerControlMarkup() {
    return `<div class="subtitle-overlay" id="external-subtitle" aria-live="off"></div>
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
      <div class="settings-menu" id="settings-menu"><div class="settings-title">مسیر صدا</div><div id="audio-options"></div><div class="settings-title">زیرنویس</div><div id="subtitle-options"></div><div class="settings-title">سرعت</div><div id="speed-options"></div></div>`;
  }

  async function renderPlayer(assetId, version) {
    setActiveNav('');
    setHeaderLabel('پخش و دانلود', true);
    const [contentData, mediaData, progressData] = await Promise.all([
      api(`/contents/${encodeURIComponent(assetId)}`),
      api(`/contents/${encodeURIComponent(assetId)}/media-options`),
      state.user ? api('/progress').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    ]);
    if (version !== state.routeVersion) return;
    const content = contentData.content;
    const resumeEntry = (progressData.items || []).find((entry) => entry.content.id === content.id && !entry.completed);
    const relatedData = content.genres?.[0]
      ? await api(`/contents?limit=9&genre=${encodeURIComponent(content.genres[0])}`).catch(() => ({ items: [] }))
      : { items: [] };
    if (version !== state.routeVersion) return;
    const related = (relatedData.items || []).filter((item) => item.id !== content.id).slice(0, 8);
    const streamUrl = content.streamUrl || mediaData.items.find((item) => item.streamUrl)?.streamUrl || '';
    const safeStream = safeUrl(streamUrl);
    app.innerHTML = `<div class="page-shell player-page">
      <div class="player-shell controls-visible" id="player-shell">
        <video id="video" class="${safeStream ? '' : 'pixelated'}" playsinline preload="metadata" ${safeStream ? `src="${safeStream}"` : ''}></video>
        ${!safeStream ? `<div class="player-unavailable" id="unavailable-overlay">${icons.film}<strong>پخش آنلاین در دسترس نیست - دریافت از تلگرام</strong><span>می‌توانید نشانی مستقیم را وارد کنید یا یکی از نسخه‌ها را دریافت کنید.</span></div>` : ''}
        ${playerControlMarkup()}<div id="pause-ad-slot"></div>
      </div>
      <details class="source-tools">
        <summary>اتصال منبع شخصی، زیرنویس یا صدای دوبله <span>اختیاری</span></summary>
        <div class="player-fields">
          <div class="bind-card"><label><i></i>نشانی مستقیم ویدیو</label><div class="input-bind"><input id="video-url" type="url" inputmode="url" placeholder="https://…/video.mp4" value="${safeStream}"><button type="button" data-bind="video">اتصال</button></div></div>
          <div class="bind-card"><label><i></i>زیرنویس خارجی SRT / VTT</label><div class="input-bind"><input id="subtitle-url" type="url" inputmode="url" placeholder="https://…/subtitle.srt"><button type="button" data-bind="subtitle">اتصال</button></div></div>
          <div class="bind-card"><label><i></i>صدای دوبله خارجی</label><div class="input-bind"><input id="audio-url" type="url" inputmode="url" placeholder="https://…/dubbed.m4a"><button type="button" data-bind="audio">اتصال</button></div></div>
        </div>
      </details>
      <div id="timed-banner-slot"></div>
      <div id="pause-banner-slot" class="banner-slot"></div>
      <section class="player-info">
        <div class="player-info-main"><div class="player-title-row"><div><h1>${escapeHtml(titleFa(content) || titleEn(content))}</h1>${titleEn(content) && titleEn(content) !== titleFa(content) ? `<p class="original-title" dir="ltr" lang="en">${escapeHtml(titleEn(content))}</p>` : ''}</div><button class="icon-button" data-favorite="${escapeHtml(content.id)}" aria-label="نشان کردن">${icons.heart}</button></div>
          <div class="hero-meta">${content.imdbScore !== null ? `<span class="rating"><b>★</b> IMDb ${escapeHtml(content.imdbScore)}</span>` : ''}${content.releaseYear ? `<span class="meta-dot">${escapeHtml(content.releaseYear)}</span>` : ''}<span class="meta-dot">${content.type === 'series' ? 'سریال' : 'فیلم سینمایی'}</span>${content.genres?.length ? `<span class="meta-dot">${content.genres.slice(0, 3).map(escapeHtml).join('، ')}</span>` : ''}</div>
          ${content.description ? `<p class="player-description">${escapeHtml(content.description)}</p>` : ''}
        </div>
        <aside class="offline-card"><div><span class="offline-icon">${icons.download}</span><div><strong>دانلود و تماشای آفلاین</strong><small>${formatNumber(mediaData.items.length)} نسخه آماده ارسال امن با تلگرام</small></div></div><button class="primary-button" data-open-download="${escapeHtml(content.id)}">انتخاب نسخه</button></aside>
      </section>
      ${related.length ? `<section class="content-section"><div class="section-head"><div><h2>شاید بپسندید</h2><p>آثار مشابه در همین ژانر</p></div></div><div class="media-scroller">${related.map(mediaCard).join('')}</div></section>` : ''}
    </div>`;
    initializePlayer(content.id, Number(resumeEntry?.positionSeconds || 0));
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
    return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map((block) => {
      const lines = block.split('\n');
      if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
      const timing = lines.shift()?.match(/(.+?)\s*-->\s*(.+?)(?:\s|$)/);
      if (!timing) return null;
      const start = parseSubtitleTime(timing[1]);
      const end = parseSubtitleTime(timing[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      const cueText = lines.join('\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim();
      return cueText ? { start, end, text: cueText } : null;
    }).filter(Boolean).sort((a, b) => a.start - b.start);
  }

  function destroyPlayer() {
    if (!state.player) return;
    clearTimeout(state.player.bannerTimer);
    clearTimeout(state.player.pauseBannerTimer);
    state.player.saveProgress?.(true);
    state.player.externalAudio?.pause();
    state.player.cleanup.forEach((cleanup) => cleanup());
    state.player = null;
  }

  function initializePlayer(assetId, resumeSeconds = 0) {
    destroyPlayer();
    const video = $('#video');
    const shell = $('#player-shell');
    if (!video || !shell) return;
    const player = {
      video,
      shell,
      externalAudio: null,
      externalAudioEnabled: false,
      externalCues: [],
      externalSubtitlesEnabled: false,
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
    }
    async function togglePlay() {
      try {
        if (video.paused) await video.play(); else video.pause();
      } catch { toast('مرورگر اجازه پخش این نشانی را نداد.', 'error'); }
    }
    function syncExternalAudio(force = false) {
      const audio = player.externalAudio;
      if (!audio || !player.externalAudioEnabled) return;
      if (force || Math.abs(audio.currentTime - video.currentTime) > 0.22) audio.currentTime = video.currentTime;
      audio.playbackRate = video.playbackRate;
    }
    function renderExternalCue() {
      if (!player.externalSubtitlesEnabled || !player.externalCues.length) {
        subtitleOverlay.style.display = 'none';
        subtitleOverlay.textContent = '';
        return;
      }
      const time = video.currentTime;
      let low = 0;
      let high = player.externalCues.length - 1;
      let cue = null;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const candidate = player.externalCues[middle];
        if (time < candidate.start) high = middle - 1;
        else if (time > candidate.end) low = middle + 1;
        else { cue = candidate; break; }
      }
      subtitleOverlay.textContent = cue?.text || '';
      subtitleOverlay.style.display = cue ? 'block' : 'none';
    }
    function saveProgress(force = false) {
      if (!state.user || !Number.isFinite(video.duration) || video.duration <= 0 || video.currentTime < 1) return;
      const now = Date.now();
      if (!force && now - player.lastProgressSave < 15_000) return;
      player.lastProgressSave = now;
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
    }
    function refreshSettings() {
      const audioContainer = $('#audio-options');
      const subtitleContainer = $('#subtitle-options');
      if (!audioContainer || !subtitleContainer) return;
      const audioOptions = [{ id: 'embedded-default', label: 'صدای داخلی پیش‌فرض', active: !player.externalAudioEnabled }];
      if (video.audioTracks) {
        for (let index = 0; index < video.audioTracks.length; index += 1) {
          const track = video.audioTracks[index];
          audioOptions.push({ id: `audio-${index}`, label: track.label || track.language || `مسیر داخلی ${index + 1}`, active: track.enabled && !player.externalAudioEnabled });
        }
      }
      if (player.externalAudio) audioOptions.push({ id: 'external-audio', label: 'صدای دوبله خارجی', active: player.externalAudioEnabled });
      audioContainer.innerHTML = audioOptions.map((option) => `<button type="button" class="setting-option ${option.active ? 'active' : ''}" data-audio-track="${option.id}">${escapeHtml(option.label)}</button>`).join('');

      const subtitleOptions = [{ id: 'off', label: 'خاموش', active: !player.externalSubtitlesEnabled && ![...video.textTracks].some((track) => track.mode === 'showing') }];
      if (player.externalCues.length) subtitleOptions.push({ id: 'external', label: 'زیرنویس خارجی', active: player.externalSubtitlesEnabled });
      for (let index = 0; index < video.textTracks.length; index += 1) {
        const track = video.textTracks[index];
        subtitleOptions.push({ id: `text-${index}`, label: track.label || track.language || `زیرنویس داخلی ${index + 1}`, active: track.mode === 'showing' });
      }
      subtitleContainer.innerHTML = subtitleOptions.map((option) => `<button type="button" class="setting-option ${option.active ? 'active' : ''}" data-subtitle-track="${option.id}">${escapeHtml(option.label)}</button>`).join('');
      $('#speed-options').innerHTML = [0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => `<button type="button" class="setting-option ${video.playbackRate === speed ? 'active' : ''}" data-speed="${speed}">${speed === 1 ? 'عادی' : `${speed}×`}</button>`).join('');
    }

    on(playButton, 'click', togglePlay);
    on(video, 'click', togglePlay);
    on(video, 'play', async () => {
      syncPlayIcon(); showControls();
      if (player.externalAudioEnabled && player.externalAudio) {
        syncExternalAudio(true);
        try { await player.externalAudio.play(); } catch { toast('پخش صدای خارجی ممکن نشد.', 'error'); }
      }
      $('#pause-ad-slot')?.replaceChildren();
    });
    on(video, 'pause', () => {
      syncPlayIcon(); showControls(); player.externalAudio?.pause(); saveProgress(true);
      if (video.currentTime > 1 && !video.ended && !player.pauseAdLoaded) loadPlayerAd('pause_overlay', '#pause-ad-slot', player);
    });
    on(video, 'timeupdate', updateProgress);
    on(video, 'loadedmetadata', () => {
      if (!player.hasAppliedResume && resumeSeconds > 3 && resumeSeconds < video.duration * 0.92) {
        video.currentTime = Math.min(resumeSeconds, Math.max(0, video.duration - 2));
        toast(`پخش از ${formatTime(resumeSeconds)} ادامه پیدا می‌کند.`, 'success');
      }
      player.hasAppliedResume = true;
      updateProgress(); refreshSettings();
    });
    on(video, 'durationchange', updateProgress);
    on(video, 'seeking', () => syncExternalAudio(true));
    on(video, 'ratechange', () => { if (player.externalAudio) player.externalAudio.playbackRate = video.playbackRate; refreshSettings(); });
    on(video, 'ended', () => {
      player.externalAudio?.pause();
      saveProgress(true);
      // Post-roll: the owner's "پس از پخش" slot, if it is switched on.
      if (video.currentTime > 0 && !player.postRollShown) {
        player.postRollShown = true;
        loadPlayerAd('timed_banner', '#timed-banner-slot', player);
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
    on($('#caption-button'), 'click', () => {
      if (player.externalCues.length) {
        player.externalSubtitlesEnabled = !player.externalSubtitlesEnabled;
        [...video.textTracks].forEach((track) => { track.mode = 'disabled'; });
        renderExternalCue(); refreshSettings();
      } else $('#settings-menu').classList.toggle('open');
    });
    on(shell, 'pointermove', showControls);
    on(shell, 'pointerleave', () => { if (!video.paused) shell.classList.remove('controls-visible'); });
    on(shell, 'keydown', (event) => {
      if (['INPUT', 'BUTTON'].includes(event.target.tagName)) return;
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
    player.pauseBannerTimer = setTimeout(() => loadPlayerAd('banner_pause', '#pause-banner-slot', player), 12_000);
  }

  async function bindPlayerSource(type) {
    const player = state.player;
    if (!player) return;
    const input = $(`#${type}-url`);
    let url;
    try {
      const parsed = new URL(input.value.trim(), window.location.origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      url = parsed.toString();
    } catch {
      toast('یک نشانی HTTP یا HTTPS معتبر وارد کنید.', 'error');
      return;
    }
    if (type === 'video') {
      player.video.src = url;
      player.video.classList.remove('pixelated');
      $('#unavailable-overlay')?.remove();
      player.video.load();
      toast('نشانی ویدیو متصل شد.', 'success');
      return;
    }
    if (type === 'audio') {
      player.externalAudio?.pause();
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.volume = Number($('#volume')?.value || 1);
      player.externalAudio = audio;
      player.externalAudioEnabled = true;
      player.video.muted = true;
      audio.currentTime = player.video.currentTime;
      if (!player.video.paused) audio.play().catch(() => {});
      $('#settings-button')?.click();
      toast('صدای دوبله خارجی فعال شد.', 'success');
      return;
    }
    try {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const cues = parseSrt(text);
      if (!cues.length) throw new Error('هیچ بازه زمانی معتبری پیدا نشد');
      player.externalCues = cues;
      player.externalSubtitlesEnabled = true;
      [...player.video.textTracks].forEach((track) => { track.mode = 'disabled'; });
      toast(`${formatNumber(cues.length)} خط زیرنویس بارگذاری شد.`, 'success');
      $('#settings-button')?.click();
    } catch (error) {
      toast(`زیرنویس بارگذاری نشد؛ سرور فایل باید CORS را مجاز کند. ${error.message}`, 'error');
    }
  }

  async function loadPlayerAd(placement, selector, player) {
    if (placement === 'pause_overlay') player.pauseAdLoaded = true;
    try {
      const { ad } = await api(`/ads/serve?placement=${placement}`);
      if (!ad || state.player !== player) return;
      const host = $(selector);
      if (!host) return;
      // The owner sets how many seconds a creative stays on screen.
      document.documentElement.style.setProperty(`--ad-duration-${placement}`, `${Number(ad.durationSeconds || 8)}s`);
      if (ad.durationSeconds) {
        setTimeout(() => {
          if (state.player === player) host.replaceChildren();
        }, Number(ad.durationSeconds) * 1000);
      }
      const media = ad.assetType === 'video'
        ? `<video src="${safeUrl(ad.creativeUrl)}" muted autoplay playsinline loop></video>`
        : `<img src="${safeUrl(ad.creativeUrl)}" alt="${escapeHtml(ad.headline)}">`;
      host.innerHTML = placement === 'pause_overlay'
        ? `<a class="pause-ad-card" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}"><span>تبلیغ</span>${media}<strong>${escapeHtml(ad.headline)}</strong></a>`
        : `<a class="timed-banner" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}">${media}<div><small>پیشنهاد ویژه</small><strong>${escapeHtml(ad.headline)}</strong><p>${escapeHtml(ad.body || '')}</p></div><b>مشاهده</b></a>`;
      recordAdEvent(ad, 'impression');
    } catch {
      // Ad inventory must never interrupt playback.
    }
  }

  function roleSwitcher(active = 'user') {
    return `<nav class="role-switcher" aria-label="انتخاب محیط">
      <button class="${active === 'user' ? 'active' : ''}" data-route="/profile">کاربر</button>
      ${state.user?.role === 'advertiser' ? `<button class="${active === 'advertiser' ? 'active' : ''}" data-route="/advertiser">تبلیغ‌دهنده</button>` : ''}
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
        <div><h1>${escapeHtml(state.user.accountName)}</h1><p>${state.user.role === 'advertiser' ? 'عضو و تبلیغ‌دهنده فیلم‌ورک' : 'عضو فیلم‌ورک'} · از ${formatDate(state.user.createdAt)}</p></div>
      </section>
      <section class="account-stats" aria-label="آمار حساب">
        <div><strong>${formatNumber(watchedHours)}</strong><span>ساعت تماشا</span></div>
        <div><strong>${formatNumber(stats.completed)}</strong><span>اثر کامل‌شده</span></div>
        <div><strong>${formatNumber(stats.favorites)}</strong><span>نشان‌شده</span></div>
      </section>
      ${progress.length ? `<section class="content-section account-progress"><div class="section-head"><div><h2>ادامه تماشا</h2><p>آخرین فعالیت پخش شما</p></div><button class="text-button" data-route="/home">مشاهده همه</button></div><div class="resume-scroller">${progress.map(continueCard).join('')}</div></section>` : ''}
      <div class="account-groups">
        <section><h2>کتابخانه من</h2><div class="menu-list surface-panel">
          <button class="menu-row" data-route="/favorites"><div><span class="menu-icon">♡</span><span>نشان‌شده‌ها</span></div><small>${formatNumber(stats.favorites)} ←</small></button>
          <button class="menu-row" data-route="/downloads"><div><span class="menu-icon">↓</span><span>تاریخچه دانلود</span></div><small>${formatNumber(stats.downloads)} ←</small></button>
          <button class="menu-row" data-route="/search"><div>${icons.search}<span>کشف آثار تازه</span></div><small>جستجو ←</small></button>
        </div></section>
        <section><h2>حساب و دسترسی</h2><div class="menu-list surface-panel">
          ${state.user.role === 'advertiser' ? `<button class="menu-row" data-route="/advertiser"><div>${icons.megaphone}<span>مرکز تبلیغ‌دهندگان</span></div><small>ورود ←</small></button>` : ''}
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
    if (state.user.role !== 'advertiser') {
      app.innerHTML = `<div class="page-shell page-top">${emptyState('حساب تبلیغ‌دهنده فعال نیست', 'فعال‌سازی نقش تبلیغ‌دهنده و شارژ اولیه کیف پول توسط مالک سامانه انجام می‌شود.')}</div>`;
      return;
    }
    const data = await api('/advertiser/profile');
    if (version !== state.routeVersion) return;
    const prices = state.config.placementPrices || [];
    if (!prices.some((price) => price.placement === state.selectedPlacement)) state.selectedPlacement = prices[0]?.placement || 'pre_roll';
    const priceCards = prices.map((price) => `<button class="price-card ${state.selectedPlacement === price.placement ? 'selected' : ''}" type="button" data-placement="${price.placement}"><strong>${escapeHtml(price.label)}</strong><span>${formatMoney(price.cpm, price.currency)} / هزار نمایش</span></button>`).join('');
    const statusLabels = { active: 'فعال', paused: 'متوقف', pending: 'در بررسی', rejected: 'ردشده', completed: 'پایان‌یافته', cancelled: 'لغوشده' };
    const campaigns = data.campaigns.length ? data.campaigns.map((campaign) => {
      const percent = campaign.budget > 0 ? Math.min(100, (campaign.spent / campaign.budget) * 100) : 0;
      return `<article class="campaign-card">
        <div class="campaign-creative">${campaign.creativeUrl ? (campaign.assetType === 'video' ? `<video src="${safeUrl(campaign.creativeUrl)}" muted preload="metadata"></video>` : `<img src="${safeUrl(campaign.creativeUrl)}" alt="">`) : '<span>AD</span>'}<i class="status-dot status-${escapeHtml(campaign.status)}"></i></div>
        <div class="campaign-main"><div class="campaign-title"><div><h3>${escapeHtml(campaign.name)}</h3><p>${escapeHtml(campaign.headline)}</p></div><span class="status-pill status-${escapeHtml(campaign.status)}">${escapeHtml(statusLabels[campaign.status] || campaign.status)}</span></div>
          <div class="campaign-metrics"><span><b>${formatNumber(campaign.impressions)}</b> نمایش</span><span><b>${formatNumber(campaign.clicks)}</b> کلیک</span><span><b>${formatMoney(campaign.spent)}</b> هزینه</span></div>
          <div class="budget-progress"><i><b style="width:${percent.toFixed(1)}%"></b></i><small>${formatNumber(percent.toFixed(0))}٪ بودجه · تا ${formatDate(campaign.endsAt)}</small></div>
        </div>
        ${['active', 'paused'].includes(campaign.status) ? `<button type="button" class="campaign-toggle" data-campaign-status="${campaign.status === 'active' ? 'paused' : 'active'}" data-campaign-id="${escapeHtml(campaign.id)}">${campaign.status === 'active' ? 'توقف' : 'ادامه'}</button>` : ''}
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
        <section class="surface-panel wallet-card"><span class="wallet-label">موجودی قابل استفاده</span><strong class="wallet-balance">${formatMoney(data.wallet.balance, data.wallet.currency)}</strong><span class="wallet-currency">کیف پول امن کمپین‌ها</span></section>
        <section class="surface-panel"><h2>نقشه تعاملی جایگاه‌ها</h2><div class="placement-map"><div class="mock-player">نمای پلیر<button type="button" class="zone zone-pre ${state.selectedPlacement === 'pre_roll' ? 'selected' : ''}" data-placement="pre_roll">Pre-roll</button><button type="button" class="zone zone-pause ${state.selectedPlacement === 'pause_overlay' ? 'selected' : ''}" data-placement="pause_overlay">Pause overlay</button></div><button type="button" class="zone zone-banner ${state.selectedPlacement === 'timed_banner' ? 'selected' : ''}" data-placement="timed_banner">Timed banner below player</button></div><div class="price-cards">${priceCards}</div></section>
      </div>
      <div class="hub-layout">
        <section class="surface-panel campaigns-panel"><h2>کمپین‌های من</h2><div class="campaign-list">${campaigns}</div></section>
        <section class="surface-panel" id="new-campaign"><h2>ساخت کمپین</h2><form id="campaign-form">
          <input type="hidden" name="placement" value="${escapeHtml(state.selectedPlacement)}">
          <label class="form-field"><span>نام داخلی کمپین</span><input class="form-input" name="campaignName" minlength="3" maxlength="180" required></label>
          <label class="form-field"><span>عنوان قابل نمایش</span><input class="form-input" name="headline" minlength="3" maxlength="180" required></label>
          <label class="form-field"><span>توضیح کوتاه</span><textarea class="form-textarea" name="body" maxlength="1000"></textarea></label>
          <div class="form-grid"><label class="form-field"><span>نوع خلاقه</span><select class="form-select" name="assetType"><option value="video">ویدیو</option><option value="image">تصویر</option></select></label><label class="form-field"><span>بودجه (ریال)</span><input class="form-input" name="budget" type="number" min="1" required></label></div>
          <label class="form-field"><span>نشانی HTTPS فایل تبلیغ</span><input class="form-input" name="creativeUrl" type="url" inputmode="url" required placeholder="https://cdn.example.com/ad.mp4"></label>
          <label class="form-field"><span>نشانی مقصد</span><input class="form-input" name="targetUrl" type="url" inputmode="url" placeholder="https://…"></label>
          <div class="form-grid"><label class="form-field"><span>شروع</span><input class="form-input" name="startsAt" type="datetime-local" required></label><label class="form-field"><span>پایان</span><input class="form-input" name="endsAt" type="datetime-local" required></label></div>
          <label class="form-field"><span>متن صفحه واسط بدون فیلتر</span><textarea class="form-textarea" name="telegramPostText" maxlength="5000"></textarea></label>
          <div class="form-grid"><label class="form-field"><span>عنوان دکمه تعاملی</span><input class="form-input" name="buttonText" maxlength="60" placeholder="مشاهده پیشنهاد"></label><label class="form-field"><span>نشانی دکمه</span><input class="form-input" name="buttonUrl" type="url" inputmode="url" placeholder="https://…"></label></div>
          <button class="primary-button" type="submit" style="width:100%">رزرو بودجه و ارسال برای بررسی</button>
        </form></section>
      </div>
    </div>`;
    setCampaignDateDefaults();
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
    destroyPlayer();
    window.scrollTo({ top: 0, behavior: 'instant' });
    const parts = routeParts();
    const hashQuery = new URLSearchParams((window.location.hash.split('?')[1] || '').split('#')[0]);
    pageLoading();
    try {
      if (parts[0] === 'home' || !parts[0]) await renderHome(version);
      else if (parts[0] === 'search') await renderSearch(version, hashQuery.get('q') || '', hashQuery.get('genre') || '');
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
      const renderVersions = (resolutions) => [...resolutions.entries()].map(([resolution, items]) => `<div class="resolution-label">${escapeHtml(resolution)}</div>${items.map((item) => `<button class="download-option" type="button" data-download-media="${escapeHtml(item.id)}"><span><strong>${item.episode ? `قسمت ${formatNumber(item.episode)} · ` : ''}${escapeHtml(item.version)}${item.encoder ? ` · ${escapeHtml(item.encoder)}` : ''}</strong><span>${escapeHtml(item.quality || item.subtitleType)}${item.episodeTitle ? ` · ${escapeHtml(item.episodeTitle)}` : ''}</span></span><b>${formatBytes(item.fileSizeBytes)}</b></button>`).join('')}`).join('');
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
      const { ad } = await api('/ads/serve?placement=pre_roll');
      if (!ad) {
        showDownloadWarning(mediaId);
        return;
      }
      showPreRoll(ad, mediaId);
    } catch {
      showDownloadWarning(mediaId);
    }
  }

  function recordAdEvent(ad, eventType) {
    if (!ad?.id || !ad?.session) return;
    api(`/ads/${encodeURIComponent(ad.id)}/events`, {
      method: 'POST',
      headers: { 'X-Ad-Session': ad.session },
      body: JSON.stringify({ eventType, session: ad.session }),
    }).catch(() => {});
  }

  function showPreRoll(ad, mediaId) {
    const media = ad.assetType === 'video'
      ? `<video id="preroll-video" src="${safeUrl(ad.creativeUrl)}" autoplay playsinline muted></video>`
      : `<img src="${safeUrl(ad.creativeUrl)}" alt="${escapeHtml(ad.headline)}">`;
    let seconds = Math.max(0, Number(ad.skipAfterSeconds || 0));
    openModal(`${modalHeader('پیام حامی Filmwork')}<div class="ad-stage"><span class="ad-label">تبلیغ</span>${media}<button class="ad-skip" id="skip-ad" type="button" ${seconds ? 'disabled' : ''}>${seconds ? `رد کردن · ${formatNumber(seconds)}` : 'رد کردن تبلیغ'}</button></div><div class="ad-copy"><h3>${escapeHtml(ad.headline)}</h3><p>${escapeHtml(ad.body || '')}</p><a class="text-button" href="${escapeHtml(ad.tunnelUrl)}" target="_blank" rel="noopener" data-ad-click="${escapeHtml(ad.id)}" data-ad-session="${escapeHtml(ad.session)}">مشاهده جزئیات در صفحه بدون فیلتر</a></div>`, { locked: true });
    recordAdEvent(ad, 'impression');
    const skip = $('#skip-ad');
    skip.dataset.mediaId = mediaId;
    skip.dataset.adId = ad.id;
    skip.dataset.adSession = ad.session;
    const video = $('#preroll-video');
    if (video) {
      video.muted = false;
      video.addEventListener('ended', () => { recordAdEvent(ad, 'complete'); showDownloadWarning(mediaId); }, { once: true });
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

  function showDownloadWarning(mediaId) {
    openModal(`${modalHeader('ارسال فایل به تلگرام')}<div class="warning-box">کاربر گرامی، برای دریافت فایل حتما فیلترشکن یا پروکسی تلگرام خود را روشن کنید</div><p style="color:#a1a1aa;font-size:11px;line-height:1.9;margin:13px 4px">سامانه ابتدا نسخه اصلی را بررسی می‌کند و اگر حذف شده باشد، بدون وقفه نسخه پشتیبان را جایگزین خواهد کرد.</p><button class="primary-button" id="confirm-delivery" data-media-id="${escapeHtml(mediaId)}" type="button" style="width:100%">تأیید و ارسال در ربات</button>`);
  }

  async function invokeDelivery(mediaId) {
    const button = $('#confirm-delivery');
    if (button) { button.disabled = true; button.innerHTML = '<span class="spinner"></span> در حال بررسی سه نسخه'; }
    try {
      const result = await api('/download', { method: 'POST', body: JSON.stringify({ mediaId }) });
      const link = safeUrl(result.telegramLink);
      openModal(`${modalHeader('فایل ارسال شد')}<div class="empty-state"><div class="empty-icon" style="color:#86efac">✓</div><h2>تلگرام خود را بررسی کنید</h2><p>${escapeHtml(result.message)}${result.subtitleDelivered ? ' زیرنویس مجزا نیز پس از ویدیو ارسال شد.' : ''}</p>${link ? `<a class="primary-button" style="margin-top:18px" href="${link}" target="_blank" rel="noopener">باز کردن در تلگرام</a>` : ''}</div>`);
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

  async function toggleFavorite(assetId) {
    if (!state.user) return openAuth(() => toggleFavorite(assetId));
    try {
      await api(`/contents/${encodeURIComponent(assetId)}/favorite`, { method: 'POST' });
      toast('به علاقه‌مندی‌ها افزوده شد.', 'success');
    } catch (error) { toast(apiErrorMessage(error), 'error'); }
  }

  async function submitCampaign(form) {
    const button = $('button[type="submit"]', form);
    const values = Object.fromEntries(new FormData(form));
    if (Boolean(values.buttonText) !== Boolean(values.buttonUrl)) {
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
      startsAt: new Date(values.startsAt).toISOString(),
      endsAt: new Date(values.endsAt).toISOString(),
      telegramButtons: interactiveButtons,
      skipAfterSeconds: values.placement === 'pre_roll' ? 5 : 0,
    };
    if (payload.placement === 'pre_roll') payload.assetType = 'video';
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
    const bind = event.target.closest('[data-bind]');
    if (bind) { bindPlayerSource(bind.dataset.bind); return; }
    const skip = event.target.closest('#skip-ad');
    if (skip && !skip.disabled) {
      recordAdEvent({ id: skip.dataset.adId, session: skip.dataset.adSession }, 'skip');
      showDownloadWarning(skip.dataset.mediaId); return;
    }
    const delivery = event.target.closest('#confirm-delivery');
    if (delivery) { invokeDelivery(delivery.dataset.mediaId); return; }
    const placement = event.target.closest('[data-placement]');
    if (placement && $('#campaign-form')) {
      state.selectedPlacement = placement.dataset.placement;
      const hidden = $('#campaign-form [name="placement"]');
      if (hidden) hidden.value = state.selectedPlacement;
      $$('[data-placement]').forEach((element) => element.classList.toggle('selected', element.dataset.placement === state.selectedPlacement));
      if (state.selectedPlacement === 'pre_roll') $('#campaign-form [name="assetType"]').value = 'video';
      return;
    }
    const campaignScroll = event.target.closest('[data-scroll-campaign]');
    if (campaignScroll) { $('#new-campaign')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
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
    if (!state.player || !event.target.closest('#player-shell')) return;
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
    if (event.target.id !== 'search-input') return;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      const activeType = $('[data-search-type].active')?.dataset.searchType || '';
      runSearch(activeType, event.target.value);
    }, 320);
  });

  document.addEventListener('click', (event) => {
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
    if (!['search-year', 'search-rating'].includes(event.target.id)) return;
    const type = $('[data-search-type].active')?.dataset.searchType || '';
    runSearch(type, $('#search-input')?.value || '');
  });

  document.addEventListener('click', (event) => {
    if (!state.player) return;
    const audioOption = event.target.closest('[data-audio-track]');
    if (audioOption) {
      const value = audioOption.dataset.audioTrack;
      if (value === 'external-audio' && state.player.externalAudio) {
        state.player.externalAudioEnabled = true;
        state.player.video.muted = true;
        state.player.externalAudio.currentTime = state.player.video.currentTime;
        if (!state.player.video.paused) state.player.externalAudio.play().catch(() => {});
      } else {
        state.player.externalAudioEnabled = false;
        state.player.externalAudio?.pause();
        state.player.video.muted = false;
        if (state.player.video.audioTracks) {
          const selected = value.startsWith('audio-') ? Number(value.slice(6)) : -1;
          for (let index = 0; index < state.player.video.audioTracks.length; index += 1) state.player.video.audioTracks[index].enabled = selected < 0 ? index === 0 : index === selected;
        }
      }
      $('#settings-button')?.click(); $('#settings-button')?.click();
      return;
    }
    const subtitleOption = event.target.closest('[data-subtitle-track]');
    if (subtitleOption) {
      const value = subtitleOption.dataset.subtitleTrack;
      state.player.externalSubtitlesEnabled = value === 'external';
      for (let index = 0; index < state.player.video.textTracks.length; index += 1) state.player.video.textTracks[index].mode = value === `text-${index}` ? 'showing' : 'disabled';
      if (!state.player.externalSubtitlesEnabled) { const overlay = $('#external-subtitle'); overlay.style.display = 'none'; overlay.textContent = ''; }
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
