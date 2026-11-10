'use strict';

/*
 * Filmwork owner console.
 *
 * Views: overview (charts + numbers), content library (cards with poster, stats,
 * delete/edit), the new-content wizard (Telegram link/text import → metadata →
 * quality/audio versions → links), users, ads and the bot guide.
 */

(() => {
  const state = {
    csrf: '',
    mode: '',
    view: 'overview',
    counts: { contents: 0, ads: 0 },
    library: { page: 1, q: '', type: '', status: '', sort: 'recent', items: [], pagination: null, loading: false },
    editor: null,
    busy: false,
  };

  /* ------------------------------------------------------------- helpers */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const fa = (value) => String(value ?? '').replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
  const faNum = (value) => fa(Number(value || 0).toLocaleString('en-US'));
  const compact = (value) => {
    const number = Number(value || 0);
    if (number >= 1_000_000) return `${fa((number / 1_000_000).toFixed(1))}M`;
    if (number >= 1000) return `${fa((number / 1000).toFixed(1))}K`;
    return faNum(number);
  };
  const faDate = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(date);
  };
  const faDateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };
  const relative = (value) => {
    if (!value) return '—';
    const diff = Date.now() - new Date(value).getTime();
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return 'همین حالا';
    if (minutes < 60) return `${fa(minutes)} دقیقه پیش`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${fa(hours)} ساعت پیش`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${fa(days)} روز پیش`;
    return faDate(value);
  };
  const listFrom = (value) => String(value || '')
    .split(/[,،؛;|\n]+/u).map((item) => item.trim()).filter(Boolean);
  const debounce = (fn, wait = 320) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  };
  const safeUrl = (value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  };
  const firstLetter = (title) => String(title || '?').trim().charAt(0) || '?';

  const ICONS = {
    movie: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16v13H4zM8 3.5v6m8-6v6M4 10h16"/></svg>',
    series: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 4l4 3 4-3"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6m4-6v6"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.9-5.2 2.9 1-5.9L3.5 9.8l5.9-.8z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6"/><path d="M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/></svg>',
    layers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.4"/><path d="M3.5 20c0-3.2 2.5-5.2 5.5-5.2s5.5 2 5.5 5.2M16.5 5.2A3.4 3.4 0 0 1 17 12M18 14.8c2 .7 3 2.4 3 5.2"/></svg>',
    megaphone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l5 4V6L7 10zM17 9a4 4 0 0 1 0 6"/></svg>',
    server: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9.5h.01"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z"/><path d="M12 10v4m0 3h.01"/></svg>',
    book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5V5.5"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v4H3zM5 10v9h14v-9M10 14h4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/></svg>',
  };

  /* ---------------------------------------------------------------- toast */
  let toastTimer;
  function toast(message, kind = 'success') {
    const element = $('#toast');
    if (!element) return;
    element.textContent = message;
    element.className = `toast is-visible ${kind === 'error' ? 'is-error' : 'is-success'}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.className = 'toast'; }, 3600);
  }

  /* ------------------------------------------------------------------ api */
  async function api(path, options = {}) {
    const headers = { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    const method = options.method || 'GET';
    if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (response.status === 401 || response.status === 404) {
      const data = await response.json().catch(() => ({}));
      if (data?.error?.code === 'NOT_FOUND' || response.status === 401) {
        showSessionEnded(data?.error?.message || 'جلسه شما پایان یافته است.');
        throw new Error(data?.error?.message || 'جلسه پایان یافت.');
      }
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const base = data?.error?.message || `درخواست ناموفق بود (${response.status})`;
      const code = data?.error?.code ? ` · ${data.error.code}` : '';
      const requestId = data?.error?.requestId ? ` · کد پیگیری ${data.error.requestId}` : '';
      const error = new Error(`${base}${code}${requestId}`);
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    return data;
  }

  function showSessionEnded(message) {
    const root = $('#view-root');
    if (!root) return;
    root.innerHTML = `<section class="view"><div class="empty-state">
      <div style="color:var(--amber)">${ICONS.warn}</div>
      <strong>دسترسی پایان یافته است</strong>
      <p>${esc(message)}</p>
      <p>از ربات خصوصی مدیریت دستور <code>/panel</code> را بفرستید تا پیوند تازه دریافت کنید.</p>
    </div></section>`;
  }

  /* -------------------------------------------------------------- overlays */
  function openOverlay(inner, { onClose } = {}) {
    const root = $('#overlay-root');
    root.innerHTML = `<div class="overlay" data-overlay>${inner}</div>`;
    const overlay = $('[data-overlay]', root);
    const close = () => {
      root.innerHTML = '';
      document.body.style.removeProperty('overflow');
      document.removeEventListener('keydown', onKey);
      onClose?.();
    };
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return { root: overlay, close };
  }

  function confirmDialog({ title, message, confirmLabel = 'تأیید', danger = true }) {
    return new Promise((resolve) => {
      const { root, close } = openOverlay(`
        <div class="modal modal--sm" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal__head">
            <div><h2>${esc(title)}</h2></div>
            <button class="icon-button" type="button" data-close aria-label="بستن">${ICONS.close}</button>
          </div>
          <div class="modal__body"><p style="margin:0;color:var(--subdued);font-size:12.5px">${message}</p></div>
          <div class="modal__foot">
            <button class="button button--ghost button--sm" type="button" data-close>بستن</button>
            <button class="button ${danger ? 'button--danger' : 'button--primary'} button--sm" type="button" data-confirm>${esc(confirmLabel)}</button>
          </div>
        </div>`, { onClose: () => resolve(false) });
      $('[data-confirm]', root).addEventListener('click', () => { close(); resolve(true); });
    });
  }

  /* --------------------------------------------------------------- router */
  const VIEWS = {
    overview: renderOverview,
    content: renderLibrary,
    new: () => renderEditor(null),
    edit: (assetId) => renderEditor(assetId),
    users: renderUsers,
    ads: renderAds,
    adsettings: renderAdSettings,
    deploy: renderDeploy,
    guide: renderGuide,
  };

  function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    const [view, param] = hash.split('/');
    return { view: VIEWS[view] ? view : 'overview', param: param ? decodeURIComponent(param) : null };
  }

  function navigate(view, param) {
    const target = `#/${view}${param ? `/${encodeURIComponent(param)}` : ''}`;
    if (location.hash === target) render();
    else location.hash = target;
  }

  function setActiveNav() {
    const view = state.view === 'edit' ? 'content' : state.view;
    $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view));
    $('#sidebar')?.classList.remove('is-open');
    $('#sidebar-scrim')?.setAttribute('hidden', '');
    $('#menu-toggle')?.setAttribute('aria-expanded', 'false');
  }

  async function render() {
    const { view, param } = parseRoute();
    state.view = view;
    setActiveNav();
    const root = $('#view-root');
    if (!root) return;
    try {
      await VIEWS[view](param);
    } catch (error) {
      root.innerHTML = `<section class="view"><div class="empty-state">
        <div style="color:var(--rose,#fda4af)">${ICONS.warn}</div>
        <strong>بارگذاری این بخش ناموفق بود</strong>
        <p>${esc(error.message)}</p>
        <button class="button button--ghost button--sm" type="button" data-retry>تلاش دوباره</button>
      </div></section>`;
      $('[data-retry]', root)?.addEventListener('click', render);
    }
    $('.main')?.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  async function refreshCounts() {
    try {
      const data = await api('/api/admin/stats');
      state.counts.contents = data.overview?.totals?.contents ?? 0;
      state.counts.ads = data.overview?.totals?.pendingAds ?? 0;
      $$('[data-count]').forEach((element) => {
        const value = state.counts[element.dataset.count];
        if (value !== undefined) element.textContent = faNum(value);
      });
      return data;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------- overview */
  async function renderOverview() {
    const root = $('#view-root');
    root.innerHTML = `<section class="view">
      <div class="skeleton skeleton--hero"></div>
      <div class="skeleton-cards"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
    </section>`;
    const data = await api('/api/admin/stats');
    state.mode = data.mode || '';
    const overview = data.overview;
    state.counts.contents = overview.totals.contents;
    state.counts.ads = overview.totals.pendingAds;
    $$('[data-count]').forEach((element) => {
      const value = state.counts[element.dataset.count];
      if (value !== undefined) element.textContent = faNum(value);
    });
    if ($('#mode-pill') && state.mode === 'demo') {
      $('#mode-pill').className = 'pill pill--warn';
      $('#mode-pill').innerHTML = '<i></i> داده نمایشی';
      $('#mode-pill').title = 'حالت DEMO_DATA فعال است؛ داده‌ها در حافظه ذخیره می‌شوند.';
    }

    const maxBar = Math.max(1, ...overview.timeline.map((day) => Math.max(day.contents, day.users)));
    const bars = overview.timeline.map((day) => `
      <div class="bars__col" title="${esc(day.label)} — ${fa(day.contents)} محتوا، ${fa(day.users)} کاربر">
        <div class="bars__stack">
          <div class="bars__bar bars__bar--contents" style="height:${Math.max(3, Math.round((day.contents / maxBar) * 100))}%"></div>
          <div class="bars__bar bars__bar--users" style="height:${Math.max(3, Math.round((day.users / maxBar) * 100))}%"></div>
        </div>
        <span class="bars__label">${esc(day.label)}</span>
      </div>`).join('');

    const statCards = overview.cards.map((card) => `
      <article class="stat-card stat-card--${esc(card.accent)}">
        <div class="stat-card__top"><span>${esc(card.label)}</span><span class="stat-card__icon">${ICONS[cardIcon(card.key)]}</span></div>
        <b>${faNum(card.value)}</b>
        <small>${esc(card.hint)}</small>
      </article>`).join('');

    const genreRows = overview.genres.length ? overview.genres.map((genre) => `
      <div class="split-row">
        <div class="split-row__top"><span>${esc(genre.label)}</span><b>${faNum(genre.value)}</b></div>
        <div class="meter"><i style="width:${Math.max(4, genre.percent)}%"></i></div>
      </div>`).join('') : '<p class="muted" style="font-size:11.5px;color:var(--muted)">ژانری ثبت نشده است.</p>';

    const topRows = overview.topContents.length ? overview.topContents.map((item, index) => `
      <button class="media-row" type="button" data-open-content="${esc(item.id)}">
        <span class="media-row__rank">${fa(index + 1)}</span>
        ${safeUrl(item.posterUrl)
    ? `<img class="media-row__poster" src="${esc(safeUrl(item.posterUrl))}" alt="" loading="lazy">`
    : `<span class="media-row__poster" style="display:grid;place-items:center;font-weight:800;color:#71717a">${esc(firstLetter(item.title))}</span>`}
        <span class="media-row__body">
          <strong>${esc(item.title)}</strong>
          <span>${item.type === 'series' ? 'سریال' : 'فیلم'} · ${faNum(item.views)} بازدید</span>
        </span>
      </button>`).join('') : '<p style="font-size:11.5px;color:var(--muted);margin:0">هنوز بازدیدی ثبت نشده است.</p>';

    const warnings = Array.isArray(data.warnings) ? data.warnings : [];
    const warningPanel = warnings.length ? `
      <div class="callout callout--warn" style="margin-bottom:16px">${ICONS.warn}<span>
        ${esc('این بخش از داشبورد روی سرور شما کامل خوانده نشد')}: ${esc(warnings.map((item) => item.block).join('، '))}.
        <button class="button button--ghost button--xs" type="button" data-diagnostics>بررسی سرور</button>
      </span></div>` : '';

    const resolutionTotal = Math.max(1, overview.resolutions.reduce((sum, row) => sum + row.value, 0));
    const resolutionRows = overview.resolutions.length ? overview.resolutions.map((row) => `
      <div class="split-row">
        <div class="split-row__top"><span style="direction:ltr">${esc(row.label)}</span><b>${faNum(row.value)}</b></div>
        <div class="meter meter--sky"><i style="width:${Math.max(4, Math.round((row.value / resolutionTotal) * 100))}%"></i></div>
      </div>`).join('') : '<p style="font-size:11.5px;color:var(--muted);margin:0">کیفیتی ثبت نشده است.</p>';

    const feedRows = overview.activity.length ? overview.activity.map((item) => `
      <div class="feed__item">
        <span class="feed__dot feed__dot--${esc(item.kind)}"></span>
        <div class="feed__body">
          <strong>${esc(item.title)}</strong>
          ${item.detail ? `<p>${esc(item.detail)}</p>` : ''}
          <span>${relative(item.createdAt)}</span>
        </div>
      </div>`).join('') : '<p style="font-size:11.5px;color:var(--muted);margin:0">رخدادی ثبت نشده است.</p>';

    const weeklyRows = overview.weeklySeries.length ? overview.weeklySeries.map((item) => `
      <div class="media-row" style="cursor:default">
        <span class="tag">فصل ${fa(item.season)}</span>
        <span class="media-row__body"><strong>${esc(item.title)}</strong><span>${esc(item.note || 'در حال پخش')}</span></span>
        <button class="icon-button" type="button" data-edit-content="${esc(item.id)}" aria-label="ویرایش ${esc(item.title)}">${ICONS.edit}</button>
      </div>`).join('') : '<p style="font-size:11.5px;color:var(--muted);margin:0">سریال در حال پخشی وجود ندارد.</p>';

    const healthRows = overview.health.length ? overview.health.map((item) => `
      <div class="feed__item">
        <span class="feed__dot" style="background:#fb7185;box-shadow:0 0 0 4px rgba(251,113,133,.12)"></span>
        <div class="feed__body"><strong>${esc(item.title)}</strong><p>${esc(item.reason)}</p><span>${relative(item.createdAt)}</span></div>
      </div>`).join('') : '<p style="font-size:11.5px;color:var(--muted);margin:0">همه لینک‌ها سالم هستند.</p>';

    root.innerHTML = `<section class="view">
      ${warningPanel}
      <div class="hero-banner">
        <div>
          <h1>سلام مالک 👋</h1>
          <p>${faNum(overview.totals.movies)} فیلم و ${faNum(overview.totals.series)} سریال در کتابخانه ثبت شده است؛
            ${faNum(overview.totals.published)} عنوان منتشر شده و ${faNum(overview.totals.seriesRunning)} سریال در حال پخش است.</p>
          <div class="hero-banner__meta">
            <span class="pill"><i></i> ${faNum(overview.totals.viewsLast7)} بازدید در ۷ روز</span>
            <span class="pill">${faNum(overview.totals.hero)} بنر هیرو فعال</span>
            ${overview.totals.streams ? `<span class="pill pill--warn"><i></i> ${faNum(overview.totals.streams)} لینک ناسالم</span>` : ''}
            ${state.mode === 'demo' ? '<span class="pill pill--warn"><i></i> داده نمایشی</span>' : ''}
          </div>
        </div>
        <div class="hero-banner__actions">
          <button class="button button--primary" type="button" data-new-content>${ICONS.plus} افزودن محتوا</button>
          <button class="button button--ghost" type="button" data-view-nav="content">${ICONS.layers} همه محتوا</button>
        </div>
      </div>

      <div class="stat-grid">${statCards}</div>

      <div class="chart-grid">
        <article class="panel chart-card">
          <div class="chart-card__head">
            <h3>روند ۱۴ روز اخیر</h3>
            <div class="legend">
              <span><i style="background:#a855f7"></i> محتوای جدید</span>
              <span><i style="background:#38bdf8"></i> کاربر جدید</span>
            </div>
          </div>
          <div class="bars">${bars}</div>
        </article>
        <article class="panel chart-card">
          <div class="chart-card__head"><h3>پراکندگی ژانرها</h3><span class="tag">${fa(overview.genres.length)} ژانر</span></div>
          <div class="split-list">${genreRows}</div>
        </article>
      </div>

      <div class="stack-grid">
        <article class="panel">
          <div class="panel__head"><div><h2>پربازدیدترین محتوا</h2><p>بر اساس شمارنده بازدید صفحه اثر</p></div></div>
          <div class="panel__body"><div class="media-list">${topRows}</div></div>
        </article>
        <article class="panel">
          <div class="panel__head"><div><h2>کیفیت‌های موجود</h2><p>توزیع لینک‌های رسانه بر اساس رزولوشن</p></div></div>
          <div class="panel__body"><div class="split-list">${resolutionRows}</div></div>
        </article>
        <article class="panel">
          <div class="panel__head"><div><h2>فعالیت اخیر</h2><p>ثبت، ویرایش و حذف محتوا</p></div></div>
          <div class="panel__body"><div class="feed">${feedRows}</div></div>
        </article>
        <article class="panel">
          <div class="panel__head"><div><h2>سریال‌های در حال پخش</h2><p>وضعیت پخش هفتگی</p></div></div>
          <div class="panel__body"><div class="media-list">${weeklyRows}</div></div>
        </article>
        <article class="panel">
          <div class="panel__head"><div><h2>سلامت فایل‌ها</h2><p>آخرین بازیابی‌های خودکار</p></div></div>
          <div class="panel__body"><div class="feed">${healthRows}</div></div>
        </article>
        <article class="panel">
          <div class="panel__head"><div><h2>خلاصه مالی</h2><p>کمپین‌های تبلیغاتی</p></div></div>
          <div class="panel__body">
            <div class="split-list">
              <div class="split-row"><div class="split-row__top"><span>کمپین فعال</span><b>${faNum(overview.totals.activeAds)}</b></div>
                <div class="meter meter--amber"><i style="width:${Math.min(100, overview.totals.activeAds * 12)}%"></i></div></div>
              <div class="split-row"><div class="split-row__top"><span>در انتظار تأیید</span><b>${faNum(overview.totals.pendingAds)}</b></div>
                <div class="meter meter--amber"><i style="width:${Math.min(100, overview.totals.pendingAds * 20)}%"></i></div></div>
              <div class="split-row"><div class="split-row__top"><span>هزینه مصرف‌شده</span><b>${faNum(overview.totals.adRevenue)} ریال</b></div>
                <div class="meter meter--sky"><i style="width:100%"></i></div></div>
            </div>
          </div>
        </article>
      </div>
    </section>`;
  }

  /** Opens the host self-check: database engine, migrations and failing blocks. */
  async function openDiagnostics() {
    const { root } = openOverlay(`
      <div class="modal" role="dialog" aria-modal="true" aria-label="بررسی سرور">
        <div class="modal__head">
          <div><h2>بررسی سرور</h2><p>وضعیت دیتابیس، جداول و بخش‌های داشبورد</p></div>
          <button class="icon-button" type="button" data-close aria-label="بستن">${ICONS.close}</button>
        </div>
        <div class="modal__body" id="diagnostics-body"><div class="skeleton" style="height:180px"></div></div>
        <div class="modal__foot">
          <button class="button button--ghost button--sm" type="button" data-diagnostics-again>بررسی دوباره</button>
          <button class="button button--sm" type="button" data-close>بستن</button>
        </div>
      </div>`);
    const load = async () => {
      const body = $('#diagnostics-body', root);
      if (!body) return;
      body.innerHTML = '<div class="skeleton" style="height:180px"></div>';
      try {
        const report = await api('/api/admin/diagnostics');
        const rows = (report.checks || []).map((item) => `<div class="check-row ${item.ok ? 'is-ok' : 'is-bad'}">
          <span class="check-row__dot"></span>
          <div><strong>${esc(item.name)}</strong>${item.detail ? `<p>${esc(item.detail)}</p>` : ''}</div>
        </div>`).join('');
        body.innerHTML = `
          <div class="check-summary">
            <span class="pill">حالت: ${report.mode === 'demo' ? 'نمایشی' : 'دیتابیس'}</span>
            ${report.database?.engine ? `<span class="pill">${esc(report.database.engine)} ${esc(report.database.version || '')}</span>` : ''}
            <span class="pill">Node ${esc(report.node || '')}</span>
          </div>
          <div class="check-list">${rows || '<p class="muted">بررسی‌ای انجام نشد.</p>'}</div>
          ${report.database?.error ? `<p class="muted" style="font-size:11.5px">خطای دیتابیس: ${esc(report.database.error)}</p>` : ''}`;
      } catch (error) {
        body.innerHTML = `<p class="muted" style="font-size:12.5px">${esc(error.message)}</p>`;
      }
    };
    root.addEventListener('click', (event) => { if (event.target.closest('[data-diagnostics-again]')) load(); });
    load();
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-diagnostics]')) openDiagnostics();
  });

  function cardIcon(key) {
    return {
      contents: 'movie', published: 'check', views: 'eye', users: 'users', media: 'server', ads: 'megaphone',
    }[key] || 'spark';
  }

  /* -------------------------------------------------------------- library */
  async function renderLibrary() {
    const root = $('#view-root');
    const filters = state.library;
    root.innerHTML = `<section class="view">
      <div class="page-head">
        <div><h1>همه محتوا</h1><p>ردیف‌های کارتی با پوستر، اطلاعات و آمار هر اثر</p></div>
        <div class="page-head__actions">
          <button class="button button--primary" type="button" data-new-content>${ICONS.plus} افزودن محتوا</button>
        </div>
      </div>
      <div class="toolbar">
        <div class="toolbar__search">
          ${ICONS.search}
          <input class="input" type="search" placeholder="جستجوی عنوان فارسی یا انگلیسی…" value="${esc(filters.q)}" data-library-q id="library-q">
        </div>
        <div class="toolbar__group" role="group" aria-label="نوع محتوا">
          ${[['', 'همه'], ['movie', 'فیلم'], ['series', 'سریال']].map(([value, label]) => `
            <button type="button" data-filter-type="${value}" class="${filters.type === value ? 'is-on' : ''}">${label}</button>`).join('')}
        </div>
        <div class="toolbar__group" role="group" aria-label="وضعیت">
          ${[['', 'همه'], ['published', 'منتشر شده'], ['draft', 'پیش‌نویس'], ['archived', 'آرشیو']].map(([value, label]) => `
            <button type="button" data-filter-status="${value}" class="${filters.status === value ? 'is-on' : ''}">${label}</button>`).join('')}
        </div>
        <select class="select" data-library-sort aria-label="ترتیب">
          <option value="recent" ${filters.sort === 'recent' ? 'selected' : ''}>تازه‌ترین</option>
          <option value="views" ${filters.sort === 'views' ? 'selected' : ''}>پربازدیدترین</option>
          <option value="title" ${filters.sort === 'title' ? 'selected' : ''}>الفبایی</option>
        </select>
      </div>
      <div id="library-list" aria-live="polite"></div>
    </section>`;
    await loadLibraryPage();
  }

  function librarySkeleton() {
    return `<div class="content-grid">${Array.from({ length: 4 }, () => '<div class="skeleton" style="height:142px"></div>').join('')}</div>`;
  }

  async function loadLibraryPage() {
    const list = $('#library-list');
    if (!list) return;
    const filters = state.library;
    list.innerHTML = librarySkeleton();
    const params = new URLSearchParams({ page: String(filters.page), limit: '10', sort: filters.sort });
    if (filters.q) params.set('q', filters.q);
    if (filters.type) params.set('type', filters.type);
    if (filters.status) params.set('status', filters.status);
    const data = await api(`/api/admin/contents?${params.toString()}`);
    filters.items = data.items;
    filters.pagination = data.pagination;

    if (!data.items.length) {
      list.innerHTML = `<div class="empty-state">${ICONS.layers}
        <strong>محتوایی با این فیلترها پیدا نشد</strong>
        <p>می‌توانید فیلترها را پاک کنید یا اثر جدیدی اضافه کنید.</p>
        <button class="button button--primary button--sm" type="button" data-new-content>${ICONS.plus} افزودن محتوا</button>
      </div>`;
      return;
    }

    list.innerHTML = `
      <div class="content-grid">${data.items.map(contentCard).join('')}</div>
      ${pagerMarkup(data.pagination)}`;
  }

  function contentCard(item) {
    const poster = safeUrl(item.posterUrl);
    const qualityBadges = (item.qualities || []).slice(0, 4).map((quality) => `<span class="quality-badge">${esc(quality)}</span>`).join('');
    const audioBadges = [
      item.hasDub ? '<span class="quality-badge quality-badge--dub" title="دوبله">دوبله</span>' : '',
      item.hasSub ? '<span class="quality-badge quality-badge--sub" title="زیرنویس">زیرنویس</span>' : '',
    ].join('');
    const meta = [
      item.releaseYear ? `<em>${ICONS.clock} <b>${fa(item.releaseYear)}</b>${item.lastAirYear ? `–${fa(item.lastAirYear)}` : ''}</em>` : '',
      item.imdbScore !== null && item.imdbScore !== undefined ? `<em style="color:#fcd34d">★ <b>${fa(item.imdbScore)}</b></em>` : '',
      item.type === 'series'
        ? `<em>${ICONS.layers} ${item.seasons ? `<b>${fa(item.seasons)}</b> فصل` : 'سریال'}${item.episodes ? ` · <b>${fa(item.episodes)}</b> قسمت` : ''}</em>`
        : item.runtimeMinutes ? `<em>${ICONS.clock} ${fa(item.runtimeMinutes)} دقیقه</em>` : '',
      item.seriesRunning && item.currentSeason ? `<em style="color:#6ee7b7">فصل ${fa(item.currentSeason)} در حال پخش</em>` : '',
      `<em>${ICONS.image} ${faNum(item.mediaCount ?? 0)} لینک</em>`,
    ].filter(Boolean).join('');

    return `<article class="content-card" data-card="${esc(item.id)}">
      <div class="content-card__poster">
        ${poster
    ? `<img src="${esc(poster)}" alt="پوستر ${esc(item.title)}" loading="lazy">`
    : `<span class="poster-fallback">${esc(firstLetter(item.title))}</span>`}
        ${item.featuredHero ? `<span class="content-card__hero-flag">${ICONS.star} هیرو</span>` : ''}
      </div>
      <div class="content-card__main">
        <div class="content-card__title">
          <h3>${esc(item.title)}</h3>
          ${item.originalTitle && item.originalTitle !== item.title ? `<span>${esc(item.originalTitle)}</span>` : ''}
          <span class="status-badge status-badge--${esc(item.status)}">${statusLabel(item.status)}</span>
        </div>
        <div class="content-card__meta">${meta}</div>
        ${(item.directors?.length || item.cast?.length) ? `<div class="content-card__crew">${crewPair(item.directors, 2, 'کارگردان')}${crewPair(item.cast, 3, 'بازیگران')}</div>` : ''}
        <div class="quality-set">${qualityBadges}${audioBadges}</div>
      </div>
      <div class="content-card__views">
        <b>${compact(item.views)}</b>
        <span>بازدید</span>
        <span style="margin-top:2px">${relative(item.createdAt)}</span>
      </div>
      <div class="content-card__actions">
        <button class="icon-button icon-button--hero ${item.featuredHero ? 'is-on' : ''}" type="button"
          data-toggle-hero="${esc(item.id)}" data-hero-state="${item.featuredHero ? '1' : '0'}"
          aria-pressed="${item.featuredHero}" title="${item.featuredHero ? 'حذف از بنر هیرو' : 'افزودن به بنر هیرو'}">${ICONS.star}</button>
        <button class="icon-button" type="button" data-edit-content="${esc(item.id)}" title="ویرایش">${ICONS.edit}</button>
        <button class="icon-button icon-button--danger" type="button" data-delete-content="${esc(item.id)}"
          data-delete-title="${esc(item.title)}" title="حذف">${ICONS.trash}</button>
      </div>
    </article>`;
  }

  /** Splits `Persian names | English names` into a two-line bilingual pair. */
  function namePair(value) {
    const parts = String(value || '').split(/\s*\|\s*/u).map((part) => part.trim()).filter(Boolean);
    const fa = [];
    const en = [];
    for (const part of parts) {
      for (const piece of part.split(/[,،]+/u).map((entry) => entry.trim()).filter(Boolean)) {
        (/[\u0600-\u06FF]/.test(piece) && !/[A-Za-z]/.test(piece) ? fa : en).push(piece);
      }
    }
    return { fa: fa.slice(0, 4), en: en.slice(0, 4) };
  }

  function crewPair(values, limit, label) {
    const list = Array.isArray(values) ? values : String(values || '').split(/[,،]+/u);
    if (!list.length) return '';
    const { fa, en } = namePair(list.join(' | '));
    const short = (items) => items.slice(0, limit).map(esc).join('، ');
    const text = [short(fa), short(en) && `<span dir="ltr">${short(en)}</span>`].filter(Boolean).join(' · ');
    return text ? `<span class="crew-pair"><i>${esc(label)}:</i> ${text}</span>` : '';
  }

  function statusLabel(status) {
    return { published: 'منتشر شده', draft: 'پیش‌نویس', archived: 'آرشیو', pending: 'در انتظار', active: 'فعال', paused: 'متوقف', completed: 'پایان‌یافته', rejected: 'رد شده' }[status] || status;
  }

  function pagerMarkup(pagination) {
    if (!pagination || pagination.pages <= 1) {
      return `<div class="pager"><span>${faNum(pagination?.total || 0)} اثر</span></div>`;
    }
    const pages = [];
    const current = pagination.page;
    for (let page = 1; page <= pagination.pages; page += 1) {
      if (page === 1 || page === pagination.pages || Math.abs(page - current) <= 1) pages.push(page);
      else if (pages[pages.length - 1] !== '…') pages.push('…');
    }
    return `<div class="pager">
      <button type="button" data-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>قبلی</button>
      ${pages.map((page) => (page === '…'
    ? '<span>…</span>'
    : `<button type="button" data-page="${page}" class="${page === current ? 'is-on' : ''}">${fa(page)}</button>`)).join('')}
      <button type="button" data-page="${current + 1}" ${current >= pagination.pages ? 'disabled' : ''}>بعدی</button>
      <span>${faNum(pagination.total)} اثر</span>
    </div>`;
  }

  /* --------------------------------------------------------------- editor */
  const EMPTY_DRAFT = () => ({
    contentType: 'movie',
    titleFa: '',
    titleEn: '',
    description: '',
    releaseYear: '',
    lastAirYear: '',
    seriesRunning: false,
    currentSeason: '',
    broadcastNote: '',
    seasonCount: '',
    episodeCount: '',
    genres: '',
    directors: '',
    cast: '',
    countries: '',
    network: '',
    ageRating: '',
    imdbScore: '',
    runtimeMinutes: '',
    hasDub: true,
    hasSub: true,
    posterUrl: '',
    posterGallery: [],
    backdropUrl: '',
    trailerUrl: '',
    streamUrl: '',
    featuredHero: false,
    status: 'draft',
  });

  function draftFromContent(content, versions) {
    return {
      contentType: content.type,
      titleFa: content.title || '',
      titleEn: content.originalTitle || '',
      description: content.description || '',
      releaseYear: content.releaseYear ?? '',
      lastAirYear: content.lastAirYear ?? '',
      seriesRunning: Boolean(content.seriesRunning),
      currentSeason: content.currentSeason ?? '',
      broadcastNote: content.broadcastNote || '',
      seasonCount: content.seasons ?? '',
      episodeCount: content.episodes ?? '',
      genres: (content.genres || []).join('، '),
      directors: (content.directors || []).join('، '),
      cast: (content.cast || []).join('، '),
      countries: (content.countries || []).join('، '),
      network: content.network || '',
      ageRating: content.ageRating || '',
      imdbScore: content.imdbScore ?? '',
      runtimeMinutes: content.runtimeMinutes ?? '',
      hasDub: Boolean(content.hasDub),
      hasSub: Boolean(content.hasSub),
      posterUrl: content.posterUrl || '',
      posterGallery: content.posterGallery || [],
      backdropUrl: content.backdropUrl || '',
      trailerUrl: content.trailerUrl || '',
      streamUrl: content.streamUrl || '',
      featuredHero: Boolean(content.featuredHero),
      status: content.status,
      versions: (versions || []).map((version) => ({
        kind: version.kind,
        title: version.title,
        resolution: version.resolution || '',
        links: (version.links || []).map((link) => ({
          season: link.season ?? '',
          episode: link.episode ?? '',
          title: link.title || '',
          label: link.label || '',
          sizeText: link.sizeText || '',
          streamUrl: link.streamUrl || '',
          subtitleUrl: link.subtitleUrl || '',
          dubUrl: link.dubUrl || '',
          telegramUrl: link.telegramUrl || '',
        })),
      })),
    };
  }

  async function renderEditor(assetId) {
    const root = $('#view-root');
    if (!assetId) {
      if (!state.editor || state.editor.assetId) {
        state.editor = {
          assetId: null, mode: 'create', step: 1, draft: EMPTY_DRAFT(), versions: [], meta: null,
          sourceText: '', sourceLink: '', qualities: '1080p، 720p، 480p', kind: 'sub',
        };
      }
    } else {
      state.editor = { ...(state.editor || {}), loading: true, assetId, mode: 'edit', step: 2 };
      root.innerHTML = '<section class="view"><div class="skeleton skeleton--hero"></div></section>';
      const data = await api(`/api/admin/contents/${encodeURIComponent(assetId)}`);
      state.editor = {
        assetId,
        mode: 'edit',
        step: 2,
        draft: draftFromContent(data.content, data.versions),
        versions: data.versions.map((version) => ({
          kind: version.kind,
          title: version.title,
          resolution: version.resolution || '',
          links: (version.links || []).map((link) => ({
            season: link.season ?? '', episode: link.episode ?? '', title: link.title || '',
            label: link.label || '', sizeText: link.sizeText || '',
            streamUrl: link.streamUrl || '', subtitleUrl: link.subtitleUrl || '',
            dubUrl: link.dubUrl || '', telegramUrl: link.telegramUrl || '',
          })),
        })),
        meta: null,
        sourceText: '',
        sourceLink: '',
        qualities: (data.content.qualities || ['1080p', '720p']).join('، '),
        kind: 'sub',
        collapsed: {},
      };
    }
    paintEditor();
  }

  function paintEditor() {
    const root = $('#view-root');
    const editor = state.editor;
    if (!editor) { navigate('new'); return; }
    const draft = editor.draft;
    const isCreate = editor.mode === 'create';
    const checklist = [
      { label: 'عنوان فارسی و انگلیسی', done: Boolean(draft.titleFa && draft.titleEn) },
      { label: 'نوع، سال و ژانر', done: Boolean(draft.contentType && draft.releaseYear && draft.genres) },
      { label: 'پوستر', done: Boolean(draft.posterUrl) },
      { label: 'توضیحات', done: Boolean(draft.description) },
      { label: 'حداقل یک نسخه با لینک', done: editor.versions.some((version) => version.links.length > 0) },
      { label: 'انتشار', done: draft.status === 'published' },
    ];

    root.innerHTML = `<section class="view">
      <div class="page-head">
        <div>
          <h1>${isCreate ? 'افزودن محتوای جدید' : `ویرایش ${esc(draft.titleFa || draft.titleEn || 'محتوا')}`}</h1>
          <p>${isCreate
    ? 'لینک پست تلگرام یا متن آن را وارد کنید تا فیلدها خودکار پر شوند، سپس بازبینی و ذخیره کنید.'
    : 'تغییرات را اعمال کنید؛ لینک‌های رسانه و نسخه‌ها هم در همین صفحه به‌روزرسانی می‌شوند.'}</p>
        </div>
        <div class="page-head__actions">
          <button class="button button--ghost button--sm" type="button" data-view-nav="content">بازگشت به فهرست</button>
        </div>
      </div>

      <div class="steps" role="tablist" aria-label="مراحل افزودن محتوا">
        ${[['1', 'ورود اطلاعات از تلگرام'], ['2', 'مشخصات محتوا'], ['3', 'کیفیت‌ها و لینک‌ها'], ['4', 'انتشار']]
    .map(([step, label]) => `<button type="button" role="tab" aria-selected="${editor.step === Number(step)}"
        data-step="${step}" class="${editor.step === Number(step) ? 'is-on' : ''}">${label}</button>`).join('')}
      </div>

      <div class="wizard">
        <div class="wizard__form">
          ${editor.step === 1 ? importStep(editor) : ''}
          ${editor.step === 2 ? metadataStep(draft, editor) : ''}
          ${editor.step === 3 ? versionsStep(editor) : ''}
          ${editor.step === 4 ? publishStep(draft, editor) : ''}

          <div class="form-actions">
            ${editor.step > 1 ? '<button class="button button--ghost button--sm" type="button" data-prev-step>مرحله قبل</button>' : ''}
            ${editor.step < 4 ? '<button class="button button--ghost button--sm" type="button" data-next-step>مرحله بعد</button>' : ''}
            <button class="button button--primary" type="button" data-save-content ${state.busy ? 'disabled' : ''}>
              ${ICONS.check} ${isCreate ? 'ثبت محتوا' : 'ذخیره تغییرات'}
            </button>
            ${!isCreate ? `<button class="button button--danger button--sm" type="button" data-delete-content="${esc(editor.assetId)}" data-delete-title="${esc(draft.titleFa)}">${ICONS.trash} حذف</button>` : ''}
          </div>
        </div>

        <aside class="wizard__side">
          <div class="summary-card">
            <div class="summary-card__poster">
              ${safeUrl(draft.posterUrl)
    ? `<img src="${esc(safeUrl(draft.posterUrl))}" alt="">`
    : `<span>${esc(firstLetter(draft.titleFa || draft.titleEn))}</span>`}
            </div>
            <div>
              <div class="summary-card__title">${esc(draft.titleFa || 'بدون عنوان')}</div>
              <div class="summary-card__sub">${esc(draft.titleEn || '—')}</div>
            </div>
            <dl class="summary-list">
              <div><dt>نوع</dt><dd>${draft.contentType === 'series' ? 'سریال' : 'فیلم'}</dd></div>
              <div><dt>سال</dt><dd>${draft.releaseYear ? fa(draft.releaseYear) : '—'}${draft.lastAirYear ? ` – ${fa(draft.lastAirYear)}` : ''}</dd></div>
              <div><dt>وضعیت</dt><dd><span class="status-badge status-badge--${esc(draft.status)}">${statusLabel(draft.status)}</span></dd></div>
              <div><dt>نسخه‌ها</dt><dd>${fa(editor.versions.length)}</dd></div>
              <div><dt>لینک‌ها</dt><dd>${faNum(editor.versions.reduce((sum, version) => sum + version.links.length, 0))}</dd></div>
            </dl>
            <div class="checklist">
              ${checklist.map((item) => `<span class="${item.done ? 'is-done' : ''}">${item.done ? ICONS.check : ICONS.info} ${item.label}</span>`).join('')}
            </div>
            <div class="action-stack">
              ${draft.posterUrl ? '' : `<button class="button button--ghost button--sm" type="button" data-focus-poster>${ICONS.image} افزودن پوستر</button>`}
              <button class="button button--ghost button--sm" type="button" data-toggle-hero-draft>${ICONS.star} ${draft.featuredHero ? 'در بنر هیرو است' : 'افزودن به بنر هیرو'}</button>
            </div>
          </div>
          ${editor.meta ? `<div class="summary-card">
            <h3>گزارش خواندن پست</h3>
            <div class="confidence ${editor.meta.confidence >= 70 ? '' : editor.meta.confidence >= 40 ? 'is-medium' : 'is-low'}">
              <b>${fa(editor.meta.confidence)}٪</b> فیلدها از متن شناسایی شد
            </div>
            ${editor.meta.missing?.length ? `<div class="missing-list">${editor.meta.missing.map((item) => `<span>${esc(item)}</span>`).join('')}</div>` : ''}
            ${editor.meta.notes?.length ? `<ul class="note-list">${editor.meta.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
          </div>` : ''}
        </aside>
      </div>
    </section>`;
  }

  function importStep(editor) {
    const withLinkOnly = !editor.sourceText;
    return `<article class="section-card">
      <div class="section-card__head">
        <div>
          <h2>${ICONS.link} خواندن خودکار از پست تلگرام</h2>
          <p>لینک پست کانال را بگذارید، یا متن همان پست را در کادر دوم بچسبانید. هر دو با هم هم کار می‌کند.</p>
        </div>
      </div>
      <div class="section-card__body">
        <div class="import-box">
          <label class="field field--link">
            <span>لینک پست تلگرام ${withLinkOnly ? '<em>*</em>' : ''}</span>
            <input class="input" type="url" dir="ltr" placeholder="https://t.me/kanal/123" data-source-link value="${esc(editor.sourceLink)}">
            <small>فقط کانال عمومی. برای پست کانال خصوصی، متن پست را در کادر روبه‌رو بچسبانید.</small>
          </label>
          <label class="field">
            <span>متن پست (اختیاری)</span>
            <textarea class="textarea" data-source-text placeholder="🎬 The Pitt | پیت
نوع: سریال
سال شروع: 2026
ژانر: درام، پزشکی
امتیاز IMDb: 8.9">${esc(editor.sourceText)}</textarea>
            <small>هر قالب متعارف کانال‌ها پشتیبانی می‌شود: عنوان، نام فارسی، نوع، سال، ژانر، کارگردان، بازیگران، کشور، رده سنی، شبکه، امتیاز، مدت، کیفیت، وضعیت پخش و خلاصه داستان.</small>
          </label>
        </div>
        <div class="form-actions">
          <button class="button button--primary button--sm" type="button" data-run-parse ${state.busy ? 'disabled' : ''}>
            ${ICONS.spark} خواندن و پر کردن فیلدها
          </button>
          <button class="button button--ghost button--sm" type="button" data-skip-import>ورود دستی بدون پست</button>
        </div>
        <div class="callout">${ICONS.info}
          <span>با خواندن پست، فیلدهای مشخصات و همچنین فهرست کیفیت‌ها و نسخه‌های پیشنهادی ساخته می‌شود؛ هیچ‌چیز تا زدن دکمه «ثبت محتوا» ذخیره نمی‌شود.</span>
        </div>
      </div>
    </article>`;
  }

  function metadataStep(draft, editor) {
    const isSeries = draft.contentType === 'series';
    const gallery = (draft.posterGallery || []).map((url, index) => `
      <div class="gallery-tile ${url === draft.posterUrl ? 'gallery-tile--primary' : ''}">
        <img src="${esc(safeUrl(url) || '')}" alt="پوستر ${fa(index + 1)}" loading="lazy">
        <button type="button" data-remove-gallery="${index}" aria-label="حذف تصویر">${ICONS.trash}</button>
        ${url === draft.posterUrl ? '<span class="gallery-tile__badge">پوستر اصلی</span>' : `<button type="button" data-set-primary="${index}" aria-label="انتخاب به‌عنوان پوستر اصلی" style="inset-inline-end:auto;inset-inline-start:5px;color:#ddd6fe">${ICONS.star}</button>`}
      </div>`).join('');

    return `<article class="section-card">
      <div class="section-card__head"><div><h2>${ICONS.movie} اطلاعات اثر</h2><p>عنوان‌ها، نوع، سال و وضعیت پخش</p></div>
        <span class="tag">${isSeries ? 'سریال' : 'فیلم'}</span></div>
      <div class="section-card__body">
        <div class="field-grid">
          <label class="field"><span>عنوان فارسی <em>*</em></span>
            <input class="input" name="titleFa" data-field="titleFa" value="${esc(draft.titleFa)}" maxlength="255" placeholder="مثلاً پیت">
            <small>در سایت به همین شکل نمایش داده می‌شود.</small></label>
          <label class="field"><span>عنوان انگلیسی <em>*</em></span>
            <input class="input" dir="ltr" name="titleEn" data-field="titleEn" value="${esc(draft.titleEn)}" maxlength="255" placeholder="The Pitt">
            <small>زیر عنوان فارسی می‌آید و در جستجو هم پیدا می‌شود.</small></label>
          <label class="field"><span>نوع</span>
            <select class="select" name="contentType" data-field="contentType" data-structural>
              <option value="movie" ${draft.contentType === 'movie' ? 'selected' : ''}>فیلم</option>
              <option value="series" ${draft.contentType === 'series' ? 'selected' : ''}>سریال</option>
            </select></label>
          <label class="field"><span>${isSeries ? 'سال شروع (فصل اول)' : 'سال تولید'}</span>
            <input class="input" type="number" min="1888" max="2200" dir="ltr" name="releaseYear" data-field="releaseYear" value="${esc(draft.releaseYear)}" placeholder="2026"></label>
          ${isSeries ? `<label class="field"><span>سال آخرین فصل (اختیاری)</span>
            <input class="input" type="number" min="1888" max="2200" dir="ltr" name="lastAirYear" data-field="lastAirYear" value="${esc(draft.lastAirYear)}" placeholder="2026">
            <small>اگر سریال فقط یک فصل دارد، خالی بگذارید.</small></label>` : ''}
        </div>

        ${isSeries ? `<div class="section-card section-card--attention" style="border-radius:18px">
          <div class="section-card__head" style="padding:13px 15px">
            <div><h2 style="font-size:13px">${ICONS.clock} وضعیت پخش سریال</h2>
              <p>با روشن شدن این گزینه، فصل در حال پخش و متن دلخواه فعال می‌شوند.${editor.sourceKind === 'telegram_link' && editor.meta?.notes?.length ? ' وضعیت تشخیص‌داده‌شده در گزارش سمت چپ آمده است.' : ''}</p></div>
            <label class="switch">
              <input type="checkbox" data-field="seriesRunning" data-structural ${draft.seriesRunning ? 'checked' : ''}>
              <span class="switch__track"></span>
            </label>
          </div>
          ${draft.seriesRunning ? `<div class="section-card__body" style="padding-top:0">
            <div class="field-grid">
              <label class="field"><span>فصل در حال پخش</span>
                <input class="input" type="number" min="1" max="100" dir="ltr" data-field="currentSeason" value="${esc(draft.currentSeason)}" placeholder="۶"></label>
              <label class="field"><span>متن دلخواه (اختیاری)</span>
                <input class="input" data-field="broadcastNote" value="${esc(draft.broadcastNote)}" maxlength="120" placeholder="مثلاً: فصل ۶ — هر جمعه قسمت جدید">
                <small>اگر خالی بگذارید، خودکار به شکل «فصل ۶ — هر هفته قسمت جدید» نوشته می‌شود.</small></label>
            </div>
          </div>` : ''}
        </div>` : ''}

        <div class="field-grid">
          <label class="field"><span>ژانرها (با ویرگول)</span>
            <input class="input" data-field="genres" value="${esc(draft.genres)}" placeholder="درام، معمایی، علمی تخیلی"></label>
          <label class="field"><span>کارگردان(ها)</span>
            <input class="input" data-field="directors" value="${esc(draft.directors)}" placeholder="دامین مارکانو، جان ولز | Damian Marcano, John Wells">
            <small>فارسی و انگلیسی، با ویرگول و یک <code dir="ltr">|</code> بین دو زبان. هر دو در سایت نمایش داده و جستجو می‌شوند.</small></label>
          <label class="field span-2"><span>بازیگران</span>
            <input class="input" data-field="cast" value="${esc(draft.cast)}" placeholder="نوآ وایلی، پاتریک بال | Noah Wyle, Patrick Ball">
            <small>همان قاعده: نام‌های فارسی، سپس <code dir="ltr">|</code> و نام‌های انگلیسی.</small></label>
          <label class="field"><span>کشور(ها)</span>
            <input class="input" data-field="countries" value="${esc(draft.countries)}" placeholder="آمریکا"></label>
          <label class="field"><span>رده سنی</span>
            <input class="input" dir="ltr" data-field="ageRating" value="${esc(draft.ageRating)}" placeholder="PG-13"></label>
          <label class="field"><span>شبکه</span>
            <input class="input" data-field="network" value="${esc(draft.network)}" placeholder="Netflix / HBO Max"></label>
          <label class="field"><span>امتیاز IMDb</span>
            <input class="input" type="number" min="0" max="10" step="0.1" dir="ltr" data-field="imdbScore" value="${esc(draft.imdbScore)}" placeholder="8.9"></label>
          <label class="field"><span>${isSeries ? 'مدت میانگین هر قسمت (دقیقه)' : 'مدت (دقیقه)'}</span>
            <input class="input" type="number" min="1" max="1200" dir="ltr" data-field="runtimeMinutes" value="${esc(draft.runtimeMinutes)}" placeholder="50"></label>
          ${isSeries ? `<div class="field"><span>فصل / قسمت</span>
            <div style="display:flex;gap:8px">
              <input class="input" type="number" min="1" placeholder="تعداد فصل" data-field="seasonCount" value="${esc(draft.seasonCount)}">
              <input class="input" type="number" min="1" placeholder="تعداد قسمت" data-field="episodeCount" value="${esc(draft.episodeCount)}">
            </div></div>` : ''}
        </div>

        <div class="field">
          <span>نسخه‌های موجود</span>
          <div class="chip-set">
            <label class="chip ${draft.hasSub ? 'is-on' : ''}" style="cursor:pointer">
              <input type="checkbox" data-field="hasSub" data-structural ${draft.hasSub ? 'checked' : ''} style="display:none"> زیرنویس
            </label>
            <label class="chip ${draft.hasDub ? 'is-on' : ''}" style="cursor:pointer">
              <input type="checkbox" data-field="hasDub" data-structural ${draft.hasDub ? 'checked' : ''} style="display:none"> دوبله
            </label>
          </div>
        </div>

        <label class="field"><span>توضیحات</span>
          <textarea class="textarea" data-field="description" rows="4" maxlength="20000">${esc(draft.description)}</textarea></label>

        <div class="field-grid field-grid--wide">
          <label class="field"><span>لینک پوستر</span>
            <input class="input" type="url" dir="ltr" data-field="posterUrl" data-poster-input value="${esc(draft.posterUrl)}" placeholder="https://example.com/poster.jpg">
            <small>لینک تصویر عمودی پوستر که در سایت نمایش داده می‌شود.</small></label>
          <label class="field"><span>لینک پس‌زمینه (هیرو)</span>
            <input class="input" type="url" dir="ltr" data-field="backdropUrl" value="${esc(draft.backdropUrl)}" placeholder="https://example.com/backdrop.jpg"></label>
          <label class="field span-full"><span>گالری پوسترها (IMPAwards)</span>
            <div style="display:flex;gap:8px">
              <input class="input" type="url" dir="ltr" data-gallery-input placeholder="https://.../poster.jpg">
              <button class="button button--ghost button--sm" type="button" data-add-gallery>${ICONS.plus} افزودن</button>
            </div>
            <small>اولین تصویر گالری به‌عنوان پوستر اصلی پیشنهاد می‌شود؛ با ستاره می‌توانید هر تصویر را اصلی کنید.</small>
          </label>
        </div>
        ${gallery ? `<div class="gallery-grid">${gallery}</div>` : ''}
      </div>
    </article>`;
  }

  function versionsStep(editor) {
    return `<article class="section-card">
      <div class="section-card__head">
        <div><h2>${ICONS.layers} کیفیت‌ها و لینک‌ها</h2>
          <p>نوع فایل را انتخاب کنید، عنوان (مثلاً 720p) را بنویسید و نسخه‌ها را بسازید.</p></div>
        <span class="tag">${fa(editor.versions.length)} نسخه</span>
      </div>
      <div class="section-card__body">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
          <label class="field" style="flex:0 0 150px"><span>نوع فایل</span>
            <select class="select" data-version-kind>
              <option value="sub" ${editor.kind === 'sub' ? 'selected' : ''}>زیرنویس</option>
              <option value="dub" ${editor.kind === 'dub' ? 'selected' : ''}>دوبله</option>
            </select></label>
          <label class="field" style="flex:1 1 240px"><span>عنوان کیفیت‌ها</span>
            <input class="input" dir="ltr" data-quality-input value="${esc(editor.qualities)}" placeholder="1080p، 720p، 480p"></label>
          <button class="button button--primary button--sm" type="button" data-create-versions>${ICONS.plus} ایجاد نسخه‌ها</button>
        </div>
        <div class="callout">${ICONS.info}<span>لینک‌های پخش آنلاین، زیرنویس، دوبله و تلگرام را برای هر ردیف وارد کنید یا بگذارید ربات مدیریت آن‌ها را از تلگرام پر کند. برای سریال، فصل و شماره قسمت را مشخص کنید.</span></div>

        <div class="version-list">
          ${editor.versions.length ? editor.versions.map((version, index) => versionCard(version, index, editor)).join('')
    : `<div class="version-empty">
            <p style="margin:0 0 8px">هنوز نسخه‌ای ساخته نشده است.</p>
            <p style="margin:0 0 10px;color:var(--muted)">پست تلگرام درباره دوبله/زیرنویس چیزی نگفته بود؛ نوع فایل و کیفیت‌ها را انتخاب کنید و نسخه‌ها را بسازید. لینک‌ها بعداً یا دستی یا با دکمه «دریافت لینک‌ها از ربات» پر می‌شوند.</p>
            <div class="chip-set" style="justify-content:center">
              ${['1080p', '720p', '480p'].map((quality) => `<button class="chip" type="button" data-quick-quality="${quality}">${quality}</button>`).join('')}
            </div>
          </div>`}
        </div>
      </div>
    </article>`;
  }

  function versionCard(version, index, editor) {
    const collapsed = editor.collapsed?.[index];
    return `<div class="version-card ${collapsed ? 'is-collapsed' : ''}" data-version="${index}">
      <div class="version-card__head">
        <span class="kind-badge kind-badge--${version.kind}">${version.kind === 'dub' ? 'دوبله' : 'زیرنویس'}</span>
        <input class="input" style="max-width:150px;height:34px" dir="ltr" data-version-title="${index}" value="${esc(version.title)}" aria-label="عنوان نسخه" placeholder="720p">
        <span class="tag">${fa(version.links.length)} لینک</span>
        <span class="spacer"></span>
        <button class="icon-button" type="button" data-toggle-version="${index}" title="${collapsed ? 'باز کردن' : 'بستن'}" style="transform:rotate(${collapsed ? '180deg' : '0'})">${ICONS.chevron}</button>
        <button class="icon-button icon-button--danger" type="button" data-remove-version="${index}" title="حذف نسخه">${ICONS.trash}</button>
      </div>
      <div class="version-card__body">
        ${version.links.map((link, linkIndex) => linkRow(link, index, linkIndex, editor)).join('')}
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="button button--ghost button--sm" type="button" data-add-link="${index}">${ICONS.plus} افزودن ${editor.draft.contentType === 'series' ? 'قسمت' : 'لینک'}</button>
          ${editor.draft.contentType === 'series' ? `<button class="button button--ghost button--sm" type="button" data-fill-episodes="${index}">${ICONS.layers} ساخت همه قسمت‌ها از تعداد بخش</button>` : ''}
        </div>
      </div>
    </div>`;
  }

  function linkRow(link, versionIndex, linkIndex, editor) {
    const isSeries = editor.draft.contentType === 'series';
    return `<div class="link-row" data-link="${versionIndex}-${linkIndex}">
      ${isSeries ? `<input class="input" type="number" min="1" dir="ltr" placeholder="فصل" value="${esc(link.season)}" data-link-field="season" data-version-index="${versionIndex}" data-link-index="${linkIndex}" aria-label="فصل">` : '<span class="episode-badge">فیلم</span>'}
      ${isSeries ? `<input class="input" type="number" min="1" dir="ltr" placeholder="قسمت" value="${esc(link.episode)}" data-link-field="episode" data-version-index="${versionIndex}" data-link-index="${linkIndex}" aria-label="قسمت">` : '<span></span>'}
      <input class="input input--wide" dir="ltr" placeholder="لینک پخش آنلاین (اختیاری)" value="${esc(link.streamUrl)}" data-link-field="streamUrl" data-version-index="${versionIndex}" data-link-index="${linkIndex}" aria-label="لینک پخش آنلاین">
      <input class="input input--wide" dir="ltr" placeholder="لینک زیرنویس" value="${esc(link.subtitleUrl)}" data-link-field="subtitleUrl" data-version-index="${versionIndex}" data-link-index="${linkIndex}" aria-label="لینک زیرنویس">
      <input class="input input--wide" dir="ltr" placeholder="لینک دوبله" value="${esc(link.dubUrl)}" data-link-field="dubUrl" data-version-index="${versionIndex}" data-link-index="${linkIndex}" aria-label="لینک دوبله">
      <button class="icon-button icon-button--danger" type="button" data-remove-link="${versionIndex}-${linkIndex}" title="حذف ردیف">${ICONS.trash}</button>
      <div style="grid-column:1/-1;display:flex;gap:7px">
        <input class="input" placeholder="${isSeries ? 'عنوان قسمت (اختیاری)' : 'نام نسخه (اختیاری)'}" value="${esc(link.title)}" data-link-field="title" data-version-index="${versionIndex}" data-link-index="${linkIndex}" aria-label="عنوان">
        <input class="input" dir="ltr" style="max-width:130px" placeholder="حجم" value="${esc(link.sizeText)}" data-link-field="sizeText" data-version-index="${versionIndex}" data-link-index="${linkIndex}" aria-label="حجم">
        <input class="input" dir="ltr" placeholder="لینک پیام تلگرام (خودکار توسط ربات)" value="${esc(link.telegramUrl)}" data-link-field="telegramUrl" data-version-index="${versionIndex}" data-link-index="${linkIndex}" aria-label="لینک تلگرام">
      </div>
    </div>`;
  }

  function publishStep(draft, editor) {
    const totalLinks = editor.versions.reduce((sum, version) => sum + version.links.length, 0);
    const missing = [];
    if (!draft.titleFa && !draft.titleEn) missing.push('عنوان');
    if (!draft.posterUrl) missing.push('پوستر');
    if (!draft.releaseYear) missing.push('سال');
    if (!editor.versions.length) missing.push('نسخه/لینک');
    return `<article class="section-card">
      <div class="section-card__head"><div><h2>${ICONS.check} انتشار</h2><p>وضعیت نهایی و جایگاه در صفحه اصلی</p></div></div>
      <div class="section-card__body">
        <div class="field-grid">
          <label class="field"><span>وضعیت</span>
            <select class="select" data-field="status" data-structural>
              <option value="draft" ${draft.status === 'draft' ? 'selected' : ''}>پیش‌نویس (فقط در پنل)</option>
              <option value="published" ${draft.status === 'published' ? 'selected' : ''}>منتشر شده</option>
              ${editor.mode === 'edit' ? `<option value="archived" ${draft.status === 'archived' ? 'selected' : ''}>آرشیو</option>` : ''}
            </select></label>
          <div class="field"><span>بنر هیرو صفحه اصلی</span>
            <label class="switch">
              <input type="checkbox" data-field="featuredHero" ${draft.featuredHero ? 'checked' : ''}>
              <span class="switch__track"></span>
              <span class="switch__label">نمایش در بنر اصلی</span>
            </label>
            <small>با فعال شدن، این اثر جایگزین بنر فعلی صفحه اصلی می‌شود.</small>
          </div>
        </div>
        <dl class="summary-list">
          <div><dt>تعداد نسخه</dt><dd>${fa(editor.versions.length)}</dd></div>
          <div><dt>تعداد لینک</dt><dd>${faNum(totalLinks)}</dd></div>
          <div><dt>دوبله</dt><dd>${draft.hasDub ? 'دارد' : 'ندارد'}</dd></div>
          <div><dt>زیرنویس</dt><dd>${draft.hasSub ? 'دارد' : 'ندارد'}</dd></div>
        </dl>
        ${missing.length ? `<div class="callout callout--warn">${ICONS.warn}<span>موارد باقی‌مانده: ${missing.join('، ')}</span></div>`
    : `<div class="callout">${ICONS.check}<span>همه موارد ضروری کامل است؛ می‌توانید اثر را ثبت کنید.</span></div>`}
      </div>
    </article>`;
  }

  function readEditorDraft() {
    const editor = state.editor;
    if (!editor) return null;
    const draft = editor.draft;
    return {
      contentType: draft.contentType,
      titleFa: String(draft.titleFa || '').trim(),
      titleEn: String(draft.titleEn || '').trim(),
      description: String(draft.description || '').trim(),
      releaseYear: draft.releaseYear === '' ? null : Number(draft.releaseYear),
      lastAirYear: draft.contentType === 'series' && draft.lastAirYear !== '' ? Number(draft.lastAirYear) : null,
      seriesRunning: draft.contentType === 'series' ? Boolean(draft.seriesRunning) : false,
      currentSeason: draft.seriesRunning && draft.currentSeason !== '' ? Number(draft.currentSeason) : null,
      broadcastNote: draft.seriesRunning ? String(draft.broadcastNote || '') : '',
      seasonCount: draft.seasonCount === '' ? null : Number(draft.seasonCount),
      episodeCount: draft.episodeCount === '' ? null : Number(draft.episodeCount),
      genres: listFrom(draft.genres),
      directors: listFrom(draft.directors),
      cast: listFrom(draft.cast),
      countries: listFrom(draft.countries),
      network: String(draft.network || '').trim(),
      ageRating: String(draft.ageRating || '').trim(),
      imdbScore: draft.imdbScore === '' ? null : Number(draft.imdbScore),
      runtimeMinutes: draft.runtimeMinutes === '' ? null : Number(draft.runtimeMinutes),
      hasDub: Boolean(draft.hasDub),
      hasSub: Boolean(draft.hasSub),
      posterUrl: String(draft.posterUrl || '').trim(),
      posterGallery: draft.posterGallery || [],
      backdropUrl: String(draft.backdropUrl || '').trim(),
      trailerUrl: String(draft.trailerUrl || '').trim(),
      streamUrl: String(draft.streamUrl || '').trim(),
      featuredHero: Boolean(draft.featuredHero),
      status: draft.status,
      sourceType: editor.meta ? editor.sourceKind : undefined,
      sourceUrl: editor.sourceLink || undefined,
      versions: editor.versions.map((version, index) => ({
        kind: version.kind,
        title: version.title || version.resolution || `نسخه ${index + 1}`,
        resolution: version.resolution || version.title,
        sortOrder: index,
        links: version.links.map((link) => ({
          season: link.season === '' ? null : Number(link.season),
          episode: link.episode === '' ? null : Number(link.episode),
          title: link.title || null,
          label: link.label || null,
          sizeText: link.sizeText || null,
          streamUrl: link.streamUrl || null,
          subtitleUrl: link.subtitleUrl || null,
          dubUrl: link.dubUrl || null,
          telegramUrl: link.telegramUrl || null,
          source: link.telegramUrl ? 'telegram_bot' : 'manual',
        })),
      })),
    };
  }

  async function saveEditor() {
    const editor = state.editor;
    if (!editor || state.busy) return;
    const payload = readEditorDraft();
    if (!payload.titleFa && !payload.titleEn) {
      toast('عنوان فارسی یا انگلیسی را وارد کنید.', 'error');
      editor.step = 2;
      paintEditor();
      return;
    }
    state.busy = true;
    paintEditor();
    try {
      if (editor.mode === 'create') {
        const created = await api('/api/admin/contents', { method: 'POST', body: payload });
        toast('محتوا ثبت شد.');
        state.editor = null;
        await refreshCounts();
        navigate('edit', created.content.id);
      } else {
        await api(`/api/admin/contents/${encodeURIComponent(editor.assetId)}`, { method: 'PATCH', body: payload });
        toast('تغییرات ذخیره شد.');
        await refreshCounts();
        await renderEditor(editor.assetId);
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.busy = false;
      const button = $('[data-save-content]');
      if (button) button.disabled = false;
    }
  }

  async function runParse() {
    const editor = state.editor;
    if (!editor || state.busy) return;
    const link = editor.sourceLink.trim();
    const text = editor.sourceText.trim();
    if (!link && !text) {
      toast('لینک یا متن پست را وارد کنید.', 'error');
      return;
    }
    state.busy = true;
    paintEditor();
    try {
      const { draft } = await api('/api/admin/parse', { method: 'POST', body: { link, text } });
      const fields = draft.fields;
      Object.assign(editor.draft, {
        contentType: fields.contentType,
        titleFa: fields.titleFa || editor.draft.titleFa,
        titleEn: fields.titleEn || editor.draft.titleEn,
        description: fields.description || editor.draft.description,
        releaseYear: fields.releaseYear ?? editor.draft.releaseYear,
        lastAirYear: fields.lastAirYear ?? '',
        seriesRunning: Boolean(fields.seriesRunning),
        currentSeason: fields.currentSeason ?? '',
        broadcastNote: fields.broadcastNote || '',
        seasonCount: fields.seasonCount ?? '',
        episodeCount: fields.episodeCount ?? '',
        genres: (fields.genres || []).join('، '),
        directors: (fields.directors || []).join('، '),
        cast: (fields.cast || []).join('، '),
        countries: (fields.countries || []).join('، '),
        network: fields.network || '',
        ageRating: fields.ageRating || '',
        imdbScore: fields.imdbScore ?? '',
        runtimeMinutes: fields.runtimeMinutes ?? '',
        // A post that never mentions dubbing or subtitles must not switch both off.
        hasDub: fields.hasDub || !fields.hasSub,
        hasSub: fields.hasSub || !fields.hasDub,
        posterUrl: fields.posterUrl || editor.draft.posterUrl,
        streamUrl: fields.streamUrl || editor.draft.streamUrl,
      });
      if (fields.posterUrl && !editor.draft.posterGallery.includes(fields.posterUrl)) {
        editor.draft.posterGallery = [fields.posterUrl, ...editor.draft.posterGallery];
      }
      editor.qualities = (fields.qualities?.length ? fields.qualities : ['1080p', '720p']).join('، ');
      editor.meta = draft.meta;
      editor.sourceKind = 'telegram_link';
      if (draft.versions?.length) {
        editor.versions = draft.versions.map((version) => ({
          kind: version.kind,
          title: version.label,
          resolution: version.resolution,
          links: [{
            season: fields.contentType === 'series' ? 1 : '',
            episode: fields.contentType === 'series' ? 1 : '',
            title: '', label: '', sizeText: '',
            streamUrl: '', subtitleUrl: '', dubUrl: '', telegramUrl: '',
          }],
        }));
      }
      editor.step = 2;
      toast(`پست خوانده شد؛ ${fa(draft.meta.confidence)}٪ فیلدها شناسایی شد.`);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.busy = false;
      paintEditor();
    }
  }

  /**
   * Moving past the metadata step with no versions yet (manual entry) should still
   * land on a usable versions table instead of an empty card.
   */
  function edgePrimeVersions(editor) {
    if (!editor || editor.versions.length) return;
    if (!editor.draft.titleFa && !editor.draft.titleEn) return;
    const qualities = listFrom(editor.qualities);
    const chosen = qualities.length ? qualities : ['1080p', '720p'];
    for (const quality of chosen) {
      editor.versions.push({
        kind: 'sub',
        title: quality,
        resolution: quality,
        links: [{
          season: editor.draft.contentType === 'series' ? (editor.draft.currentSeason || 1) : '',
          episode: editor.draft.contentType === 'series' ? 1 : '',
          title: '', label: '', sizeText: '',
          streamUrl: '', subtitleUrl: '', dubUrl: '', telegramUrl: '',
        }],
      });
    }
  }

  function createVersions() {
    const editor = state.editor;
    if (!editor) return;
    const qualities = listFrom(editor.qualities);
    if (!qualities.length) {
      toast('عنوان کیفیت را وارد کنید، مثلاً 720p.', 'error');
      return;
    }
    const kind = editor.kind;
    for (const quality of qualities) {
      const exists = editor.versions.some((version) => version.kind === kind && version.title.toLowerCase() === quality.toLowerCase());
      if (exists) continue;
      editor.versions.push({
        kind,
        title: quality,
        resolution: quality,
        links: [{
          season: editor.draft.contentType === 'series' ? '' : '',
          episode: '',
          title: '', label: '', sizeText: '',
          streamUrl: '', subtitleUrl: '', dubUrl: '', telegramUrl: '',
        }],
      });
    }
    editor.step = 3;
    paintEditor();
    toast('نسخه‌ها ایجاد شد؛ لینک‌ها را تکمیل کنید.');
  }

  /* ---------------------------------------------------------------- users */
  /* ---------------------------------------------------------------- users */
  const userFilters = { q: '', role: '', layout: 'cards' };

  function userAvatar(user) {
    const letter = String(user.accountName || '?').trim().slice(0, 1);
    return `<span class="user-avatar" aria-hidden="true">${esc(letter || '?')}</span>`;
  }

  function userWalletMarkup(user) {
    return `<div class="user-wallet">
      <span class="user-wallet__label">کیف پول تبلیغات</span>
      <b class="user-wallet__balance" data-wallet-balance="${esc(user.id)}">${faNum(user.walletBalance)}</b>
      <span class="muted">${esc(user.walletCurrency || 'IRR')}</span>
    </div>`;
  }

  function userActions(user) {
    return `<div class="user-actions">
      <button class="button button--ghost button--xs" type="button" data-topup="${esc(user.id)}">افزایش موجودی</button>
      <button class="button button--ghost button--xs" type="button" data-reveal-phone="${esc(user.id)}">نمایش شماره</button>
      <button class="button button--danger button--xs" type="button" data-delete-user="${esc(user.id)}" data-user-name="${esc(user.accountName)}">حذف کاربر</button>
    </div>`;
  }

  function userMetaMarkup(user) {
    const handle = user.telegramUsername
      ? `@${esc(user.telegramUsername)}`
      : `شناسه تلگرام ${esc(user.telegramUserId || user.id)}`;
    const phone = user.phoneMasked || 'ثبت نشده';
    return `<div class="user-meta">
      <span class="user-meta__row"><i>تلگرام</i>${user.telegramProfileUrl
        ? `<a href="${esc(user.telegramProfileUrl)}" target="_blank" rel="noopener noreferrer">${handle}</a>`
        : `<span>${handle}</span>`}</span>
      <span class="user-meta__row"><i>موبایل</i><span data-phone="${esc(user.id)}" dir="ltr">${esc(phone)}</span></span>
      <span class="user-meta__row"><i>عضویت</i><span>${faDate(user.createdAt)}</span></span>
    </div>`;
  }

  function userRoleSelect(user) {
    return `<select class="select" style="height:32px;min-width:112px" data-user-role="${esc(user.id)}">
      <option value="user" ${user.role === 'user' ? 'selected' : ''}>کاربر</option>
      <option value="advertiser" ${user.role === 'advertiser' ? 'selected' : ''}>تبلیغ‌دهنده</option>
    </select>`;
  }

  function userCards(items) {
    return `<div class="user-grid">${items.map((user) => `<article class="user-card" data-user-card="${esc(user.id)}">
      <header class="user-card__head">
        ${userAvatar(user)}
        <div class="user-card__id"><strong>${esc(user.accountName)}</strong>
          <span class="user-card__tags"><span class="tag">${user.role === 'advertiser' ? 'تبلیغ‌دهنده' : 'کاربر'}</span>
          ${user.status === 'suspended' ? '<span class="tag tag--warn">مسدود</span>' : ''}</span>
        </div>
      </header>
      ${userMetaMarkup(user)}
      ${userWalletMarkup(user)}
      ${userActions(user)}
      <div class="user-card__role">${userRoleSelect(user)}</div>
    </article>`).join('')}</div>`;
  }

  function userRows(items) {
    return `<div class="table-wrap"><table class="data">
      <thead><tr><th>کاربر</th><th>تلگرام</th><th>موبایل</th><th>نقش</th><th>موجودی</th><th>عضویت</th><th>اقدام</th></tr></thead>
      <tbody>${items.map((user) => `<tr data-user-row="${esc(user.id)}">
        <td><div class="user-cell">${userAvatar(user)}<strong>${esc(user.accountName)}</strong></div></td>
        <td>${user.telegramProfileUrl ? `<a href="${esc(user.telegramProfileUrl)}" target="_blank" rel="noopener noreferrer">@${esc(user.telegramUsername)}</a>` : '<span class="muted">بدون نام کاربری</span>'}</td>
        <td><span data-phone="${esc(user.id)}" dir="ltr">${esc(user.phoneMasked || 'ثبت نشده')}</span></td>
        <td>${userRoleSelect(user)}</td>
        <td><b data-wallet-balance="${esc(user.id)}">${faNum(user.walletBalance)}</b> <span class="muted">${esc(user.walletCurrency || 'IRR')}</span></td>
        <td class="muted">${faDate(user.createdAt)}</td>
        <td>${userActions(user)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  async function renderUsers() {
    const root = $('#view-root');
    root.innerHTML = `<section class="view"><div class="page-head"><div><h1>کاربران</h1><p>شناسه تلگرام، شماره، کیف پول و حذف کاربر</p></div></div>
      <div class="skeleton" style="height:280px"></div></section>`;
    const params = new URLSearchParams();
    if (userFilters.q) params.set('q', userFilters.q);
    if (userFilters.role) params.set('role', userFilters.role);
    const data = await api(`/api/admin/users${params.toString() ? `?${params}` : ''}`);
    const items = data.items || [];
    const advertisers = items.filter((user) => user.role === 'advertiser').length;
    const wallets = items.reduce((sum, user) => sum + Number(user.walletBalance || 0), 0);

    root.innerHTML = `<section class="view">
      <div class="page-head"><div><h1>کاربران</h1><p>${faNum(items.length)} کاربر · ${faNum(advertisers)} تبلیغ‌دهنده · مجموع کیف پول ${faNum(wallets)} IRR</p></div></div>
      <div class="user-toolbar">
        <label class="user-search">${ICONS.search}<input type="search" data-user-search value="${esc(userFilters.q)}" placeholder="نام، نام کاربری، شناسه یا ۴ رقم آخر شماره…"></label>
        <div class="segmented" role="group" aria-label="نقش">
          <button type="button" class="${userFilters.role === '' ? 'is-active' : ''}" data-user-role-filter="">همه</button>
          <button type="button" class="${userFilters.role === 'user' ? 'is-active' : ''}" data-user-role-filter="user">کاربر</button>
          <button type="button" class="${userFilters.role === 'advertiser' ? 'is-active' : ''}" data-user-role-filter="advertiser">تبلیغ‌دهنده</button>
        </div>
        <div class="segmented" role="group" aria-label="نمایش">
          <button type="button" class="${userFilters.layout === 'cards' ? 'is-active' : ''}" data-user-layout="cards">کارتی</button>
          <button type="button" class="${userFilters.layout === 'rows' ? 'is-active' : ''}" data-user-layout="rows">ردیفی</button>
        </div>
      </div>
      ${items.length
        ? (userFilters.layout === 'rows' ? userRows(items) : userCards(items))
        : `<div class="empty-state"><strong>کاربری پیدا نشد</strong><p>عبارت جستجو یا فیلتر نقش را تغییر دهید.</p></div>`}
      <div class="callout">${ICONS.info}<span>شماره موبایل رمزگذاری‌شده ذخیره می‌شود و اینجا فقط چهار رقم اول و دو رقم آخر آن دیده می‌شود؛ با «نمایش شماره» کل شماره باز می‌شود و در گزارش رویدادهای پنل ثبت می‌گردد.</span></div>
    </section>`;

    $('[data-user-search]', root)?.addEventListener('change', (event) => {
      userFilters.q = event.target.value.trim();
      render();
    });
    $$('[data-user-layout]', root).forEach((button) => button.addEventListener('click', () => {
      userFilters.layout = button.dataset.userLayout;
      renderUsers();
    }));
    $$('[data-user-role-filter]', root).forEach((button) => button.addEventListener('click', () => {
      userFilters.role = button.dataset.userRoleFilter;
      renderUsers();
    }));
    $$('[data-reveal-phone]', root).forEach((button) => button.addEventListener('click', async () => {
      try {
        const result = await api(`/api/admin/users/${encodeURIComponent(button.dataset.revealPhone)}/phone`);
        $$(`[data-phone="${button.dataset.revealPhone}"]`).forEach((element) => {
          element.textContent = result.phone;
          element.classList.add('is-revealed');
        });
        button.disabled = true;
        button.textContent = 'نمایش داده شد';
        toast('شماره نمایش داده شد.', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
    }));
    $$('[data-topup]', root).forEach((button) => button.addEventListener('click', () => openTopup(button.dataset.topup)));
    $$('[data-delete-user]', root).forEach((button) => button.addEventListener('click', () => confirmDeleteUser(button.dataset.deleteUser, button.dataset.userName)));
  }

  function openTopup(userId) {
    const { root, close } = openOverlay(`
      <div class="modal modal--sm" role="dialog" aria-modal="true" aria-label="افزایش موجودی کیف پول">
        <div class="modal__head">
          <div><h2>افزایش موجودی کیف پول</h2><p>مبلغ به کیف پول تبلیغاتی این کاربر اضافه و در تراکنش‌ها ثبت می‌شود.</p></div>
          <button class="icon-button" type="button" data-close aria-label="بستن">${ICONS.close}</button>
        </div>
        <form id="topup-form">
          <div class="modal__body">
            <label class="field"><span>مبلغ (ریال)</span>
              <input class="input" name="amount" inputmode="numeric" type="number" min="1" step="1000" required placeholder="مثلاً 5000000"></label>
            <label class="field"><span>یادداشت (اختیاری)</span>
              <input class="input" name="note" maxlength="180" placeholder="مثلاً شارژ دستی"></label>
          </div>
          <div class="modal__foot">
            <button class="button button--ghost button--sm" type="button" data-close>انصراف</button>
            <button class="button button--primary button--sm" type="submit">افزودن موجودی</button>
          </div>
        </form>
      </div>`);
    $('input', root)?.focus();
    $('#topup-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = $('button[type="submit"]', event.target);
      submit.disabled = true;
      try {
        const result = await api(`/api/admin/users/${encodeURIComponent(userId)}/wallet`, {
          method: 'POST',
          body: {
            amount: Number($('[name="amount"]', event.target)?.value),
            note: $('[name="note"]', event.target)?.value || '',
          },
        });
        $$(`[data-wallet-balance="${userId}"]`).forEach((element) => { element.textContent = faNum(result.wallet.balance); });
        close();
        toast('موجودی افزایش یافت.', 'success');
      } catch (error) {
        toast(error.message, 'error');
        submit.disabled = false;
      }
    });
  }

  function confirmDeleteUser(userId, accountName) {
    const { root, close } = openOverlay(`
      <div class="modal modal--sm" role="dialog" aria-modal="true" aria-label="حذف کامل کاربر">
        <div class="modal__head">
          <div><h2>حذف کامل کاربر</h2><p>این کار برگشت‌پذیر نیست.</p></div>
          <button class="icon-button" type="button" data-close aria-label="بستن">${ICONS.close}</button>
        </div>
        <form id="delete-user-form">
          <div class="modal__body">
            <p style="margin:0;line-height:1.95;color:var(--subdued);font-size:12.5px">«${esc(accountName)}» با همه داده‌هایش پاک می‌شود: کیف پول، تراکنش‌ها، علاقه‌مندی‌ها، پیشرفت تماشا، تاریخچه دانلود، کدهای ورود و کمپین‌های تبلیغاتی.</p>
            <label class="field"><span>برای تأیید، نام کاربر را دقیقاً بنویسید</span>
              <input class="input" name="confirm" autocomplete="off" placeholder="${esc(accountName)}"></label>
          </div>
          <div class="modal__foot">
            <button class="button button--ghost button--sm" type="button" data-close>انصراف</button>
            <button class="button button--danger button--sm" type="submit">حذف قطعی</button>
          </div>
        </form>
      </div>`);
    $('#delete-user-form', root).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (String($('[name="confirm"]', event.target)?.value || '').trim() !== String(accountName).trim()) {
        toast('نام کاربر را دقیقاً وارد کنید.', 'error');
        return;
      }
      const submit = $('button[type="submit"]', event.target);
      submit.disabled = true;
      try {
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
        close();
        toast('کاربر حذف شد.', 'success');
        renderUsers();
      } catch (error) {
        toast(error.message, 'error');
        submit.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------------ ads */
  async function renderAds() {
    const root = $('#view-root');
    root.innerHTML = '<section class="view"><div class="skeleton" style="height:260px"></div></section>';
    const data = await api('/api/admin/ads');
    const rows = data.items.length ? data.items.map((ad) => `<tr>
      <td><strong>${esc(ad.campaign_name || ad.campaign)}</strong><div class="muted">${esc(ad.headline || ad.advertiser || '')}</div></td>
      <td>${esc(ad.advertiser || ad.account_name || '—')}</td>
      <td><span class="tag">${esc(ad.placement)}</span></td>
      <td>${faNum(ad.budget)}</td>
      <td><span class="status-badge status-badge--${esc(ad.status)}">${statusLabel(ad.status)}</span></td>
      <td><select class="select" style="height:34px;min-width:120px" data-ad-status="${esc(ad.public_id || ad.id)}">
        ${['pending', 'active', 'paused', 'completed', 'rejected'].map((status) => `<option value="${status}" ${ad.status === status ? 'selected' : ''}>${statusLabel(status)}</option>`).join('')}
      </select></td>
    </tr>`).join('') : '<tr><td colspan="6" class="muted">کمپینی وجود ندارد.</td></tr>';

    root.innerHTML = `<section class="view">
      <div class="page-head"><div><h1>تبلیغات</h1><p>بررسی و تغییر وضعیت کمپین‌ها</p></div></div>
      <div class="panel"><div class="panel__body" style="padding-top:16px">
        <div class="table-wrap"><table class="data">
          <thead><tr><th>کمپین</th><th>تبلیغ‌دهنده</th><th>جایگاه</th><th>بودجه (ریال)</th><th>وضعیت</th><th>تغییر</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div></div>
    </section>`;
  }

  /* ---------------------------------------------------- ad settings page */
  const adState = { group: 'video', tab: 'overview', settings: null, placements: [], dashboard: null, campaigns: [], policy: null, groups: [] };

  function adNumberField(key, label, hint, value, { step = 1, min = 0, max = 1000000, suffix = '' } = {}) {
    return `<label class="ad-field">
      <span>${esc(label)}</span>
      <div class="ad-input">
        <input class="input" type="number" step="${step}" min="${min}" max="${max}" data-ad-setting="${esc(key)}" value="${esc(value)}">
        ${suffix ? `<i>${esc(suffix)}</i>` : ''}
      </div>
      ${hint ? `<small>${esc(hint)}</small>` : ''}
    </label>`;
  }

  function adToggleField(key, label, hint, on) {
    return `<label class="ad-field ad-field--toggle">
      <div><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</div>
      <input type="checkbox" class="switch" data-ad-setting="${esc(key)}" ${on ? 'checked' : ''}>
    </label>`;
  }

  function placementCard(slot) {
    const live = slot.enabled && slot.active !== false;
    return `<article class="slot-card ${live ? 'is-on' : 'is-off'}" data-slot="${esc(slot.placement)}">
      <header class="slot-card__head">
        <div><strong>${esc(slot.label)}</strong><span class="slot-tag slot-tag--${esc(slot.group)}">${slot.group === 'video' ? 'ویدیویی' : slot.group === 'banner' ? 'بنری' : 'لینکی'}</span></div>
        <button type="button" class="switch switch--button ${live ? 'is-on' : ''}" role="switch" aria-checked="${live ? 'true' : 'false'}"
          data-slot-toggle="${esc(slot.placement)}" aria-label="روشن یا خاموش کردن ${esc(slot.label)}"><i></i></button>
      </header>
      <div class="slot-card__body">
        <label class="ad-field ad-field--compact"><span>CPM (تومان هر ۱۰۰۰ نمایش)</span>
          <input class="input" type="number" min="0" step="1000" data-slot-price="${esc(slot.placement)}" value="${esc(Math.round(slot.cpm / 10))}"></label>
        <label class="ad-field ad-field--compact"><span>حداقل بودجه (تومان)</span>
          <input class="input" type="number" min="0" step="1000" data-slot-min="${esc(slot.placement)}" value="${esc(Math.round(slot.minBudget / 10))}"></label>
        ${slot.group === 'link' ? '' : `<label class="ad-field ad-field--compact"><span>مدت نمایش (ثانیه)</span>
          <input class="input" type="number" min="0" max="120" step="1" data-slot-duration="${esc(slot.placement)}" value="${esc(slot.durationSeconds)}">
          <small>${slot.group === 'banner' ? 'چند ثانیه بنر روی پلیر بماند' : 'چند ثانیه تبلیغ پخش شود؛ کاربر از ثانیه مشخص‌شده می‌تواند رد کند'}</small></label>`}
      </div>
      <footer class="slot-card__foot">
        <button class="button button--ghost button--xs" type="button" data-slot-save="${esc(slot.placement)}">ذخیره</button>
        <span class="slot-status">${live ? 'روشن — تبلیغ سرو می‌شود' : 'خاموش — هیچ تبلیغی سرو نمی‌شود'}</span>
      </footer>
    </article>`;
  }

  function campaignRow(campaign) {
    const statusLabels = { pending: 'در انتظار بررسی', active: 'فعال', paused: 'متوقف', rejected: 'ردشده', completed: 'پایان‌یافته' };
    const thumb = campaign.assetType === 'video'
      ? `<video src="${esc(safeUrl(campaign.creativeUrl))}" muted preload="metadata"></video>`
      : `<img src="${esc(safeUrl(campaign.creativeUrl))}" alt="" loading="lazy">`;
    return `<article class="ad-row" data-campaign="${esc(campaign.id)}">
      <div class="ad-row__thumb">${thumb}${campaign.ownerCampaign ? '<span class="ad-row__owner">مالک</span>' : ''}</div>
      <div class="ad-row__main">
        <div class="ad-row__title"><strong>${esc(campaign.headline || campaign.campaignName)}</strong>
          <span class="status-badge status-badge--${campaign.status === 'active' ? 'published' : campaign.status === 'pending' ? 'draft' : campaign.status === 'rejected' ? 'archived' : 'draft'}">${statusLabels[campaign.status] || campaign.status}</span></div>
        <div class="ad-row__meta">
          <span>${esc(campaign.group === 'video' ? 'ویدیویی' : campaign.group === 'banner' ? 'بنری' : 'لینکی')} · ${esc(campaign.placement)}</span>
          <span>${esc(campaign.advertiser || '')}</span>
          <span>${faNum(campaign.impressions || 0)} نمایش · ${faNum(campaign.clicks || 0)} کلیک</span>
          ${campaign.ownerCampaign ? '<span>بدون کسر کیف پول</span>' : `<span>${faNum(Math.round(Number(campaign.budget || 0) / 10))} تومان بودجه</span>`}
        </div>
        ${campaign.reviewNote ? `<p class="ad-row__note">${esc(campaign.reviewNote)}</p>` : ''}
      </div>
      <div class="ad-row__actions">
        ${campaign.status === 'pending' ? `<button class="button button--primary button--xs" type="button" data-ad-review="active" data-ad-id="${esc(campaign.id)}">تأیید</button>
          <button class="button button--danger button--xs" type="button" data-ad-review="rejected" data-ad-id="${esc(campaign.id)}">رد</button>` : ''}
        ${campaign.status === 'active' ? `<button class="button button--ghost button--xs" type="button" data-ad-review="paused" data-ad-id="${esc(campaign.id)}">توقف</button>` : ''}
        ${campaign.status === 'paused' ? `<button class="button button--ghost button--xs" type="button" data-ad-review="active" data-ad-id="${esc(campaign.id)}">فعال‌سازی</button>` : ''}
      </div>
    </article>`;
  }

  function adTabMarkup() {
    const data = adState;
    if (data.tab === 'overview') {
      const totals = data.dashboard?.totals || {};
      const cards = [
        ['کمپین فعال', totals.active], ['در انتظار بررسی', totals.pending],
        ['کمپین‌های مالک', totals.ownerCampaigns], ['بودجه مصرف‌شده', faNum(Math.round(Number(totals.spent || 0) / 10)) + ' تومان'],
        ['نمایش ۳۰ روز', totals.impressions], ['کلیک ۳۰ روز', totals.clicks],
        ['موجودی کیف پول‌ها', faNum(Math.round(Number(totals.walletBalance || 0) / 10)) + ' تومان'],
      ];
      return `<div class="ad-kpis">${cards.map(([label, value]) => `<div class="ad-kpi"><span>${esc(label)}</span><b>${typeof value === 'number' ? faNum(value) : esc(value)}</b></div>`).join('')}</div>
        <div class="ad-groups">${(data.dashboard?.byGroup || []).map((group) => `
          <div class="ad-group-row">
            <div><strong>${esc(group.label)}</strong><span>${faNum(group.active)} فعال از ${faNum(group.campaigns)} کمپین</span></div>
            <div class="meter meter--amber"><i style="width:${Math.min(100, group.campaigns ? Math.round((group.active / group.campaigns) * 100) : 0)}%"></i></div>
            <b>${faNum(Math.round(Number(group.spent || 0) / 10))} تومان</b>
          </div>`).join('')}</div>`;
    }
    if (data.tab === 'review') {
      const pending = data.campaigns.filter((ad) => ad.status === 'pending');
      return `<div class="ad-list">${pending.length ? pending.map(campaignRow).join('') : '<div class="empty-state"><strong>صف بررسی خالی است</strong><p>همه کمپین‌ها بررسی شده‌اند.</p></div>'}</div>`;
    }
    if (data.tab === 'campaigns') {
      return `<div class="ad-toolbar">
          <div class="segmented" role="group"><button class="is-active" data-ad-owner="">همه</button><button data-ad-owner="owner">مالک</button><button data-ad-owner="users">کاربران</button></div>
        </div>
        <div class="ad-list">${data.campaigns.length ? data.campaigns.map(campaignRow).join('') : '<div class="empty-state"><strong>کمپینی وجود ندارد</strong></div>'}</div>`;
    }
    if (data.tab === 'owner') {
      return `<div class="ad-owner">
        <div class="panel"><div class="panel__head"><div><h2>کمپین مالک</h2><p>بدون کسر از کیف پول، فوراً فعال؛ فقط جایگاه باید روشن باشد</p></div></div>
          <div class="panel__body">
            <form id="owner-ad-form">
              <div class="grid-2">
                <label class="field"><span>نام کمپین</span><input class="input" name="campaignName" required minlength="3" maxlength="180" placeholder="مثلاً معرفی فیلم‌ورک پلاس"></label>
                <label class="field"><span>عنوان نمایشی</span><input class="input" name="headline" required minlength="3" maxlength="180" placeholder="مثلاً فیلم‌ورک پلاس را امتحان کنید"></label>
              </div>
              <label class="field"><span>جایگاه</span><select class="select" name="placement">
                ${data.placements.filter((slot) => slot.group === adState.group && slot.enabled).map((slot) => `<option value="${esc(slot.placement)}">${esc(slot.label)}</option>`).join('') || '<option value="">جایگاه روشنی نیست</option>'}
              </select></label>
              <div class="grid-2">
                <label class="field"><span>فایل تبلیغ (آپلود)</span><input class="input" type="file" name="creative" accept="video/mp4,video/webm,image/jpeg,image/png,image/webp"></label>
                <label class="field"><span>یا لینک فایل</span><input class="input" dir="ltr" name="creativeUrl" placeholder="https://cdn.example.com/ad.mp4"></label>
              </div>
              <div class="grid-2">
                <label class="field"><span>لینک مقصد</span><input class="input" dir="ltr" name="targetUrl" placeholder="https://example.com"></label>
                <label class="field"><span>مدت نمایش (ثانیه)</span><input class="input" type="number" name="durationSeconds" min="0" max="120" value="${esc(data.policy?.defaultVideoDuration || 15)}"></label>
              </div>
              <div class="grid-2">
                <label class="field"><span>شروع</span><input class="input" type="datetime-local" name="startsAt"></label>
                <label class="field"><span>پایان</span><input class="input" type="datetime-local" name="endsAt"></label>
              </div>
              <div class="form-actions"><button class="button button--primary" type="submit">ساخت و فعال‌سازی</button></div>
            </form>
          </div></div>
        <div class="ad-list">${data.campaigns.filter((ad) => ad.ownerCampaign).map(campaignRow).join('') || '<p class="muted" style="font-size:12px">هنوز کمپین مالک ساخته نشده است.</p>'}</div>
      </div>`;
    }
    // settings tab
    const settings = data.settings || {};
    return `<div class="ad-settings">
      <article class="panel"><div class="panel__head"><div><h2>جایگاه‌ها</h2><p>هر جایگاه با یک دکمه روشن یا خاموش می‌شود؛ خاموش یعنی هیچ تبلیغی در آن سرو نمی‌شود</p></div></div>
        <div class="panel__body">
          <div class="segmented ad-group-tabs">${data.groups.map((group) => `<button class="${adState.group === group.group ? 'is-active' : ''}" data-ad-group="${group.group}">${group.label}</button>`).join('')}</div>
          <p class="muted ad-group-hint">${esc((data.groups.find((group) => group.group === adState.group) || {}).hint || '')}</p>
          <div class="slot-grid">${data.placements.filter((slot) => slot.group === adState.group).map(placementCard).join('')}</div>
        </div></article>

      <article class="panel"><div class="panel__head"><div><h2>قواعد عمومی</h2><p>این مقادیر روی فرم تبلیغ‌دهنده و سرو شدن تبلیغ اثر می‌گذارند</p></div>
        <button class="button button--primary button--sm" type="button" data-ad-save>ذخیره تنظیمات</button></div>
        <div class="panel__body">
          ${adToggleField('ads.auto_approve', 'تأیید خودکار کمپین‌ها', 'اگر روشن باشد، کمپین کاربران بدون بررسی فعال می‌شود', settings['ads.auto_approve'] === '1')}
          <div class="ad-fields">
            ${adNumberField('ads.default_video_duration', 'مدت نمایش ویدیو', 'مدت پیش‌فرض ویدیو در پلیر', settings['ads.default_video_duration'], { suffix: 'ثانیه' })}
            ${adNumberField('ads.default_banner_duration', 'مدت نمایش بنر', 'چند ثانیه بنر روی پلیر بماند', settings['ads.default_banner_duration'], { suffix: 'ثانیه' })}
            ${adNumberField('ads.skip_after_seconds', 'دکمه رد کردن پس از', 'کاربر بعد از این مدت می‌تواند تبلیغ را رد کند', settings['ads.skip_after_seconds'], { suffix: 'ثانیه' })}
            ${adNumberField('ads.min_video_seconds', 'حداقل مدت ویدیو', '', settings['ads.min_video_seconds'], { suffix: 'ثانیه' })}
            ${adNumberField('ads.max_video_seconds', 'حداکثر مدت ویدیو', '', settings['ads.max_video_seconds'], { suffix: 'ثانیه' })}
            ${adNumberField('ads.max_video_mb', 'حداکثر حجم ویدیو', '', settings['ads.max_video_mb'], { suffix: 'MB' })}
            ${adNumberField('ads.max_image_kb', 'حداکثر حجم تصویر', '', settings['ads.max_image_kb'], { suffix: 'KB' })}
            ${adNumberField('ads.reject_purge_minutes', 'پاک‌سازی فایل ردشده پس از', 'فایل آپلودی کمپین ردشده حداکثر بعد از این مدت از هاست حذف می‌شود', settings['ads.reject_purge_minutes'], { suffix: 'دقیقه' })}
          </div>
          <h3 class="ad-sub">تعرفه‌ها (تومان)</h3>
          <div class="ad-fields">
            ${adNumberField('ads.cpm_video', 'CPM ویدیویی', 'هزینه هر ۱۰۰۰ نمایش', settings['ads.cpm_video'])}
            ${adNumberField('ads.cpm_banner', 'CPM بنری', '', settings['ads.cpm_banner'])}
            ${adNumberField('ads.cpm_link', 'CPM لینکی', '', settings['ads.cpm_link'])}
            ${adNumberField('ads.cpc_link', 'CPC لینکی', 'هزینه هر کلیک', settings['ads.cpc_link'])}
            ${adNumberField('ads.min_budget', 'حداقل بودجه کمپین', '', settings['ads.min_budget'])}
            ${adNumberField('ads.daily_budget_cap', 'سقف هزینه روزانه', '۰ = بدون سقف', settings['ads.daily_budget_cap'])}
            ${adNumberField('ads.max_priority_multiplier', 'حداکثر ضریب پیشنهاد', 'سقف ضریب اولویت روی تعرفه پایه', settings['ads.max_priority_multiplier'], { step: 0.5 })}
          </div>
          <label class="field"><span>فهرست دامنه‌های مجاز لینک</span>
            <textarea class="textarea" rows="3" data-ad-setting="ads.link_allowlist" placeholder="مثلاً t.me، instagram.com — خالی یعنی همه دامنه‌ها مجازند">${esc(settings['ads.link_allowlist'] || '')}</textarea></label>
          <label class="field"><span>قوانین تبلیغات (متن نمایش‌داده‌شده به تبلیغ‌دهنده)</span>
            <textarea class="textarea" rows="6" data-ad-setting="ads.rules" placeholder="قوانین محتوا، ممنوعیت‌ها و شرایط بازگشت بودجه">${esc(settings['ads.rules'] || '')}</textarea></label>
          <div class="form-actions"><button class="button button--primary" type="button" data-ad-save>ذخیره تنظیمات</button></div>
        </div></article>
    </div>`;
  }

  async function renderAdSettings() {
    const root = $('#view-root');
    root.innerHTML = '<section class="view"><div class="skeleton" style="height:300px"></div></section>';
    const [config, dashboard, campaigns] = await Promise.all([
      api('/api/admin/ads/settings'),
      api('/api/admin/ads/dashboard'),
      api('/api/admin/ads/campaigns'),
    ]);
    adState.settings = config.settings;
    adState.placements = config.placements || [];
    adState.groups = config.groups || [];
    adState.policy = config.policy;
    adState.dashboard = dashboard;
    adState.campaigns = campaigns.items || [];
    paintAdSettings();
  }

  function paintAdSettings() {
    const root = $('#view-root');
    const tabs = [
      ['overview', 'نمای کلی'], ['settings', 'جایگاه‌ها و قواعد'], ['review', `صف بررسی${adState.campaigns.filter((ad) => ad.status === 'pending').length ? ` (${faNum(adState.campaigns.filter((ad) => ad.status === 'pending').length)})` : ''}`],
      ['campaigns', 'همه کمپین‌ها'], ['owner', 'کمپین مالک'],
    ];
    root.innerHTML = `<section class="view">
      <div class="page-head"><div><h1>تنظیمات تبلیغات</h1><p>جایگاه‌ها، تعرفه‌ها، تأیید کمپین کاربران و کمپین‌های خودتان</p></div></div>
      <div class="ad-tabs">${tabs.map(([key, label]) => `<button class="${adState.tab === key ? 'is-active' : ''}" data-ad-tab="${key}">${label}</button>`).join('')}</div>
      <div id="ad-body">${adTabMarkup()}</div>
    </section>`;
  }

  document.addEventListener('click', async (event) => {
    const tab = event.target.closest('[data-ad-tab]');
    if (tab) {
      adState.tab = tab.dataset.adTab;
      paintAdSettings();
      return;
    }
    const group = event.target.closest('[data-ad-group]');
    if (group) {
      adState.group = group.dataset.adGroup;
      paintAdSettings();
      return;
    }
    const toggle = event.target.closest('[data-slot-toggle]');
    if (toggle) {
      const placement = toggle.dataset.slotToggle;
      const next = !toggle.classList.contains('is-on');
      toggle.disabled = true;
      try {
        const result = await api(`/api/admin/ads/placements/${encodeURIComponent(placement)}`, { method: 'PATCH', body: { enabled: next } });
        adState.placements = result.placements;
        toast(next ? 'جایگاه روشن شد.' : 'جایگاه خاموش شد.', 'success');
        paintAdSettings();
      } catch (error) {
        toggle.disabled = false;
        toast(error.message, 'error');
      }
      return;
    }
    const saveSlot = event.target.closest('[data-slot-save]');
    if (saveSlot) {
      const placement = saveSlot.dataset.slotSave;
      const body = {
        pricePerThousand: Number($(`[data-slot-price="${placement}"]`)?.value || 0) * 10,
        minimumBudget: Number($(`[data-slot-min="${placement}"]`)?.value || 0) * 10,
      };
      const duration = $(`[data-slot-duration="${placement}"]`);
      if (duration) body.durationSeconds = Number(duration.value || 0);
      saveSlot.disabled = true;
      try {
        const result = await api(`/api/admin/ads/placements/${encodeURIComponent(placement)}`, { method: 'PATCH', body });
        adState.placements = result.placements;
        toast('جایگاه ذخیره شد.', 'success');
        paintAdSettings();
      } catch (error) {
        saveSlot.disabled = false;
        toast(error.message, 'error');
      }
      return;
    }
    if (event.target.closest('[data-ad-save]')) {
      const settings = {};
      $$('[data-ad-setting]').forEach((input) => {
        settings[input.dataset.adSetting] = input.type === 'checkbox' ? (input.checked ? '1' : '0') : input.value;
      });
      try {
        const result = await api('/api/admin/ads/settings', { method: 'PATCH', body: { settings } });
        adState.settings = result.settings;
        adState.policy = result.policy;
        toast('تنظیمات ذخیره شد.', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const review = event.target.closest('[data-ad-review]');
    if (review) {
      const status = review.dataset.adReview;
      if (status === 'rejected' && !(await confirmDialog({
        title: 'رد کمپین',
        message: 'با رد کمپین، بودجه مصرف‌نشده به کیف پول برمی‌گردد و فایل آپلودی از هاست پاک می‌شود.',
        confirmLabel: 'رد کن',
      }))) return;
      review.disabled = true;
      try {
        const result = await api(`/api/admin/ads/campaigns/${encodeURIComponent(review.dataset.adId)}/review`, { method: 'POST', body: { status } });
        toast(status === 'active' ? 'کمپین تأیید شد.' : status === 'rejected' ? 'کمپین رد شد و فایل پاک شد.' : 'وضعیت تغییر کرد.', 'success');
        if (result.creativePurged) toast('فایل آپلودی از هاست حذف شد.', 'success');
        await renderAdSettings();
        adState.tab = 'review';
        paintAdSettings();
      } catch (error) {
        review.disabled = false;
        toast(error.message, 'error');
      }
      return;
    }
    const ownerFilter = event.target.closest('[data-ad-owner]');
    if (ownerFilter) {
      $$('[data-ad-owner]').forEach((button) => button.classList.toggle('is-active', button === ownerFilter));
      const data = await api(`/api/admin/ads/campaigns${ownerFilter.dataset.adOwner ? `?owner=${ownerFilter.dataset.adOwner}` : ''}`);
      adState.campaigns = data.items || [];
      $('#ad-body').innerHTML = adTabMarkup();
    }
  });

  document.addEventListener('submit', async (event) => {
    if (event.target.id !== 'owner-ad-form') return;
    event.preventDefault();
    const form = event.target;
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      const body = new FormData(form);
      const response = await fetch('/api/admin/ads/campaigns', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': state.csrf },
        body,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || 'ثبت کمپین ناموفق بود.');
      toast('کمپین مالک فعال شد.', 'success');
      await renderAdSettings();
      adState.tab = 'owner';
      paintAdSettings();
    } catch (error) {
      toast(error.message, 'error');
      submit.disabled = false;
    }
  });

  /* --------------------------------------------------------------- deploy */
  const DEPLOY_SNIPPETS = {
    'deploy-manual': 'cd ~/filmwork && git fetch origin && git reset --hard origin/main',
    'deploy-css': 'cd ~/filmwork/backend && npm run build:css',
    'deploy-restart': 'mkdir -p ~/filmwork/backend/tmp && touch ~/filmwork/backend/tmp/restart.txt',
  };

  async function renderDeploy() {
    window.__guideCodes = { ...(window.__guideCodes || {}), ...DEPLOY_SNIPPETS };
    const root = $('#view-root');
    root.innerHTML = '<section class="view"><div class="skeleton" style="height:260px"></div></section>';
    const status = await api('/api/admin/deploy/status');
    const upstream = status.upstream;
    const lastRun = status.lastResult;
    const changedFiles = (lastRun?.files || []);
    root.innerHTML = `<section class="view">
      <div class="page-head"><div><h1>به‌روزرسانی از گیت‌هاب</h1><p>هر تغییری که در گیت‌هاب می‌دهید، از همین صفحه روی هاست اعمال می‌شود؛ لازم نیست فایل‌ها را با File Manager عوض کنید</p></div></div>
      ${status.configured ? '' : `<div class="callout callout--warn">${ICONS.warn}<span>برای فعال شدن این صفحه، در <code>.env</code> مقدار <code>GITHUB_REPO=Atliner/filmwork</code> را بگذارید (برای ریپوی خصوصی <code>GITHUB_TOKEN</code> هم لازم است) و سرویس Node را یک‌بار ری‌استارت کنید.</span></div>`}
      <div class="deploy-grid">
        <article class="panel"><div class="panel__head"><div><h2>وضعیت</h2><p>مخزن و شاخه‌ای که روی هاست اعمال می‌شود</p></div></div>
          <div class="panel__body deploy-meta">
            <div><span>ریپازیتوری</span><b dir="ltr">${esc(status.repo || '—')}</b></div>
            <div><span>شاخه</span><b dir="ltr">${esc(status.branch || '—')}</b></div>
            <div><span>آخرین دریافت</span><b>${status.lastRunAt ? faDate(status.lastRunAt) : 'هنوز اجرا نشده'}</b></div>
            ${upstream ? `<div><span>آخرین کامیت گیت‌هاب</span><b dir="ltr" style="font-size:11px">${esc(upstream.sha.slice(0, 7))}</b></div>
              <div style="grid-column:1/-1"><span>پیام کامیت</span><p style="margin:2px 0 0;font-size:12px;line-height:1.9">${esc(upstream.message.split('\n')[0])}</p></div>` : ''}
          </div>
        </article>
        <article class="panel"><div class="panel__head"><div><h2>دریافت و اعمال</h2><p>فقط <code>backend/</code>، <code>frontend/</code> و <code>database/</code> به‌روز می‌شوند</p></div></div>
          <div class="panel__body">
            <p class="muted" style="font-size:12px;line-height:1.95;margin:0 0 12px">فایل‌های <code>.env</code>، <code>node_modules</code> و <code>uploads</code> دست‌نخورده می‌مانند. اول یک «پیش‌نمایش» بگیرید تا ببینید چه چیزی تغییر می‌کند، بعد اعمال کنید. اگر <code>frontend/tailwind.css</code> تغییر کرده باشد، بعد از اعمال باید یک‌بار <code>npm run build:css</code> را روی هاست اجرا کنید.</p>
            <label class="field"><span>شاخه</span><input class="input" dir="ltr" data-deploy-branch value="${esc(status.branch || 'main')}"></label>
            <div class="form-actions" style="justify-content:flex-start">
              <button class="button button--ghost" type="button" data-deploy-preview ${status.configured ? '' : 'disabled'}>پیش‌نمایش تغییرات</button>
              <button class="button button--primary" type="button" data-deploy-run ${status.configured ? '' : 'disabled'}>اعمال روی هاست</button>
            </div>
            <div id="deploy-result" aria-live="polite"></div>
          </div>
        </article>
      </div>
      ${changedFiles.length ? `<article class="panel" style="margin-top:14px"><div class="panel__head"><div><h2>آخرین تغییرات اعمال‌شده</h2><p>${faNum(changedFiles.length)} فایل</p></div></div>
        <div class="panel__body"><div class="deploy-files">${changedFiles.slice(0, 60).map((file) => `<span class="deploy-file deploy-file--${file.status}"><i dir="ltr">${esc(file.path)}</i><b>${file.status === 'added' ? 'جدید' : 'به‌روز'}</b></span>`).join('')}</div></div></article>` : ''}
      <details class="callout callout--fold">
        <summary>${ICONS.warn} به‌روزرسانی دستی (وقتی سرور به گیت‌هاب دسترسی ندارد)</summary>
        <div style="padding:10px 0 2px">
          <p style="margin:0 0 8px;font-size:12px;line-height:1.95">اگر دکمه بالا خطای دسترسی داد، در cPanel → <b>Terminal</b> (یا SSH) این سه خط را بزنید؛ فقط کد برنامه را به‌روز می‌کند و به <code>.env</code>، <code>node_modules</code> یا <code>uploads</code> دست نمی‌زند:</p>
          ${CODE('cd ~/filmwork && git fetch origin && git reset --hard origin/main', 'deploy-manual')}
          <p style="margin:8px 0;font-size:12px;line-height:1.95">اگر فقط استایل‌ها (CSS) تغییر کرده‌اند:</p>
          ${CODE('cd ~/filmwork/backend && npm run build:css', 'deploy-css')}
          <p style="margin:8px 0 0;font-size:12px;line-height:1.95">برای فعال شدن کد جدید، سرویس Node را از «Setup Node.js App» ری‌استارت کنید، یا در SSH:</p>
          ${CODE('mkdir -p ~/filmwork/backend/tmp && touch ~/filmwork/backend/tmp/restart.txt', 'deploy-restart')}
        </div>
      </details>
      <div class="callout">${ICONS.info}<span>بعد از اعمال تغییرات، سرویس Node را از cPanel («Setup Node.js App» → Restart) ری‌استارت کنید تا نسخه جدید فعال شود.</span></div>
    </section>`;

    const run = async (dryRun) => {
      const box = $('#deploy-result');
      box.innerHTML = '<p class="muted" style="font-size:12px;margin-top:12px">در حال دریافت از گیت‌هاب…</p>';
      try {
        const result = await api('/api/admin/deploy/github', {
          method: 'POST',
          body: { branch: $('[data-deploy-branch]')?.value?.trim() || undefined, dryRun },
        });
        const files = result.files || [];
        box.innerHTML = `<div class="deploy-outcome">
          <strong>${dryRun ? 'پیش‌نمایش' : 'اعمال شد'} · ${faNum(files.length)} فایل ${dryRun ? 'تغییر می‌کند' : 'به‌روزرسانی شد'}</strong>
          <span class="muted" dir="ltr">${esc(result.sha.slice(0, 7))}</span>
          ${files.length ? `<div class="deploy-files">${files.slice(0, 80).map((file) => `<span class="deploy-file deploy-file--${file.status}"><i dir="ltr">${esc(file.path)}</i><b>${file.status === 'added' ? 'جدید' : 'به‌روز'}</b></span>`).join('')}</div>` : '<p class="muted" style="font-size:12px">همه فایل‌ها از قبل به‌روز بودند.</p>'}
          ${result.cssNeedsBuild ? '<p class="muted" style="font-size:12px">استایل‌ها تغییر کرده‌اند: روی هاست <code>cd backend &amp;&amp; npm run build:css</code> را اجرا کنید (یا <code>frontend/styles.css</code> را هم از گیت‌هاب بگیرید).</p>' : ''}
          ${result.restartRequired && !dryRun ? '<p class="muted" style="font-size:12px">برای فعال شدن کد جدید، سرویس Node را ری‌استارت کنید.</p>' : ''}
        </div>`;
      } catch (error) {
        box.innerHTML = `<p style="color:#fca5a5;font-size:12px;margin-top:12px">${esc(error.message)}</p>`;
      }
    };
    $('[data-deploy-preview]', root)?.addEventListener('click', () => run(true));
    $('[data-deploy-run]', root)?.addEventListener('click', () => run(false));
  }

  /* ---------------------------------------------------------------- guide */
  const CODE = (text, id) => `<div class="code-block">${esc(text)}<button class="copy" type="button" data-copy="${id}">کپی</button></div>`;

  function renderGuide() {
    const root = $('#view-root');
    const addCopyTargets = {
      'guide-github': 'GITHUB_REPO=Atliner/filmwork\nGITHUB_BRANCH=main',
      'post-sample': `🎬 #سریال | امتیاز: 8.9

▪️ نام فارسی: پیت
▪️ نام انگلیسی: The Pitt

⭐️ امتیاز: 8.9 از 10 (172K رای)
📢 وضعیت پخش: اتمام پخش
📅 سال تولید: 2025 - 2026
⏱️ مدت زمان: میانگین 50 دقیقه هر قسمت
🔞 رده سنی: +18

🎭 ژانر: پزشکی، درام، روان‌شناختی
📼 شبکه: HBO Max
🌐 محصول کشور: آمریکا
🎬 کارگردان: دامین مارکانو، جان ولز | Damian Marcano, John Wells
👥 ستارگان: نوآ وایلی، پاتریک بال | Noah Wyle, Patrick Ball

📝 خلاصه داستان: با بازگشت دکتر لنگدن به اورژانس، رابطه او با رابینوویچ پرتنش می‌شود.

📥 برای دانلود سریال کلیک کنید
📌 @Vizosten`,

      'directive': `#اثر 5f0c8f1e-3d4b-4c6a-9a7e-2b1d9c4f7a10 #نسخه DigiMovies #نوع دوبله #زیرنویس مجزا #رزولوشن 1080p #سریال S01.E07 #کیفیت WEB-DL #انکودر x265`,
      'directive-movie': `#اثر 5f0c8f1e-3d4b-4c6a-9a7e-2b1d9c4f7a10 #نسخه DigiMovies #نوع دوبله #زیرنویس داخلی #رزولوشن 1080p #کیفیت WEB-DL #انکودر x265`,
      'env': `DEMO_DATA=0
ADMIN_BOT_TOKEN=123456789:AA...
ADMIN_OWNER_IDS=123456789
ADMIN_SOURCE_CHAT_ID=-1001234567890
TELEGRAM_PRIMARY_CHAT_ID=-1001234567890
TELEGRAM_FALLBACK_1_CHAT_ID=-1002234567890
TELEGRAM_FALLBACK_2_CHAT_ID=-1003234567890`,
      'migrate': `mysql -u USER -p DATABASE < database/migrations/2026-11-owner-console-v2.sql`,
    };
    window.__guideCodes = addCopyTargets;

    root.innerHTML = `<section class="view">
      <div class="page-head"><div><h1>راهنمای ربات و لینک‌ها</h1>
        <p>همه فیلدهای این پنل به‌صورت خودکار پر می‌شوند: مشخصات از متن/لینک پست، لینک‌ها از ربات تلگرام.</p></div></div>

      <div class="guide">
        <details open>
          <summary>۱. ورود امن به پنل</summary>
          <div class="guide__body">
            <ol>
              <li>ربات خصوصی مدیریت را در تلگرام باز کنید (همان توکن <code>ADMIN_BOT_TOKEN</code>).</li>
              <li>دستور <code>/panel</code> را بفرستید.</li>
              <li>روی دکمه «ورود به پنل مالک» بزنید؛ پیوند یک‌بارمصرف و پنج‌دقیقه‌ای است.</li>
            </ol>
            <div class="callout callout--warn">${ICONS.warn}<span>این کنسول هرگز به‌صورت عمومی سرو نمی‌شود؛ بدون جلسه معتبر پاسخ ۴۰۴ می‌گیرید. شناسه عددی خود را در <code>ADMIN_OWNER_IDS</code> قرار دهید.</span></div>
          </div>
        </details>

        <details>
          <summary>۲. قالب پست تلگرام برای خواندن خودکار مشخصات</summary>
          <div class="guide__body">
            <p>پست را در کانال عمومی بگذارید یا متنش را در مرحله ۱ پنل بچسبانید. هر خط باید به شکل «برچسب: مقدار» باشد. برچسب‌های پشتیبانی‌شده:</p>
            ${CODE(addCopyTargets['post-sample'], 'post-sample')}
            <div class="callout">${ICONS.info}<span>خواندن پست سخت‌گیر نیست: بولت‌ها و ایموجی ابتدای خط (<code>▪️</code>، <code>⏱️</code>، <code>🌐</code>)، برچسب ساده یا پرانتزی، ارقام فارسی، بازه سال (<code>2025 - 2026</code>)، «میانگین ۵۰ دقیقه هر قسمت»، خط تیره‌دار <code>|</code> در لیست بازیگران، هدر <code>#سریال</code> و خط‌های تبلیغاتی انتهایی («برای دانلود کلیک کنید»، <code>@channel</code>) همه مدیریت می‌شوند. نسخه انگلیسی برچسب‌ها هم شناخته می‌شود: <code>Title</code>، <code>Type</code>، <code>Year</code>، <code>Genre</code>، <code>Director</code>، <code>Cast</code>، <code>Country</code>، <code>Age rating</code>، <code>Network</code>، <code>IMDb</code>، <code>Runtime</code>، <code>Quality</code>، <code>Description</code>.</span></div>
            <div class="callout callout--warn">${ICONS.info}<span>اگر پست درباره دوبله یا زیرنویس چیزی نگوید، هیچ نسخه‌ای خودکار ساخته نمی‌شود؛ در مرحله ۳ با دکمه‌های سریع کیفیت، نسخهٔ مورد نظر را بسازید. عبارت‌هایی مثل «دوبله فارسی» یا «زیرنویس چسبیده» در متن، نوع نسخه‌ها را خودکار تعیین می‌کنند.</span></div>
          </div>
        </details>

        <details>
          <summary>۲.۱ دوزبانه بودن سایت و جستجو</summary>
          <div class="guide__body">
            <p style="margin:0 0 8px">هر اثر دو عنوان دارد و سایت هر دو را نشان می‌دهد: عنوان فارسی تیتر اصلی است و عنوان انگلیسی با فونت لاتین زیر آن می‌آید. کارگردان و بازیگران هم در دو خط («فارسی، فارسی» و سپس «English, English») نمایش داده می‌شوند.</p>
            <ul>
              <li>در پنل، نام‌های فارسی و انگلیسی را با یک <code>|</code> از هم جدا کنید: <code>نوآ وایلی، پاتریک بال | Noah Wyle, Patrick Ball</code>.</li>
              <li>کادر جستجوی سایت با یک عبارت، هر دو زبان را می‌گردد: <code>پیت</code> و <code>The Pitt</code> هر دو همان اثر را برمی‌گردانند؛ همچنین نام کارگردان و بازیگر (فارسی یا انگلیسی)، ژانر، کشور، شبکه و رده سنی.</li>
              <li>اگر عنوان فارسی را خالی بگذارید یا اشتباهاً لاتین پر کنید، سایت خودش عنوان لاتین را به‌عنوان تیتر اصلی نشان می‌دهد.</li>
            </ul>
            <div class="callout">${ICONS.info}<span>پس هر دو زبان را همیشه پر کنید؛ اگر فقط یکی ثبت شود، جستجو با زبان دیگر همان اثر را پیدا نمی‌کند.</span></div>
          </div>
        </details>

        <details>
          <summary>۳. ثبت سریال (فصل، قسمت، وضعیت پخش)</summary>
          <div class="guide__body">
            <ul>
              <li><b>سال شروع</b>: سال پخش فصل اول. اگر سریال یک فصل دارد، «سال آخرین فصل» را خالی بگذارید.</li>
              <li><b>وضعیت پخش</b>: در پنل یک کلید دارد. وقتی روشن است، «فصل در حال پخش» و «متن دلخواه» فعال می‌شوند.</li>
              <li>اگر متن دلخواه خالی بماند، خودکار «فصل ۶ — هر هفته قسمت جدید» نوشته می‌شود.</li>
              <li>در ربات، عبارت <code>در حال پخش</code> در پست باعث روشن شدن همین وضعیت می‌شود.</li>
            </ul>
          </div>
        </details>

        <details>
          <summary>۴. ثبت فایل‌ها با ربات و پر شدن خودکار لینک‌ها</summary>
          <div class="guide__body">
            <ol>
              <li>پس از ذخیره محتوا در پنل، شناسه اثر (UUID) را از آدرس یا کارت محتوا بردارید.</li>
              <li>در ربات، دستور زیر را بفرستید تا «نشست دریافت فایل» باز شود:</li>
            </ol>
            ${CODE(addCopyTargets['directive'], 'directive')}
            <p style="margin:0">برای فیلم، بخش <code>#سریال</code> را حذف کنید:</p>
            ${CODE(addCopyTargets['directive-movie'], 'directive-movie')}
            <ul>
              <li><code>#نوع</code>: دوبله / سافت‌ساب / هاردساب / زبان اصلی</li>
              <li><code>#زیرنویس</code>: مجزا (فایل SRT جدا) یا داخلی (چسبیده)</li>
              <li><code>#رزولوشن</code>: 480p / 720p / 1080p / 2160p</li>
              <li>در پست کانال، کلمه «اتمام پخش» یا «پایان یافته» وضعیت پخش را خاموش می‌کند و «در حال پخش/انتشار» روشن.</li>
              <li>ابتدای متن یک دستور، یعنی ربات منتظر فایل ویدیو است (۳۰ دقیقه فرصت).</li>
            </ul>
            <ol start="3">
              <li>فایل ویدیو را بفرستید. ربات آن را در سه کانال ذخیره (Copy) می‌کند و لینک‌ها را در کارت دانلود ثبت می‌کند.</li>
              <li>اگر زیرنویس «مجزا» باشد، بعد از ویدیو ۱۰ ثانیه فرصت دارید فایل SRT/VTT را بفرستید؛ خودکار به همان کارت وصل می‌شود.</li>
            </ol>
            <div class="callout">${ICONS.info}<span>لینک پخش آنلاین و لینک زیرنویس/دوبله در نسخه‌های پنل، از همین پیام‌های کانال خوانده می‌شوند؛ تا زمان دریافت فایل، می‌توانید آن‌ها را دستی هم وارد کنید.</span></div>
          </div>
        </details>

        <details>
          <summary>۵. ساختن نسخه‌ها در پنل (کیفیت‌ها و لینک‌ها)</summary>
          <div class="guide__body">
            <ol>
              <li>در مرحله ۳ پنل، نوع فایل را انتخاب کنید (زیرنویس یا دوبله).</li>
              <li>عنوان کیفیت‌ها را با ویرگول بنویسید: <code dir="ltr">1080p، 720p، 480p</code></li>
              <li>«ایجاد نسخه‌ها» را بزنید؛ برای هر کیفیت یک بلوک با چهار فیلد ساخته می‌شود:
                <b>لینک پخش آنلاین</b>، <b>لینک زیرنویس</b>، <b>لینک دوبله</b>، <b>لینک تلگرام</b>.</li>
              <li>برای سریال، برای هر قسمت یک ردیف با شماره فصل و قسمت اضافه کنید.</li>
              <li>ذخیره کنید؛ نسخه‌ها در صفحه اثر به‌صورت دسته‌بندی زیرنویس/دوبله و کیفیت نمایش داده می‌شوند.</li>
            </ol>
          </div>
        </details>

        <details>
          <summary>۶. بنر هیرو صفحه اصلی و گالری پوستر</summary>
          <div class="guide__body">
            <ul>
              <li>دکمه ستاره روی هر کارت، آن اثر را به بنر هیرو صفحه اصلی می‌برد؛ فقط یک اثر هم‌زمان در هیرو است.</li>
              <li>گالری پوستر (IMPAwards): لینک تصاویر را در مرحله ۲ اضافه کنید و با ستاره، پوستر اصلی را انتخاب کنید.</li>
              <li>لینک پس‌زمینه (backdrop) برای تصویر بزرگ هیرو استفاده می‌شود.</li>
            </ul>
          </div>
        </details>

        <details>
          <summary>۷. راه‌اندازی/به‌روزرسانی روی هاست</summary>
          <div class="guide__body">
            <p style="margin:0">اگر نصب قبلی دارید، فقط مایگریشن جدید را اجرا کنید (ستون‌های اضافه و دو جدول نسخه‌ها می‌سازد):</p>
            ${CODE(addCopyTargets['migrate'], 'migrate')}
            <p style="margin:0">متغیرهای ضروری:</p>
            ${CODE(addCopyTargets['env'], 'env')}
            <div class="callout callout--warn">${ICONS.warn}<span>برای پیش‌نمایش بدون دیتابیس می‌توانید <code>DEMO_DATA=1</code> بگذارید؛ داده‌ها فقط در حافظه ذخیره می‌شوند و با ری‌استارت پاک می‌شوند. روی هاست همیشه آن را صفر بگذارید.</span></div>
          </div>
        </details>

        <details>
          <summary>۸. کاربرها، کیف پول و حذف کامل حساب</summary>
          <div class="guide__body">
            <ul>
              <li><b>نمای کارتی و ردیفی</b>: از دکمه‌های بالای صفحه کاربران بین کارت و جدول جابه‌جا شوید و با فیلتر نقش یا کادر جستجو (نام، نام کاربری، شناسه تلگرام یا ۴ رقم آخر موبایل) کاربر را پیدا کنید.</li>
              <li><b>شماره موبایل</b>: همان شماره‌ای که کاربر در ربات ورود به اشتراک گذاشته است. به‌صورت رمزگذاری‌شده ذخیره می‌شود و در فهرست فقط ماسک‌شده دیده می‌شود؛ با «نمایش شماره» کل شماره باز و در رویدادهای پنل ثبت می‌شود.</li>
              <li><b>پروفایل تلگرام</b>: نام کاربری (یا شناسه عددی) با پیوند <code>t.me/username</code> برای باز کردن مستقیم گفتگو.</li>
              <li><b>افزایش موجودی</b>: دکمه «افزایش موجودی» مبلغ را به کیف پول تبلیغاتی اضافه می‌کند و در تراکنش‌ها با مرجع یکتا ثبت می‌شود؛ حتی اگر کاربر هنوز کیف پول نداشته باشد ساخته می‌شود.</li>
              <li><b>حذف کاربر</b>: با تأیید نام کاربر، حساب و همه داده‌های وابسته (کیف پول، تراکنش‌ها، علاقه‌مندی، پیشرفت تماشا، تاریخچه دانلود، کدهای ورود و کمپین‌های تبلیغاتی) پاک می‌شود. حذف قطعی است.</li>
            </ul>
            <div class="callout callout--warn">${ICONS.warn}<span>حذف کاربر برگشت‌پذیر نیست. اگر فقط می‌خواهید دسترسی را ببندید و سابقه مالی بماند، به‌جای حذف، نقش/وضعیت را تغییر دهید.</span></div>
          </div>
        </details>

        <details>
          <summary>۹. به‌روزرسانی هاست از گیت‌هاب</summary>
          <div class="guide__body">
            <p style="margin:0 0 8px">برای اعمال تغییرات گیت‌هاب روی هاست لازم نیست فایل‌ها را دستی در File Manager عوض کنید. در <code>.env</code> مقدار <code>GITHUB_REPO</code> را بگذارید و از منوی «به‌روزرسانی از گیت‌هاب» استفاده کنید:</p>
            ${CODE('GITHUB_REPO=Atliner/filmwork\nGITHUB_BRANCH=main', 'guide-github')}
            <ul>
              <li>«پیش‌نمایش تغییرات» فقط نشان می‌دهد چه فایل‌هایی فرق دارند.</li>
              <li>«اعمال روی هاست» همان فایل‌ها را از آخرین کامیت جایگزین می‌کند.</li>
              <li><code>.env</code>، <code>node_modules</code> و <code>uploads</code> دست‌نخورده می‌مانند.</li>
              <li>بعد از اعمال، سرویس Node را ری‌استارت کنید؛ اگر CSS تغییر کرده، <code>npm run build:css</code> را هم اجرا کنید.</li>
            </ul>
            <div class="callout">${ICONS.info}<span>اگر سرور به گیت‌هاب دسترسی نداشت، همان صفحه سه دستور آماده برای Terminal دارد.</span></div>
          </div>
        </details>

        <details>
          <summary>۱۰. تنظیمات تبلیغات (جایگاه‌ها، تعرفه، بررسی و کمپین مالک)</summary>
          <div class="guide__body">
            <p style="margin:0 0 8px"><b>سه نوع تبلیغ، هشت جایگاه:</b> ویدیویی ۴ جایگاه (پیش از پخش، میان‌پخش، پس از پخش، لایه توقف) · بنری ۳ جایگاه (روی پلیر ۷۲۸×۹۰، بنر توقف ۳۰۰×۲۵۰، بنر قبل از دانلود ۱۰۸۰×۱۹۲۰) · لینکی ۱ جایگاه (دکمه لینک زیر فایل در ربات).</p>
            <ul>
              <li><b>روشن/خاموش:</b> هر جایگاه یک کلید دارد. خاموش یعنی حتی اگر کمپین فعال باشد، هیچ تبلیغی در آن جایگاه سرو نمی‌شود و آن جایگاه از فرم تبلیغ‌دهنده هم حذف می‌شود.</li>
              <li><b>مدت نمایش:</b> برای هر جایگاه ویدیویی/بنری مدت پیش‌فرض را تعیین کنید؛ برای کمپین‌ها هم مقدار جدا ذخیره می‌شود. «دکمه رد کردن پس از» مشخص می‌کند کاربر چند ثانیه بعد بتواند تبلیغ را رد کند.</li>
              <li><b>تعرفه:</b> CPM، CPC لینکی، حداقل بودجه و سقف روزانه؛ حدود مجاز در سرور اعمال می‌شود.</li>
              <li><b>حجم فایل:</b> حداکثر مگابایت ویدیو و کیلوبایت تصویر؛ آپلود بزرگ‌تر رد می‌شود.</li>
              <li><b>تأیید خودکار:</b> خاموش = هر کمپین کاربر در «صف بررسی» می‌ماند تا تأیید کنید. روشن = مستقیم فعال می‌شود.</li>
              <li><b>رد کمپین:</b> بودجه مصرف‌نشده به کیف پول برمی‌گردد و فایل آپلودی از هاست حذف می‌شود (اگر فایل آپلودی باشد). زمان پاک‌سازی پشتیبان هم قابل تنظیم است.</li>
              <li><b>کمپین مالک:</b> بدون کسر از کیف پول و با ساخت فوری؛ فایل را آپلود کنید یا لینک بدهید.</li>
              <li><b>قوانین:</b> متن «قوانین تبلیغات» در فرم تبلیغ‌دهنده نمایش داده می‌شود.</li>
            </ul>
            <div class="callout">${ICONS.info}<span>دسترسی‌ها: تبلیغ‌دهنده فقط کمپین خودش را می‌بیند؛ اعداد این صفحه فقط برای مالک است و هر تغییر در رویدادهای پنل ثبت می‌شود.</span></div>
          </div>
        </details>

        <details>
          <summary>۱۱. عیب‌یابی سریع</summary>
          <div class="guide__body">
            <ul>
              <li><b>۴۰۴ روی کنسول:</b> جلسه منقضی شده یا شناسه شما در <code>ADMIN_OWNER_IDS</code> نیست؛ دوباره <code>/panel</code> بزنید.</li>
              <li><b>پست خوانده نشد:</b> کانال خصوصی است؛ متن پست را در کادر دوم بچسبانید.</li>
              <li><b>لینک‌ها خالی ماندند:</b> دستور <code>#اثر</code> را با UUID درست بفرستید و فایل را در ۳۰ دقیقه ارسال کنید.</li>
              <li><b>خطای ۵۰۳ روی دامنه:</b> فایل ورودی Passenger باید <code>app.js</code> باشد و کل مخزن (نه فقط backend) آپلود شود.</li>
            </ul>
          </div>
        </details>
      </div>
    </section>`;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    area.remove();
  }

  /* -------------------------------------------------------------- handlers */
  function bindEvents() {
    let searchTimer;
    document.addEventListener('input', (event) => {
      const target = event.target;
      const editor = state.editor;
      if (editor && target.closest('#view-root')) {
        if (target.matches('[data-field]')) {
          const field = target.dataset.field;
          editor.draft[field] = target.type === 'checkbox' ? target.checked : target.value;
          if (!target.dataset.structural) return;
          const active = document.activeElement?.dataset?.field;
          paintEditor();
          if (active) $(`[data-field="${active}"]`)?.focus();
          return;
        }
        if (target.matches('[data-source-link]')) { editor.sourceLink = target.value; return; }
        if (target.matches('[data-source-text]')) { editor.sourceText = target.value; return; }
        if (target.matches('[data-quality-input]')) { editor.qualities = target.value; return; }
        if (target.matches('[data-version-title]')) {
          const index = Number(target.dataset.versionTitle);
          editor.versions[index].title = target.value;
          return;
        }
        if (target.matches('[data-link-field]')) {
          const versionIndex = Number(target.dataset.versionIndex);
          const linkIndex = Number(target.dataset.linkIndex);
          editor.versions[versionIndex].links[linkIndex][target.dataset.linkField] = target.value;
          return;
        }
      }
      if (target.matches('[data-library-q]')) {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          state.library.q = target.value.trim();
          state.library.page = 1;
          loadLibraryPage().catch((error) => toast(error.message, 'error'));
        }, 350);
      }
    });

    document.addEventListener('change', async (event) => {
      const target = event.target;
      // Some browsers only fire `change` (not `input`) for <select>, so the same
      // field assignment runs here as a safety net.
      if (state.editor && target.matches('[data-field]')) {
        state.editor.draft[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.value;
        if (target.dataset.structural || target.dataset.field === 'status') paintEditor();
        return;
      }
      if (target.matches('[data-version-kind]')) {
        state.editor.kind = target.value;
        return;
      }
      if (target.matches('[data-library-sort]')) {
        state.library.sort = target.value;
        state.library.page = 1;
        loadLibraryPage().catch((error) => toast(error.message, 'error'));
        return;
      }
      if (target.matches('[data-user-role]')) {
        target.disabled = true;
        try {
          await api(`/api/admin/users/${encodeURIComponent(target.dataset.userRole)}/role`, {
            method: 'PATCH', body: { role: target.value },
          });
          toast('نقش ذخیره شد.');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          target.disabled = false;
        }
        return;
      }
      if (target.matches('[data-ad-status]')) {
        target.disabled = true;
        try {
          await api(`/api/admin/ads/${encodeURIComponent(target.dataset.adStatus)}`, {
            method: 'PATCH', body: { status: target.value },
          });
          toast('وضعیت کمپین ذخیره شد.');
        } catch (error) {
          toast(error.message, 'error');
        } finally {
          target.disabled = false;
        }
      }
    });

    document.addEventListener('click', async (event) => {
      const target = event.target;
      const button = target.closest('button, [data-open-content]');
      if (!button) return;

      if (button.matches('[data-new-content]')) { state.editor = null; navigate('new'); return; }
      // Sidebar menu items carry `data-view`; without this branch the open menu
      // looked clickable but never navigated.
      if (button.matches('[data-view]')) {
        state.editor = null;
        navigate(button.dataset.view);
        return;
      }
      if (button.matches('[data-view-nav]')) { navigate(button.dataset.viewNav); return; }
      if (button.matches('[data-open-content]')) { navigate('edit', button.dataset.openContent); return; }
      if (button.matches('[data-edit-content]')) { state.editor = null; navigate('edit', button.dataset.editContent); return; }
      if (button.matches('[data-page]')) {
        const page = Number(button.dataset.page);
        if (!page) return;
        state.library.page = page;
        loadLibraryPage().catch((error) => toast(error.message, 'error'));
        return;
      }
      if (button.matches('[data-filter-type]')) {
        state.library.type = button.dataset.filterType;
        state.library.page = 1;
        await renderLibrary();
        return;
      }
      if (button.matches('[data-filter-status]')) {
        state.library.status = button.dataset.filterStatus;
        state.library.page = 1;
        await renderLibrary();
        return;
      }
      if (button.matches('[data-toggle-hero]')) {
        const enabled = button.dataset.heroState !== '1';
        button.disabled = true;
        try {
          await api(`/api/admin/contents/${encodeURIComponent(button.dataset.toggleHero)}/hero`, {
            method: 'POST', body: { enabled },
          });
          toast(enabled ? 'به بنر هیرو اضافه شد.' : 'از بنر هیرو برداشته شد.');
          if (state.view === 'content') await loadLibraryPage();
          else await renderOverview();
        } catch (error) {
          toast(error.message, 'error');
          button.disabled = false;
        }
        return;
      }
      if (button.matches('[data-delete-content]')) {
        const confirmed = await confirmDialog({
          title: 'حذف محتوا',
          message: `«${esc(button.dataset.deleteTitle || 'این محتوا')}» و همه نسخه‌ها و لینک‌های آن حذف می‌شوند. این کار قابل بازگشت نیست.`,
          confirmLabel: 'حذف قطعی',
        });
        if (!confirmed) return;
        try {
          await api(`/api/admin/contents/${encodeURIComponent(button.dataset.deleteContent)}`, { method: 'DELETE' });
          toast('محتوا حذف شد.');
          state.editor = null;
          await refreshCounts();
          navigate('content');
        } catch (error) {
          toast(error.message, 'error');
        }
        return;
      }

      // --- wizard -------------------------------------------------------
      if (button.matches('[data-step]')) {
        state.editor.step = Number(button.dataset.step);
        paintEditor();
        return;
      }
      if (button.matches('[data-next-step]')) {
        const editor = state.editor;
        if (editor.step === 1 && !editor.sourceText.trim() && !editor.sourceLink.trim() && !editor.draft.titleFa && !editor.draft.titleEn) {
          toast('ابتدا پست را بخوانید یا روی «ورود دستی بدون پست» بزنید.', 'error');
          return;
        }
        edgePrimeVersions(editor);
        editor.step = Math.min(4, editor.step + 1);
        paintEditor();
        return;
      }
      if (button.matches('[data-step]') && Number(button.dataset.step) > 1) {
        edgePrimeVersions(state.editor);
      }
      if (button.matches('[data-prev-step]')) {
        state.editor.step = Math.max(1, state.editor.step - 1);
        paintEditor();
        return;
      }
      if (button.matches('[data-run-parse]')) { await runParse(); return; }
      if (button.matches('[data-skip-import]')) { state.editor.step = 2; paintEditor(); return; }
      if (button.matches('[data-save-content]')) { await saveEditor(); return; }
      if (button.matches('[data-create-versions]')) { createVersions(); return; }
      if (button.matches('[data-quick-quality]')) {
        state.editor.qualities = button.dataset.quickQuality;
        createVersions();
        return;
      }
      if (button.matches('[data-toggle-version]')) {
        const index = Number(button.dataset.toggleVersion);
        state.editor.collapsed = state.editor.collapsed || {};
        state.editor.collapsed[index] = !state.editor.collapsed[index];
        paintEditor();
        return;
      }
      if (button.matches('[data-remove-version]')) {
        state.editor.versions.splice(Number(button.dataset.removeVersion), 1);
        paintEditor();
        return;
      }
      if (button.matches('[data-add-link]')) {
        const index = Number(button.dataset.addLink);
        const version = state.editor.versions[index];
        const last = version.links[version.links.length - 1];
        version.links.push({
          season: last?.season ?? (state.editor.draft.contentType === 'series' ? 1 : ''),
          episode: last?.episode ? Number(last.episode) + 1 : (state.editor.draft.contentType === 'series' ? 1 : ''),
          title: '', label: '', sizeText: '',
          streamUrl: '', subtitleUrl: '', dubUrl: '', telegramUrl: '',
        });
        paintEditor();
        return;
      }
      if (button.matches('[data-sync-media]')) {
        button.disabled = true;
        try {
          const result = await api(`/api/admin/contents/${encodeURIComponent(button.dataset.syncMedia)}/sync-media`, { method: 'POST' });
          toast(result.imported
            ? `${fa(result.imported)} لینک از ربات خوانده و به نسخه‌ها اضافه شد.`
            : 'لینک تازه‌ای در ربات پیدا نشد؛ ابتدا فایل را در تلگرام ارسال کنید.');
          await renderEditor(state.editor.assetId);
        } catch (error) {
          toast(error.message, 'error');
          button.disabled = false;
        }
        return;
      }
      if (button.matches('[data-fill-episodes]')) {
        const index = Number(button.dataset.fillEpisodes);
        const version = state.editor.versions[index];
        const total = Math.min(60, Number(state.editor.draft.episodeCount || 0));
        if (!total) {
          toast('اول تعداد قسمت را در مشخصات وارد کنید.', 'error');
          return;
        }
        const season = Number(state.editor.draft.currentSeason || 1) || 1;
        version.links = Array.from({ length: total }, (_unused, episodeIndex) => ({
          season,
          episode: episodeIndex + 1,
          title: '', label: '', sizeText: '',
          streamUrl: '', subtitleUrl: '', dubUrl: '', telegramUrl: '',
        }));
        paintEditor();
        toast(`${fa(total)} ردیف قسمت ساخته شد.`);
        return;
      }
      if (button.matches('[data-remove-link]')) {
        const [versionIndex, linkIndex] = button.dataset.removeLink.split('-').map(Number);
        state.editor.versions[versionIndex].links.splice(linkIndex, 1);
        paintEditor();
        return;
      }
      if (button.matches('[data-add-gallery]')) {
        const input = $('[data-gallery-input]');
        const url = safeUrl(input?.value?.trim());
        if (!url) { toast('لینک تصویر معتبر نیست.', 'error'); return; }
        if (!state.editor.draft.posterGallery.includes(url)) state.editor.draft.posterGallery.push(url);
        if (!state.editor.draft.posterUrl) state.editor.draft.posterUrl = url;
        paintEditor();
        return;
      }
      if (button.matches('[data-remove-gallery]')) {
        const index = Number(button.dataset.removeGallery);
        const [removed] = state.editor.draft.posterGallery.splice(index, 1);
        if (state.editor.draft.posterUrl === removed) state.editor.draft.posterUrl = state.editor.draft.posterGallery[0] || '';
        paintEditor();
        return;
      }
      if (button.matches('[data-set-primary]')) {
        state.editor.draft.posterUrl = state.editor.draft.posterGallery[Number(button.dataset.setPrimary)];
        paintEditor();
        return;
      }
      if (button.matches('[data-focus-poster]')) {
        state.editor.step = 2;
        paintEditor();
        $('[data-poster-input]')?.focus();
        return;
      }
      if (button.matches('[data-toggle-hero-draft]')) {
        state.editor.draft.featuredHero = !state.editor.draft.featuredHero;
        paintEditor();
        return;
      }
      if (button.matches('[data-copy]')) {
        const text = window.__guideCodes?.[button.dataset.copy];
        if (text) {
          copyToClipboard(text);
          toast('کپی شد.');
        }
        return;
      }
      if (button.matches('#logout')) {
        try {
          await api('/api/admin/logout', { method: 'POST' });
        } catch { /* ignore */ }
        showSessionEnded('نشست شما بسته شد.');
        return;
      }
      if (button.matches('#menu-toggle')) {
        const sidebar = $('#sidebar');
        const open = sidebar.classList.toggle('is-open');
        $('#sidebar-scrim').hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        return;
      }
      if (button.matches('#sidebar-scrim')) {
        $('#sidebar').classList.remove('is-open');
        button.hidden = true;
        $('#menu-toggle').setAttribute('aria-expanded', 'false');
      }
    });

    window.addEventListener('hashchange', render);
    window.addEventListener('beforeunload', (event) => {
      if (!state.editor) return;
      if (state.editor.dirty) event.preventDefault();
    });
    document.addEventListener('input', () => { if (state.editor) state.editor.dirty = true; }, { capture: true });
  }

  /* ------------------------------------------------------------------ boot */
  async function boot() {
    bindEvents();
    try {
      const session = await api('/api/admin/session');
      state.csrf = session.csrfToken;
      await refreshCounts();
      await render();
    } catch (error) {
      showSessionEnded(error.message);
    }
  }

  boot();
})();
