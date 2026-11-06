'use strict';

(() => {
  const state = { csrf: '' };
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const faNumber = (value) => Number(value || 0).toLocaleString('fa-IR');
  const faDate = (value) => value ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

  function toast(message, error = false) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.toggle('error', error);
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 2800);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || 'درخواست ناموفق بود.');
    return data;
  }

  function statusSelect(kind, id, current) {
    const values = kind === 'ad'
      ? ['pending', 'active', 'paused', 'completed', 'rejected']
      : ['draft', 'published', 'archived'];
    return `<select class="select" data-kind="${kind}" data-id="${escapeHtml(id)}">${values.map((value) => `<option value="${value}" ${value === current ? 'selected' : ''}>${value}</option>`).join('')}</select>`;
  }

  async function load() {
    const [stats, ads, contents, users] = await Promise.all([
      api('/api/admin/stats'), api('/api/admin/ads'), api('/api/admin/contents'), api('/api/admin/users'),
    ]);
    const cards = [
      ['کل آثار', stats.stats.contents.total, `${faNumber(stats.stats.contents.published)} منتشرشده`],
      ['کاربران فعال', stats.stats.users.total, `${faNumber(stats.stats.users.advertisers)} تبلیغ‌دهنده`],
      ['فایل‌های رسانه', stats.stats.media.total, `${faNumber(stats.stats.media.unavailable)} خارج از دسترس`],
      ['کمپین‌ها', stats.stats.ads.total, `${faNumber(stats.stats.ads.pending)} در انتظار`],
    ];
    $('#stats').innerHTML = cards.map(([label, value, detail]) => `<article class="stat"><span class="muted">${label}</span><strong>${faNumber(value)}</strong><span class="muted">${detail}</span></article>`).join('');
    $('#ads').innerHTML = ads.items.length ? ads.items.map((ad) => `<tr><td><strong>${escapeHtml(ad.campaign_name)}</strong><br><span class="muted">${escapeHtml(ad.headline)}</span></td><td>${escapeHtml(ad.account_name)}</td><td>${escapeHtml(ad.placement)}</td><td>${faNumber(ad.budget)}</td><td>${statusSelect('ad', ad.public_id, ad.status)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">کمپینی وجود ندارد.</td></tr>';
    $('#users').innerHTML = users.items.length ? users.items.map((user) => `<tr><td><strong>${escapeHtml(user.accountName)}</strong><br><span class="muted">${user.telegramUsername ? `@${escapeHtml(user.telegramUsername)}` : `شناسه ${escapeHtml(user.id)}`}</span></td><td><select class="select" data-user-role="${escapeHtml(user.id)}"><option value="user" ${user.role === 'user' ? 'selected' : ''}>کاربر</option><option value="advertiser" ${user.role === 'advertiser' ? 'selected' : ''}>تبلیغ‌دهنده</option></select></td><td>${faNumber(user.walletBalance)} ${escapeHtml(user.walletCurrency)}</td><td><form class="credit-box" data-credit-user="${escapeHtml(user.id)}"><input class="credit-input" name="amount" type="number" min="1" required placeholder="مبلغ ریال"><button class="mini-button" type="submit">شارژ</button></form></td></tr>`).join('') : '<tr><td colspan="4" class="muted">کاربری وجود ندارد.</td></tr>';
    $('#contents').innerHTML = contents.items.length ? contents.items.map((item) => `<tr><td>${escapeHtml(item.title)}</td><td>${item.content_type === 'series' ? 'سریال' : 'فیلم'}</td><td>${faNumber(item.media_count)}</td><td>${faDate(item.created_at)}</td><td>${statusSelect('content', item.asset_uuid, item.status)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">اثری ثبت نشده است.</td></tr>';
    $('#health').innerHTML = stats.healthEvents.length ? stats.healthEvents.map((item) => `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.reason)}</td><td>${faDate(item.created_at)}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">رخدادی ثبت نشده است.</td></tr>';
  }

  document.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-kind], [data-user-role]');
    if (!select) return;
    select.disabled = true;
    try {
      if (select.dataset.userRole) {
        await api(`/api/admin/users/${encodeURIComponent(select.dataset.userRole)}/role`, {
          method: 'PATCH', body: JSON.stringify({ role: select.value }),
        });
      } else {
        const path = select.dataset.kind === 'ad'
          ? `/api/admin/ads/${encodeURIComponent(select.dataset.id)}`
          : `/api/admin/contents/${encodeURIComponent(select.dataset.id)}`;
        await api(path, { method: 'PATCH', body: JSON.stringify({ status: select.value }) });
      }
      toast('وضعیت ذخیره شد.');
    } catch (error) {
      toast(error.message, true);
      await load();
    } finally {
      select.disabled = false;
    }
  });

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-refresh]')) load().then(() => toast('اطلاعات به‌روز شد.')).catch((error) => toast(error.message, true));
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-credit-user]');
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector('button');
    const amount = Number(new FormData(form).get('amount'));
    if (!Number.isFinite(amount) || amount <= 0) return toast('مبلغ معتبر وارد کنید.', true);
    button.disabled = true;
    try {
      await api(`/api/admin/users/${encodeURIComponent(form.dataset.creditUser)}/wallet-credit`, {
        method: 'POST', body: JSON.stringify({ amount }),
      });
      toast('کیف پول شارژ شد.');
      await load();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' });
      document.body.innerHTML = '<main class="shell"><section class="panel"><h1>نشست با موفقیت بسته شد.</h1><p class="muted">برای ورود دوباره، از ربات خصوصی پیوند تازه دریافت کنید.</p></section></main>';
    } catch (error) { toast(error.message, true); }
  });

  (async () => {
    try {
      const session = await api('/api/admin/session');
      state.csrf = session.csrfToken;
      await load();
    } catch (error) {
      document.body.innerHTML = `<main class="shell"><section class="panel"><h1>دسترسی پایان یافته است</h1><p class="error">${escapeHtml(error.message)}</p></section></main>`;
    }
  })();
})();
