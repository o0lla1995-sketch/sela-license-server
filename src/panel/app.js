/**
 * app.js — sela admin panel SPA (v3 professional redesign).
 * ─────────────────────────────────────────────────────────────────
 * Sections: helpers · api client · auth · router · views
 *   (dashboard, keys, payments, landing, contact, admins, audit, settings)
 * Vanilla JS — no dependencies. Fully responsive (tables → cards).
 */
'use strict';

/* ═══════════════════ helpers ═══════════════════ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let CURRENCY = '₪';
function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toFixed(v % 1 === 0 ? 0 : 2) + ' ' + CURRENCY;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return d.toLocaleDateString('ar', {day: 'numeric', month: 'short', year: 'numeric'});
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return d.toLocaleDateString('ar', {day: 'numeric', month: 'short'}) + ' · ' +
    d.toLocaleTimeString('ar', {hour: '2-digit', minute: '2-digit'});
}

function daysLeft(ts) {
  if (!ts) return null;
  return Math.ceil((Number(ts) - Date.now()) / 86400000);
}

let toastTimer = null;
function toast(msg, type) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

/* v3.3 — نسخ عام يعمل في كل السياقات:
 * navigator.clipboard متاح فقط في السياقات الآمنة (HTTPS) — واللوحة
 * تعمل غالباً عبر http:// على نطاق sslip.io بلا شهادة، فكان زر
 * «نسخ» ميتاً تماماً (undefined.writeText). هذا البديل يجرّب الـ
 * API الحديث ثم يسقط إلى textarea + execCommand('copy') الذي
 * يعمل في HTTP وفي متصفحات WebView القديمة أيضاً. */
function copyText(text) {
  return new Promise((resolve, reject) => {
    const s = String(text == null ? '' : text);
    const modern = () => {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(s).then(resolve, () => legacy());
      } else {
        legacy();
      }
    };
    const legacy = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, s.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) { resolve(); } else { reject(new Error('copy failed')); }
      } catch (e) {
        reject(e);
      }
    };
    modern();
  });
}
function bindCopy(buttons, successMsg) {
  buttons.forEach((b) => {
    b.onclick = () => {
      copyText(b.getAttribute('data-copy'))
        .then(() => toast(successMsg || 'تم النسخ', 'success'))
        .catch(() => toast('تعذر النسخ — انسخه يدوياً', 'error'));
    };
  });
}

function showModal(html, wide) {
  $('#modalBox').className = 'modal' + (wide ? ' wide' : '');
  $('#modalBox').innerHTML = html;
  $('#modalBack').classList.remove('hidden');
}
function closeModal() {
  $('#modalBack').classList.add('hidden');
  $('#modalBox').innerHTML = '';
}
$('#modalBack') && $('#modalBack').addEventListener('click', (e) => {
  if (e.target === $('#modalBack')) closeModal();
});

function confirmModal(title, msg, okLabel, onOk) {
  showModal(
    '<h3>' + esc(title) + '</h3>' +
    '<p class="dim" style="font-size:13.5px">' + esc(msg) + '</p>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="cmCancel">إلغاء</button>' +
    '<button class="btn danger" id="cmOk">' + esc(okLabel || 'تأكيد') + '</button>' +
    '</div>'
  );
  $('#cmCancel').onclick = closeModal;
  $('#cmOk').onclick = async () => {
    const btn = $('#cmOk');
    btn.disabled = true;
    try { await onOk(); closeModal(); }
    catch (e) { btn.disabled = false; }
  };
}

/* ═══════════════════ api client ═══════════════════ */

let TOKEN = localStorage.getItem('sela_panel_token') || '';

/* v4.7 — مقاومة 304 من بروكسيات مزودي الجوال:
 * بعض الشبكات على HTTP الصريح تخزّن رد GET ثم تحوّل الطلبات التالية
 * لشرطية وتمرر 304 الفارغ للمتصفح (طلبٌ لم يطلب إعادة تحقق!) — المتصفح
 * يعدها رداً معطوباً فتفشل كل الأقسام. العلاج: طلب no-cache دائماً،
 * وعند وصول 304 رغم ذلك نعيد المحاولة مرة واحدة برابط فريد (كسر
 * الكاش عند أي وسيط) — يجلب الرد الكامل من الأصل حتماً. */
async function apiFetch(url, opts) {
  const o = opts || {};
  const init = {
    method: o.method || 'GET',
    cache: 'no-store',
    headers: Object.assign(
      {'Content-Type': 'application/json', 'Cache-Control': 'no-cache'},
      TOKEN ? {Authorization: 'Bearer ' + TOKEN} : {}
    ),
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  };
  let res = await fetch(url, init);
  if (res.status === 304) {
    const bust = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    res = await fetch(bust, init);
  }
  return res;
}

async function api(path, opts) {
  const o = opts || {};
  const res = await apiFetch('/api/admin' + path, o);
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }

  if (res.status === 401) {
    forceLogout();
    throw new Error('انتهت الجلسة — سجّل الدخول من جديد');
  }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

/* ═══════════════════ auth ═══════════════════ */

let ME = null;

function forceLogout() {
  TOKEN = '';
  ME = null;
  localStorage.removeItem('sela_panel_token');
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#loginEmail').focus();
}

async function boot() {
  if (!TOKEN) { showLogin(); return; }
  try {
    const me = await api('/auth/me');
    ME = me.user;
    await loadConfigCache();
    enterApp();
  } catch (_) {
    showLogin();
  }
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}

async function loadConfigCache() {
  try {
    const cfg = await api('/config');
    CURRENCY = (cfg && cfg.currency) || '₪';
  } catch (_) { /* keep default */ }
}

function enterApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');

  const name = ME.name || ME.email || '—';
  $('#userName').textContent = name;
  $('#userEmail').textContent = ME.email || '';
  const initial = (name.trim()[0] || 'م');
  $('#userAvatar').textContent = initial;
  $('#topUser').textContent = initial;

  // owner-only section
  if (ME.role === 'owner') $('#navAdmins').style.display = 'flex';

  // server clock
  tickClock();
  setInterval(tickClock, 30000);

  route();
}

function tickClock() {
  const el = $('#serverClock');
  if (el) {
    el.textContent = new Date().toLocaleString('ar', {
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    });
  }
}

/* login form */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('#loginError');
  errBox.classList.add('hidden');
  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ التحقق…';
  try {
    const res = await apiFetch('/api/admin/auth/login', {
      method: 'POST',
      body: {
        email: $('#loginEmail').value.trim(),
        password: $('#loginPass').value,
      },
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'LOGIN_FAILED');
    TOKEN = data.token;
    localStorage.setItem('sela_panel_token', TOKEN);
    ME = data.user;
    await loadConfigCache();
    enterApp();
  } catch (err) {
    errBox.textContent =
      err.message === 'BAD_CREDENTIALS' ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة' :
      err.message === 'TOO_MANY_ATTEMPTS' ? 'محاولات كثيرة — انتظر ربع ساعة ثم أعد المحاولة' :
      'تعذر تسجيل الدخول: ' + err.message;
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'تسجيل الدخول';
  }
});

$('#loginEye').addEventListener('click', () => {
  const p = $('#loginPass');
  p.type = p.type === 'password' ? 'text' : 'password';
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/auth/logout', {method: 'POST'}); } catch (_) {}
  forceLogout();
});

/* ═══════════════════ router ═══════════════════ */

const VIEWS = {
  dashboard: {title: 'لوحة المعلومات', fn: viewDashboard},
  keys: {title: 'مفاتيح التفعيل', fn: viewKeys},
  payments: {title: 'المدفوعات', fn: viewPayments},
  market: {title: 'المتاجر والطلبات', fn: viewMarket},
  users: {title: 'مستخدمو المتجر', fn: viewMarketUsers},
  landing: {title: 'صفحة الهبوط', fn: viewLanding},
  contact: {title: 'التواصل', fn: viewContact},
  admins: {title: 'المشرفون', fn: viewAdmins},
  audit: {title: 'سجل الأحداث', fn: viewAudit},
  settings: {title: 'الإعدادات', fn: viewSettings},
};

function currentRoute() {
  const h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  return VIEWS[h] ? h : 'dashboard';
}

function route() {
  const r = currentRoute();
  $$('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.getAttribute('data-nav') === r);
  });
  const v = VIEWS[r];
  $('#topTitle').textContent = v.title;
  document.title = 'سيلا — ' + v.title;
  closeSidebar();
  v.fn().catch((err) => {
    $('#view').innerHTML =
      '<div class="card"><div class="empty">تعذر تحميل الصفحة<br><span class="tiny">' +
      esc(err.message) + '</span></div></div>';
  });
}

window.addEventListener('hashchange', () => {
  if (ME) route();
});

$$('.nav-item').forEach((n) => {
  n.addEventListener('click', () => {
    const target = '#/' + n.getAttribute('data-nav');
    closeSidebar(); // close the drawer immediately — even when the route won't change.
    if (location.hash === target) {
      route(); // same route: no hashchange will fire, so re-render manually.
    } else {
      location.hash = target;
    }
  });
});

/* sidebar (mobile) */
function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#backdrop').classList.add('show');
  document.body.classList.add('drawer-open'); // freeze the page behind
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#backdrop').classList.remove('show');
  document.body.classList.remove('drawer-open');
}
$('#burgerBtn').addEventListener('click', openSidebar);
$('#sidebarClose').addEventListener('click', closeSidebar);
$('#backdrop').addEventListener('click', closeSidebar);

/* close the drawer with Escape */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebar();
});

/* swipe-to-close on touch: the drawer lives on the right edge (RTL),
   so a deliberate swipe toward the right edge closes it. */
(function () {
  const sb = $('#sidebar');
  if (!sb) return;
  let sx = null, sy = null;
  sb.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { sx = null; return; }
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, {passive: true});
  sb.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    sx = null;
    if (dx > 64 && Math.abs(dx) > Math.abs(dy) * 1.4) closeSidebar();
  }, {passive: true});
})();

/* absolute guarantee: whenever the drawer is open and the viewport
   grows to desktop width, it closes and the scroll lock is released. */
(function () {
  const mq = window.matchMedia('(min-width: 1025px)');
  const onChange = () => { if (mq.matches) closeSidebar(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
  window.addEventListener('orientationchange', () => {
    if (window.matchMedia('(min-width: 1025px)').matches) closeSidebar();
  });
})();

/* safety: if the page is ever unloaded/reloaded while the drawer is
   open, never leave the scroll-lock class behind. */
window.addEventListener('pageshow', () => {
  if (!$('#sidebar').classList.contains('open')) {
    document.body.classList.remove('drawer-open');
  }
});

/* desktop rail (collapse) — persisted per browser */
const RAIL_KEY = 'sela_panel_rail';
function applyRail(on) {
  document.body.classList.toggle('rail', on);
  $('#sidebarHandle').setAttribute('aria-label', on ? 'فتح القائمة' : 'طي القائمة');
  try { localStorage.setItem(RAIL_KEY, on ? '1' : '0'); } catch (_) {}
}
(function () {
  let saved = null;
  try { saved = localStorage.getItem(RAIL_KEY); } catch (_) {}
  if (saved === '1') applyRail(true);
})();
if ($('#sidebarHandle')) {
  $('#sidebarHandle').addEventListener('click', () => {
    applyRail(!document.body.classList.contains('rail'));
  });
}
/* tooltips for rail mode */
$$('.nav-item').forEach((n) => {
  const lbl = n.querySelector('.nav-label');
  if (lbl) n.title = lbl.textContent.trim();
});

/* ═══════════════════ charts (inline SVG) ═══════════════════ */

function htmlBarChart(items) {
  // items: [{label, value, display}] — RTL HTML/CSS bars: real text at every size.
  if (!items || !items.length) return '<div class="empty">لا بيانات بعد</div>';
  const max = Math.max(1, ...items.map((i) => i.value));
  const rows = items
    .map((it) => {
      const pct = Math.max(2, Math.round((it.value / max) * 100));
      return (
        '<div class="hb-row">' +
        '<span class="hb-label">' + esc(it.label) + '</span>' +
        '<span class="hb-track"><span class="hb-bar" style="width:' + pct + '%"></span></span>' +
        '<b class="hb-val">' + esc(it.display !== undefined ? it.display : String(it.value)) + '</b>' +
        '</div>'
      );
    })
    .join('');
  return '<div class="hb-chart">' + rows + '</div>';
}

function svgAreaChart(points) {
  // points: [{d, n}] — daily activations; no in-SVG text (stays readable via HTML).
  if (!points || !points.length) return '<div class="empty">لا بيانات بعد</div>';
  const w = 640, h = 250, padB = 16, padT = 18;
  const max = Math.max(1, ...points.map((p) => p.n));
  const step = (w - 16) / Math.max(1, points.length - 1);
  const x = (i) => w - 8 - i * step; // RTL: oldest at right
  const y = (v) => padT + (1 - v / max) * (h - padB - padT);

  let path = '';
  points.forEach((p, i) => {
    path += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.n).toFixed(1) + ' ';
  });
  const area =
    path + 'L' + x(points.length - 1).toFixed(1) + ' ' + (h - padB) +
    ' L' + x(0).toFixed(1) + ' ' + (h - padB) + ' Z';

  // 3 dashed gridlines at 25 / 50 / 75% of the max.
  let grid = '';
  for (const f of [0.25, 0.5, 0.75]) {
    const gy = y(max * f).toFixed(1);
    grid +=
      '<line x1="8" y1="' + gy + '" x2="' + (w - 8) + '" y2="' + gy +
      '" stroke="rgba(255,255,255,0.05)" stroke-dasharray="4 5"/>';
  }
  const baseline = '<line x1="8" y1="' + (h - padB) + '" x2="' + (w - 8) + '" y2="' + (h - padB) + '" stroke="rgba(255,255,255,0.12)"/>';

  const first = String(points[0].d);
  const mid = String(points[Math.floor((points.length - 1) / 2)].d);
  const last = String(points[points.length - 1].d);
  const mmdd = (s) => (s.length >= 10 ? s.slice(5) : s);

  return (
    '<div class="area-chart">' +
    '<div class="chart-topline"><span class="dim">الذروة</span><b>' + esc(String(max)) + '</b></div>' +
    '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">' +
    '<defs><linearGradient id="agrad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="rgba(249,115,22,0.38)"/><stop offset="1" stop-color="rgba(249,115,22,0.02)"/>' +
    '</linearGradient></defs>' +
    grid +
    '<path d="' + area + '" fill="url(#agrad)"/>' +
    '<path d="' + path + '" fill="none" stroke="#f97316" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>' +
    baseline +
    '</svg>' +
    '<div class="axis-range"><span>' + esc(mmdd(first)) + '</span><span>' + esc(mmdd(mid)) + '</span><span>' + esc(mmdd(last)) + '</span></div>' +
    '</div>'
  );
}

/* ═══════════════════ VIEW: dashboard ═══════════════════ */

async function viewDashboard() {
  const [stats, ana] = await Promise.all([
    api('/stats'),
    api('/analytics?days=30'),
  ]);

  const rev = stats.revenue || {};
  const kpis =
    '<div class="kpi accent"><div class="k-label">إيراد هذا الشهر</div>' +
    '<div class="k-value">' + esc(fmtMoney(rev.thisMonth || 0)) + '</div>' +
    '<div class="k-sub">آخر 30 يوم: ' + esc(fmtMoney(rev.last30d || 0)) + '</div></div>' +
    '<div class="kpi"><div class="k-label">إجمالي الإيرادات</div>' +
    '<div class="k-value">' + esc(fmtMoney(rev.total || 0)) + '</div>' +
    '<div class="k-sub">من كل الدفعات المسجلة</div></div>' +
    '<div class="kpi green"><div class="k-label">مفاتيح نشطة</div>' +
    '<div class="k-value">' + esc(String(stats.active)) + '<small> / ' + esc(String(stats.total)) + '</small></div>' +
    '<div class="k-sub">غير مستخدمة: ' + esc(String(stats.unused)) + ' · موقوفة: ' + esc(String(stats.revoked)) + '</div></div>' +
    '<div class="kpi"><div class="k-label">أجهزة نشطة</div>' +
    '<div class="k-value">' + esc(String(stats.devices)) + '</div>' +
    '<div class="k-sub">نشط آخر 24 ساعة: ' + esc(String(ana.deviceActivity.seen24h)) + '</div></div>' +
    '<div class="kpi"><div class="k-label">الإيراد الشهري المتوقع MRR</div>' +
    '<div class="k-value">' + esc(fmtMoney(rev.mrr || 0)) + '</div>' +
    '<div class="k-sub">تقدير من الاشتراكات النشطة</div></div>' +
    '<div class="kpi"><div class="k-label">تنتهي خلال 7 أيام</div>' +
    '<div class="k-value" style="color:' + (stats.expiringSoon > 0 ? '#fcd34d' : 'inherit') + '">' +
    esc(String(stats.expiringSoon)) + '</div>' +
    '<div class="k-sub">راجعها من قسم المفاتيح</div></div>';

  // revenue by month (max 12)
  const revItems = (ana.revenueByMonth || []).slice(-12).map((r) => ({
    label: r.ym,
    value: Number(r.total) || 0,
    display: fmtMoney(r.total),
  })).reverse();

  const recentPayments = (ana.recentPayments || []).slice(0, 6);
  const expiring = (ana.expiringSoon || []).slice(0, 6);

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>لوحة المعلومات</h1>' +
    '<div class="sub">نظرة شاملة على التراخيص والإيرادات</div></div>' +
    '<div class="page-actions">' +
    '<button class="btn ghost" id="dashRefresh">تحديث</button>' +
    '<button class="btn primary" id="dashNewKey">+ مفتاح جديد</button>' +
    '</div></div>' +

    '<div class="kpi-grid">' + kpis + '</div>' +

    '<div class="row-2" style="align-items:stretch">' +
    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg>' +
    'الإيرادات الشهرية</div>' +
    (revItems.length ? htmlBarChart(revItems) : '<div class="empty">لا مدفوعات بعد</div>') +
    '</div>' +
    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M12 8v4l2.5 2.5"/><circle cx="12" cy="12" r="9"/></svg>' +
    'التفعيلات — آخر 30 يوم</div>' +
    svgAreaChart(ana.activationSeries || []) +
    '<div class="card-title" style="margin-top:14px">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/></svg>' +
    'توزيع الخطط النشطة</div>' +
    ((ana.planDistribution || []).length
      ? '<div class="chips">' + ana.planDistribution.map((p) =>
          '<span class="chip" style="cursor:default">' + esc(p.label) +
          ' — ' + esc(String(p.count)) + '</span>').join('') + '</div>'
      : '<div class="empty">لا اشتراكات نشطة</div>') +
    '</div>' +
    '</div>' +

    '<div class="row-2" style="align-items:stretch">' +
    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="2" y="6" width="20" height="13" rx="2.5"/><path d="M2 10.5h20"/></svg>' +
    'آخر المدفوعات</div>' +
    (recentPayments.length
      ? '<div class="tl">' + recentPayments.map((p) =>
          '<div class="tl-row"><span class="tl-time">' + esc(fmtDateTime(p.created_at)) + '</span>' +
          '<span class="tl-event" style="color:#86efac">' + esc(fmtMoney(p.amount)) + '</span>' +
          '<span class="tl-detail">' + esc(p.key_plain || 'بدون مفتاح') + '</span></div>').join('') + '</div>'
      : '<div class="empty">لا مدفوعات بعد</div>') +
    '</div>' +
    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>' +
    'اشتراكات تنتهي قريباً</div>' +
    (expiring.length
      ? '<div class="tl">' + expiring.map((e) => {
          const left = daysLeft(e.expires_at);
          return '<div class="tl-row"><span class="tl-time">' + esc(fmtDate(e.expires_at)) + '</span>' +
            '<span class="tl-event">' + esc(e.key_plain) + '</span>' +
            '<span class="tl-detail">متبقي ' + esc(String(left)) + ' يوم · ' + esc(e.device_label || '') + '</span></div>';
        }).join('') + '</div>'
      : '<div class="empty">لا اشتراكات على وشك الانتهاء 🎉</div>') +
    '</div>' +
    '</div>';

  $('#dashRefresh').onclick = () => route();
  $('#dashNewKey').onclick = () => openCreateKeys();
}

/* ═══════════════════ VIEW: keys ═══════════════════ */

const keyState = {status: 'all', q: ''};

async function viewKeys() {
  const q = encodeURIComponent(keyState.q);
  const data = await api('/keys?status=' + keyState.status + (q ? '&q=' + q : ''));
  const keys = data.keys || [];

  const chips = [
    ['all', 'الكل'], ['active', 'نشط'], ['unused', 'غير مستخدم'],
    ['expired', 'منتهي'], ['unpaid', 'غير مسدد'], ['revoked', 'موقوف'],
  ].map(([k, label]) =>
    '<button class="chip ' + (keyState.status === k ? 'active' : '') + '" data-st="' + k + '">' +
    label + '</button>'
  ).join('');

  const statusBadge = (k) => {
    if (k.status === 'revoked') return '<span class="badge red">موقوف</span>';
    if (k.status === 'active') return '<span class="badge green">نشط</span>';
    if (k.status === 'expired') return '<span class="badge amber">منتهي</span>';
    return '<span class="badge gray">غير مستخدم</span>';
  };
  const payBadge = (k) => {
    if (k.payStatus === 'free') return '<span class="badge blue">مجاني</span>';
    if (k.payStatus === 'paid') return '<span class="badge green">مسدد</span>';
    if (k.payStatus === 'partial') return '<span class="badge amber">جزئي</span>';
    return '<span class="badge red">غير مسدد</span>';
  };
  const expiryText = (k) => {
    if (!k.latest_expiry && !k.plan_expires_at) return '—';
    const exp = k.plan_expires_at || k.latest_expiry;
    const left = daysLeft(exp);
    if (left === null) return '—';
    return fmtDate(exp) + (left >= 0 ? ' (متبقي ' + left + ' يوم)' : ' (منتهي)');
  };

  const rows = keys.map((k) =>
    '<tr>' +
    '<td class="mono">' + esc(k.key_plain) +
    '<button class="copy-key" data-copy="' + esc(k.key_plain) + '">نسخ</button></td>' +
    '<td>' + esc(k.planLabel) + '</td>' +
    '<td class="num">' + k.active_devices + ' / ' + k.max_devices + '</td>' +
    '<td>' + statusBadge(k) + '</td>' +
    '<td>' + payBadge(k) + '</td>' +
    '<td class="dim tiny">' + esc(expiryText(k)) + '</td>' +
    '<td class="actions"><button class="btn ghost small" data-kid="' + k.id + '">تفاصيل</button></td>' +
    '</tr>'
  ).join('');

  const cards = keys.map((k) =>
    '<div class="mcard">' +
    '<div class="m-top"><span class="m-title">' + esc(k.key_plain) + '</span>' + statusBadge(k) + '</div>' +
    '<div class="m-rows">' +
    '<div class="r"><span>الخطة</span><b>' + esc(k.planLabel) + '</b></div>' +
    '<div class="r"><span>الأجهزة</span><b>' + k.active_devices + ' / ' + k.max_devices + '</b></div>' +
    '<div class="r"><span>السعر / المسدد</span><b>' + esc(fmtMoney(k.price)) + ' / ' + esc(fmtMoney(k.paid_sum)) + '</b></div>' +
    '<div class="r"><span>الانتهاء</span><b>' + esc(expiryText(k)) + '</b></div>' +
    '</div>' +
    '<div class="m-actions">' +
    '<button class="btn ghost small" data-kid="' + k.id + '">التفاصيل</button>' +
    '<button class="btn ghost small" data-copy="' + esc(k.key_plain) + '">نسخ المفتاح</button>' +
    '</div></div>'
  ).join('');

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>مفاتيح التفعيل</h1>' +
    '<div class="sub">' + keys.length + ' مفتاح معروض</div></div>' +
    '<div class="page-actions">' +
    '<button class="btn primary" id="btnNewKeys">+ إنشاء مفاتيح</button>' +
    '</div></div>' +

    '<div class="card" style="padding:14px">' +
    '<div class="flex wrap" style="gap:12px">' +
    '<input class="input grow" id="keySearch" placeholder="ابحث برقم المفتاح أو الملاحظة…" ' +
    'style="max-width:340px" value="' + esc(keyState.q) + '">' +
    '<div class="chips">' + chips + '</div>' +
    '</div></div>' +

    '<div class="card">' +
    (keys.length
      ? '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>المفتاح</th><th>الخطة</th><th>الأجهزة</th><th>الحالة</th><th>الدفع</th><th>الانتهاء</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="cards-list">' + cards + '</div>'
      : '<div class="empty"><div class="e-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.6">' +
        '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.3 12.7L20 3"/></svg></div>' +
        'لا مفاتيح مطابقة — أنشئ مفتاحاً جديداً أو غيّر الفلتر</div>') +
    '</div>';

  // wire
  let searchTimer = null;
  $('#keySearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      keyState.q = e.target.value.trim();
      viewKeys().catch(showErr);
    }, 350);
  });
  $$('#view .chip[data-st]').forEach((c) => {
    c.onclick = () => {
      keyState.status = c.getAttribute('data-st');
      viewKeys().catch(showErr);
    };
  });
  $('#btnNewKeys').onclick = openCreateKeys;
  $$('#view [data-kid]').forEach((b) => {
    b.onclick = () => openKeyDetail(Number(b.getAttribute('data-kid')));
  });
  // v3.3: نسخ عام (clipboard API + execCommand fallback) — كان الزر
  // لا يعمل إطلاقاً على http (سياق غير آمن).
  bindCopy($$('#view [data-copy]'), 'تم نسخ المفتاح');
}

function showErr(err) {
  toast(err.message || 'حدث خطأ', 'error');
}

function openCreateKeys() {
  showModal(
    '<h3>إنشاء مفاتيح تفعيل</h3>' +
    '<div class="row-2">' +
    '<div class="field"><label>مدة الخطة (أيام)</label>' +
    '<input class="input" id="ckDays" type="number" min="1" max="3650" value="30"></div>' +
    '<div class="field"><label>عدد المفاتيح</label>' +
    '<input class="input" id="ckCount" type="number" min="1" max="50" value="1"></div>' +
    '</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>أقصى عدد أجهزة</label>' +
    '<input class="input" id="ckDevices" type="number" min="1" max="10" value="1"></div>' +
    '<div class="field"><label>السعر (اتركه فارغاً للتلقائي)</label>' +
    '<input class="input" id="ckPrice" type="number" min="0" step="0.5" placeholder="تلقائي"></div>' +
    '</div>' +
    '<div class="field"><label>ملاحظة (اسم الزبون مثلاً)</label>' +
    '<input class="input" id="ckNote" maxlength="200" placeholder="مثال: سوبر ماركت النور"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="ckCancel">إلغاء</button>' +
    '<button class="btn primary" id="ckOk">إنشاء</button>' +
    '</div>'
  );
  $('#ckCancel').onclick = closeModal;
  $('#ckOk').onclick = async () => {
    const btn = $('#ckOk');
    btn.disabled = true;
    try {
      const res = await api('/keys', {
        method: 'POST',
        body: {
          planDays: Number($('#ckDays').value),
          maxDevices: Number($('#ckDevices').value),
          count: Number($('#ckCount').value),
          price: $('#ckPrice').value === '' ? undefined : Number($('#ckPrice').value),
          note: $('#ckNote').value,
        },
      });
      closeModal();
      const list = res.keys.map((k) => k.key).join('\n');
      showKeysCreated(list);
      viewKeys().catch(showErr);
    } catch (err) {
      btn.disabled = false;
      showErr(err);
    }
  };
}

function showKeysCreated(list) {
  showModal(
    '<h3>تم إنشاء المفاتيح 🎉</h3>' +
    '<p class="dim tiny mb">انسخها الآن — يمكنك العودة إليها من قائمة المفاتيح</p>' +
    '<textarea class="input mono" rows="' + Math.min(8, list.split('\n').length) +
    '" readonly style="direction:ltr;text-align:left;font-family:monospace">' + esc(list) + '</textarea>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="kcClose">إغلاق</button>' +
    '<button class="btn primary" id="kcCopy">نسخ الكل</button>' +
    '</div>'
  );
  $('#kcClose').onclick = closeModal;
  $('#kcCopy').onclick = () => {
    copyText(list)
      .then(() => toast('تم النسخ', 'success'))
      .catch(() => toast('تعذر النسخ — انسخه يدوياً', 'error'));
  };
}

async function openKeyDetail(id) {
  let data;
  try { data = await api('/keys/' + id); } catch (err) { return showErr(err); }
  const k = data.key;

  const bindings = (data.bindings || []).map((b) =>
    '<div class="tl-row"><span class="tl-time">' + esc(fmtDateTime(b.activated_at)) + '</span>' +
    '<span class="tl-event" style="font-size:12px">' + esc(b.device_label || b.device_id.slice(0, 14)) + '</span>' +
    '<span class="tl-detail">' +
    (b.unbound_at ? 'مفكوك' : 'ينتهي ' + fmtDate(b.expires_at)) +
    ' · آخر ظهور ' + (b.last_seen ? fmtDateTime(b.last_seen) : '—') +
    '</span>' +
    (b.unbound_at ? '' :
      '<button class="btn danger small" data-unbind="' + esc(b.device_id) + '">فك</button>') +
    '</div>'
  ).join('');

  const payments = (data.payments || []).map((p) =>
    '<div class="tl-row"><span class="tl-time">' + esc(fmtDateTime(p.created_at)) + '</span>' +
    '<span class="tl-event" style="color:#86efac">' + esc(fmtMoney(p.amount)) + '</span>' +
    '<span class="tl-detail">' + esc(p.method || '') + ' · ' + esc(p.note || '') + '</span>' +
    '<button class="btn danger small" data-delpay="' + p.id + '">حذف</button>' +
    '</div>'
  ).join('');

  showModal(
    '<h3>مفتاح: <span class="mono" style="direction:ltr">' + esc(k.key_plain) + '</span>' +
    '<button class="copy-key" style="margin-inline-start:8px" data-copy="' + esc(k.key_plain) + '">نسخ</button>' +
    '<button class="m-close" id="kdClose">✕</button></h3>' +

    '<div class="kd-meta">' +
    '<div class="m"><small>الخطة</small><b>' + esc(k.planLabel) + '</b></div>' +
    '<div class="m"><small>الأجهزة</small><b>' + k.active_devices + ' / ' + k.max_devices + '</b></div>' +
    '<div class="m"><small>السعر</small><b>' + esc(fmtMoney(k.price)) + '</b></div>' +
    '<div class="m"><small>المسدد</small><b>' + esc(fmtMoney(data.paidSum)) + '</b></div>' +
    '<div class="m"><small>الحالة</small><b>' +
    (k.revoked_at ? 'موقوف' : k.plan_expires_at && k.plan_expires_at > Date.now() ? 'نشط' : k.plan_expires_at ? 'منتهي' : 'غير مستخدم') +
    '</b></div>' +
    '<div class="m"><small>الانتهاء</small><b>' + (k.plan_expires_at ? esc(fmtDate(k.plan_expires_at)) : '—') + '</b></div>' +
    '<div class="m"><small>ملاحظة</small><b>' + esc(k.note || '—') + '</b></div>' +
    '</div>' +

    '<div class="kd-section"><h4>إجراءات</h4>' +
    '<div class="flex wrap">' +
    '<button class="btn primary small" id="kdExtend">تمديد</button>' +
    '<button class="btn success small" id="kdPay">تسجيل دفعة</button>' +
    (k.revoked_at
      ? '<button class="btn ghost small" id="kdRestore">استعادة</button>'
      : '<button class="btn ghost small" id="kdRevoke">إيقاف</button>') +
    '<button class="btn danger small" id="kdDelete">حذف نهائي</button>' +
    '</div></div>' +

    '<div class="kd-section"><h4>الأجهزة المرتبطة</h4>' +
    (bindings || '<div class="empty">لا أجهزة</div>') + '</div>' +

    '<div class="kd-section"><h4>الدفعات</h4>' +
    (payments || '<div class="empty">لا دفعات</div>') + '</div>',

    true
  );

  $('#kdClose').onclick = closeModal;
  // v3.3: نسخ المفتاح من داخل نافذة التفاصيل أيضاً.
  bindCopy($$('#modalBox [data-copy]'), 'تم نسخ المفتاح');

  $('#kdExtend').onclick = () => openExtendModal(id, k);
  $('#kdPay').onclick = () => openPayModal(id, k, data.paidSum);
  const rev = $('#kdRevoke');
  if (rev) rev.onclick = () =>
    confirmModal('إيقاف المفتاح', 'سيتم إيقاف المفتاح على كل الأجهزة فوراً. هل أنت متأكد؟', 'إيقاف', async () => {
      await api('/keys/' + id + '/revoke', {method: 'POST'});
      toast('تم إيقاف المفتاح', 'success');
      openKeyDetail(id);
    });
  const res_ = $('#kdRestore');
  if (res_) res_.onclick = async () => {
    await api('/keys/' + id + '/restore', {method: 'POST'});
    toast('تمت الاستعادة', 'success');
    openKeyDetail(id);
  };
  $('#kdDelete').onclick = () =>
    confirmModal('حذف نهائي', 'سيحذف المفتاح مع كل أجهزته ودفعاته ولا يمكن التراجع.', 'حذف نهائي', async () => {
      await api('/keys/' + id + '/delete', {method: 'POST'});
      toast('تم الحذف', 'success');
      closeModal();
      viewKeys().catch(showErr);
    });

  $$('#modalBox [data-unbind]').forEach((b) => {
    b.onclick = () =>
      confirmModal('فك الجهاز', 'سيتم تحرير مقعد الجهاز ليتيح ربط جهاز آخر.', 'فك', async () => {
        await api('/keys/' + id + '/unbind', {method: 'POST', body: {deviceId: b.getAttribute('data-unbind')}});
        toast('تم فك الجهاز', 'success');
        openKeyDetail(id);
      });
  });
  $$('#modalBox [data-delpay]').forEach((b) => {
    b.onclick = () =>
      confirmModal('حذف الدفعة', 'سيتم حذف الدفعة من السجل المالي.', 'حذف', async () => {
        await api('/payments/' + b.getAttribute('data-delpay') + '/delete', {method: 'POST'});
        toast('تم حذف الدفعة', 'success');
        openKeyDetail(id);
      });
  });
}

function openExtendModal(id, k) {
  showModal(
    '<h3>تمديد الاشتراك</h3>' +
    '<div class="row-2">' +
    '<div class="field"><label>عدد الأيام</label>' +
    '<input class="input" id="exDays" type="number" min="1" max="3650" value="30"></div>' +
    '<div class="field"><label>المبلغ المدفوع (اختياري)</label>' +
    '<input class="input" id="exAmount" type="number" min="0" step="0.5" placeholder="بدون تسجيل دفعة"></div>' +
    '</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>طريقة الدفع</label>' +
    '<select class="input" id="exMethod"><option value="cash">نقد</option><option value="card">بطاقة</option><option value="other">أخرى</option></select></div>' +
    '<div class="field"><label>ملاحظة</label><input class="input" id="exNote"></div>' +
    '</div>' +
    '<p class="dim tiny">التمديد يشمل كل الأجهزة المرتبطة حالياً ويرتكز على نهاية النافذة الحالية.</p>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="exCancel">إلغاء</button>' +
    '<button class="btn primary" id="exOk">تمديد</button>' +
    '</div>'
  );
  $('#exCancel').onclick = closeModal;
  $('#exOk').onclick = async () => {
    try {
      const amount = $('#exAmount').value;
      await api('/keys/' + id + '/extend', {
        method: 'POST',
        body: {
          days: Number($('#exDays').value),
          amount: amount === '' ? undefined : Number(amount),
          method: $('#exMethod').value,
          note: $('#exNote').value,
        },
      });
      toast('تم التمديد', 'success');
      openKeyDetail(id);
    } catch (err) { showErr(err); }
  };
}

function openPayModal(id, k, paidSum) {
  const remaining = Math.max(0, (k.price || 0) - (paidSum || 0));
  showModal(
    '<h3>تسجيل دفعة</h3>' +
    '<p class="dim tiny mb">المتبقي على المفتاح: ' + esc(fmtMoney(remaining)) + '</p>' +
    '<div class="row-2">' +
    '<div class="field"><label>المبلغ</label>' +
    '<input class="input" id="payAmount" type="number" min="0" step="0.5" value="' + remaining + '"></div>' +
    '<div class="field"><label>الطريقة</label>' +
    '<select class="input" id="payMethod"><option value="cash">نقد</option><option value="card">بطاقة</option><option value="other">أخرى</option></select></div>' +
    '</div>' +
    '<div class="field"><label>ملاحظة</label><input class="input" id="payNote"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="payCancel">إلغاء</button>' +
    '<button class="btn primary" id="payOk">تسجيل</button>' +
    '</div>'
  );
  $('#payCancel').onclick = closeModal;
  $('#payOk').onclick = async () => {
    try {
      await api('/keys/' + id + '/pay', {
        method: 'POST',
        body: {
          amount: $('#payAmount').value === '' ? undefined : Number($('#payAmount').value),
          method: $('#payMethod').value,
          note: $('#payNote').value,
        },
      });
      toast('تم تسجيل الدفعة', 'success');
      openKeyDetail(id);
    } catch (err) { showErr(err); }
  };
}

/* ═══════════════════ VIEW: payments ═══════════════════ */

async function viewPayments() {
  const data = await api('/payments?limit=200');
  const payments = data.payments || [];

  const rows = payments.map((p) =>
    '<tr>' +
    '<td class="dim tiny">' + esc(fmtDateTime(p.created_at)) + '</td>' +
    '<td class="num" style="color:#86efac;font-weight:700">' + esc(fmtMoney(p.amount)) + '</td>' +
    '<td>' + (p.method === 'cash' ? 'نقد' : p.method === 'card' ? 'بطاقة' : esc(p.method)) + '</td>' +
    '<td class="mono tiny">' + (p.key_plain ? esc(p.key_plain) : '<span class="dim">—</span>') + '</td>' +
    '<td class="dim tiny">' + esc(p.note || '') + '</td>' +
    '<td class="dim tiny">' + esc(p.admin_name || '') + '</td>' +
    '<td class="actions"><button class="btn danger small" data-delpay="' + p.id + '">حذف</button></td>' +
    '</tr>'
  ).join('');

  const cards = payments.map((p) =>
    '<div class="mcard">' +
    '<div class="m-top"><span style="color:#86efac;font-weight:800">' + esc(fmtMoney(p.amount)) + '</span>' +
    '<span class="dim tiny">' + esc(fmtDateTime(p.created_at)) + '</span></div>' +
    '<div class="m-rows">' +
    '<div class="r"><span>المفتاح</span><b class="mono" style="direction:ltr">' + esc(p.key_plain || '—') + '</b></div>' +
    '<div class="r"><span>الطريقة</span><b>' + (p.method === 'cash' ? 'نقد' : p.method === 'card' ? 'بطاقة' : esc(p.method)) + '</b></div>' +
    (p.note ? '<div class="r"><span>ملاحظة</span><b>' + esc(p.note) + '</b></div>' : '') +
    '</div>' +
    '<div class="m-actions"><button class="btn danger small" data-delpay="' + p.id + '">حذف</button></div>' +
    '</div>'
  ).join('');

  const total = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>المدفوعات</h1>' +
    '<div class="sub">' + payments.length + ' دفعة · إجمالي معروض: ' + esc(fmtMoney(total)) + '</div></div>' +
    '<div class="page-actions"><button class="btn primary" id="btnAddPay">+ دفعة يدوية</button></div></div>' +
    '<div class="card">' +
    (payments.length
      ? '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th>المفتاح</th><th>ملاحظة</th><th>بواسطة</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="cards-list">' + cards + '</div>'
      : '<div class="empty">لا مدفوعات مسجلة بعد</div>') +
    '</div>';

  $('#btnAddPay').onclick = openAddPayment;
  $$('#view [data-delpay]').forEach((b) => {
    b.onclick = () =>
      confirmModal('حذف الدفعة', 'سيتم حذف الدفعة من السجل المالي نهائياً.', 'حذف', async () => {
        await api('/payments/' + b.getAttribute('data-delpay') + '/delete', {method: 'POST'});
        toast('تم الحذف', 'success');
        viewPayments().catch(showErr);
      });
  });
}

function openAddPayment() {
  showModal(
    '<h3>دفعة يدوية</h3>' +
    '<div class="row-2">' +
    '<div class="field"><label>المبلغ</label>' +
    '<input class="input" id="apAmount" type="number" min="0" step="0.5" required></div>' +
    '<div class="field"><label>الطريقة</label>' +
    '<select class="input" id="apMethod"><option value="cash">نقد</option><option value="card">بطاقة</option><option value="other">أخرى</option></select></div>' +
    '</div>' +
    '<div class="field"><label>رقم المفتاح (اختياري)</label>' +
    '<input class="input" id="apKey" type="number" min="1" placeholder="معرّف المفتاح #"></div>' +
    '<div class="field"><label>ملاحظة</label><input class="input" id="apNote"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="apCancel">إلغاء</button>' +
    '<button class="btn primary" id="apOk">تسجيل</button>' +
    '</div>'
  );
  $('#apCancel').onclick = closeModal;
  $('#apOk').onclick = async () => {
    try {
      await api('/payments', {
        method: 'POST',
        body: {
          amount: Number($('#apAmount').value),
          method: $('#apMethod').value,
          keyId: $('#apKey').value === '' ? undefined : Number($('#apKey').value),
          note: $('#apNote').value,
        },
      });
      toast('تم التسجيل', 'success');
      closeModal();
      viewPayments().catch(showErr);
    } catch (err) { showErr(err); }
  };
}

/* ═══════════════════ VIEW: landing page manager ═══════════════════ */

const FEATURE_ICONS = {
  scan: 'ماسح', book: 'دفتر', store: 'متجر', boxes: 'مخزون',
  chart: 'تقارير', printer: 'طباعة', star: 'نجمة', shield: 'حماية',
  zap: 'سرعة', users: 'زبائن', wallet: 'محفظة',
};

const PLATFORM_LABELS = {
  google_play: 'جوجل بلاي',
  direct_apk: 'رابط مباشر (APK)',
  desktop: 'سطح المكتب',
  apple_store: 'آبل ستور',
};

async function viewLanding() {
  const [site, media] = await Promise.all([api('/site'), api('/media')]);
  const hero = site.hero || {};

  /* features editor rows */
  const featRows = (site.features || []).map((f, i) =>
    '<div class="feat-row" data-fi="' + i + '">' +
    '<div class="flex">' +
    '<div class="feat-icon-preview">' + featureIconSvg(f.icon) + '</div>' +
    '<select class="input" data-f="icon" style="padding:8px 10px">' +
    Object.keys(FEATURE_ICONS).map((k) =>
      '<option value="' + k + '"' + (k === f.icon ? ' selected' : '') + '>' + FEATURE_ICONS[k] + '</option>'
    ).join('') +
    '</select></div>' +
    '<input class="input" data-f="title" placeholder="العنوان" value="' + esc(f.title) + '" maxlength="80">' +
    '<textarea class="input" data-f="text" placeholder="الوصف" maxlength="300" style="min-height:44px">' + esc(f.text) + '</textarea>' +
    '<button class="btn danger small" data-fdel="' + i + '">حذف</button>' +
    '</div>'
  ).join('');

  /* screenshots grid */
  const shotGrid = (media.media || []).map((m, i) =>
    '<div class="shot-item">' +
    '<img src="/media/' + esc(m.filename) + '" alt="' + esc(m.title || '') + '" loading="lazy">' +
    '<div class="s-bar">' +
    '<span class="s-idx">#' + (i + 1) + '</span>' +
    '<div class="s-btns">' +
    '<button class="icon-btn" data-mup="' + m.id + '" title="تقديم"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg></button>' +
    '<button class="icon-btn" data-mdown="' + m.id + '" title="تأخير"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg></button>' +
    '<button class="icon-btn danger" data-mdel="' + m.id + '" title="حذف"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>' +
    '</div></div></div>'
  ).join('');

  /* download links rows */
  const dlRows = (site.downloads || []).map((d) =>
    '<div class="switch-row">' +
    '<div class="s-label">' + esc(PLATFORM_LABELS[d.platform] || d.platform) +
    '<small>يظهر زر التحميل في الصفحة عند التفعيل (يتطلب رابطاً صحيحاً)</small></div>' +
    '<div class="flex grow" style="max-width:420px">' +
    '<input class="input" data-dl="' + d.platform + '" dir="ltr" style="text-align:left" ' +
    'placeholder="https://…" value="' + esc(d.url || '') + '">' +
    '<label class="switch"><input type="checkbox" data-dle="' + d.platform + '"' +
    (d.enabled ? ' checked' : '') + '><span class="track"></span></label>' +
    '</div></div>'
  ).join('');

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>صفحة الهبوط</h1>' +
    '<div class="sub">محتوى الصفحة الرئيسية للموقع — كل تغيير يظهر فوراً</div></div>' +
    '<div class="page-actions">' +
    '<a class="btn ghost" href="/" target="_blank" rel="noopener">معاينة الموقع ↗</a>' +
    '<button class="btn primary" id="landingSave">حفظ التغييرات</button>' +
    '</div></div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z"/></svg>' +
    'القسم الرئيسي (Hero)</div>' +
    '<div class="field"><label>الشارة العلوية (اختياري)</label>' +
    '<input class="input" id="hBadge" maxlength="120" value="' + esc(hero.badge || '') + '" placeholder="مثال: الإصدار الجديد متوفر الآن"></div>' +
    '<div class="field"><label>العنوان الرئيسي</label>' +
    '<input class="input" id="hTitle" maxlength="160" value="' + esc(hero.title || '') + '"></div>' +
    '<div class="field"><label>الوصف</label>' +
    '<textarea class="input" id="hSubtitle" maxlength="600">' + esc(hero.subtitle || '') + '</textarea></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>نص زر الدعوة</label>' +
    '<input class="input" id="hCta" maxlength="80" value="' + esc(hero.ctaText || '') + '"></div>' +
    '<div class="field"><label>إظهار قسم الأسعار في الصفحة</label>' +
    '<div class="switch-row" style="padding:6px 0">' +
    '<span class="s-label">إظهار الخطط والأسعار</span>' +
    '<label class="switch"><input type="checkbox" id="hPricing"' +
    (site.pricingShow ? ' checked' : '') + '><span class="track"></span></label>' +
    '</div></div>' +
    '</div></div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round"><path d="M4 5h16v11H4z"/><path d="M4 5l8 7 8-7"/></svg>' +
    'المميزات' +
    '<span class="hint">تظهر كبطاقات في الصفحة</span></div>' +
    '<div id="featList">' + (featRows || '') + '</div>' +
    '<button class="btn ghost" id="featAdd">+ إضافة ميزة</button>' +
    '</div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>' +
    'صور التطبيق' +
    '<span class="hint">' + (media.media || []).length + ' صورة</span></div>' +
    '<div class="upload-zone" id="shotUpload">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>' +
    '<div><b>اضغط لاختيار صور</b> أو اسحبها هنا</div>' +
    '<div class="u-hint">PNG / JPG / WebP — حتى 8MB للصورة — تظهر داخل إطار هاتف في الصفحة</div>' +
    '</div>' +
    '<div id="shotProgress" class="hidden dim tiny mb"></div>' +
    ((media.media || []).length
      ? '<div class="shot-grid">' + shotGrid + '</div>'
      : '<div class="empty">لم تُرفع صور بعد — ارفع لقطات من التطبيق لتظهر في صفحة الهبوط</div>') +
    '</div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>' +
    'روابط تحميل التطبيق' +
    '<span class="hint">الزر يظهر في الصفحة فور إضافة الرابط وتفعيله</span></div>' +
    dlRows +
    '</div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H4z"/><path d="M4 5l8 7 8-7"/><path d="M9 20h6"/><path d="M12 16v4"/></svg>' +
    'الخاتمة (Footer)</div>' +
    '<div class="field"><label>نص الخاتمة</label>' +
    '<input class="input" id="hFooter" maxlength="160" value="' + esc(site.footerNote || '') + '"></div>' +
    '<div class="field"><label>وصف SEO (يظهر في نتائج البحث)</label>' +
    '<textarea class="input" id="hSeo" maxlength="300">' + esc(site.seoDescription || '') + '</textarea></div>' +
    '</div>' +

    '<div class="flex" style="justify-content:flex-end">' +
    '<button class="btn primary" id="landingSave2">حفظ التغييرات</button></div>';

  /* features add/remove */
  $('#featAdd').onclick = () => {
    const idx = $$('#featList .feat-row').length;
    const div = document.createElement('div');
    div.className = 'feat-row';
    div.innerHTML =
      '<div class="flex">' +
      '<div class="feat-icon-preview">' + featureIconSvg('star') + '</div>' +
      '<select class="input" data-f="icon" style="padding:8px 10px">' +
      Object.keys(FEATURE_ICONS).map((k) => '<option value="' + k + '">' + FEATURE_ICONS[k] + '</option>').join('') +
      '</select></div>' +
      '<input class="input" data-f="title" placeholder="العنوان" maxlength="80">' +
      '<textarea class="input" data-f="text" placeholder="الوصف" maxlength="300" style="min-height:44px"></textarea>' +
      '<button class="btn danger small" data-fdel="' + idx + '">حذف</button>';
    $('#featList').appendChild(div);
    wireFeatRow(div);
  };
  $$('#featList .feat-row').forEach(wireFeatRow);

  function wireFeatRow(row) {
    const sel = row.querySelector('select[data-f="icon"]');
    if (sel) sel.onchange = () => {
      row.querySelector('.feat-icon-preview').innerHTML = featureIconSvg(sel.value);
    };
    const del = row.querySelector('[data-fdel]');
    if (del) del.onclick = () => row.remove();
  }

  /* upload */
  const zone = $('#shotUpload');
  const fileInput = $('#fileInput');
  zone.onclick = () => fileInput.click();
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('drag'); };
  zone.ondragleave = () => zone.classList.remove('drag');
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    uploadShots(Array.from(e.dataTransfer.files || []));
  };
  fileInput.onchange = () => {
    uploadShots(Array.from(fileInput.files || []));
    fileInput.value = '';
  };

  async function uploadShots(files) {
    const imgs = files.filter((f) => /^image\/(png|jpe?g|webp)$/i.test(f.type));
    if (!imgs.length) return toast('اختر صور PNG أو JPG أو WebP فقط', 'error');
    const prog = $('#shotProgress');
    prog.classList.remove('hidden');
    let done = 0, fail = 0;
    for (const f of imgs) {
      prog.textContent = 'جارٍ الرفع… ' + (done + fail + 1) + ' / ' + imgs.length + ' — ' + f.name;
      try {
        const b64 = await fileToBase64(f);
        await api('/media', {
          method: 'POST',
          body: {name: f.name, mime: f.type, dataBase64: b64, title: ''},
        });
        done++;
      } catch (err) {
        fail++;
        toast('فشل رفع ' + f.name + ': ' + err.message, 'error');
      }
    }
    prog.classList.add('hidden');
    if (done) toast('تم رفع ' + done + ' صورة', 'success');
    viewLanding().catch(showErr);
  }

  /* media actions */
  $$('#view [data-mup]').forEach((b) => {
    b.onclick = async () => {
      await api('/media/' + b.getAttribute('data-mup') + '/move', {method: 'POST', body: {dir: 'up'}});
      viewLanding().catch(showErr);
    };
  });
  $$('#view [data-mdown]').forEach((b) => {
    b.onclick = async () => {
      await api('/media/' + b.getAttribute('data-mdown') + '/move', {method: 'POST', body: {dir: 'down'}});
      viewLanding().catch(showErr);
    };
  });
  $$('#view [data-mdel]').forEach((b) => {
    b.onclick = () =>
      confirmModal('حذف الصورة', 'ستُحذف الصورة من صفحة الهبوط نهائياً.', 'حذف', async () => {
        await api('/media/' + b.getAttribute('data-mdel') + '/delete', {method: 'POST'});
        toast('تم الحذف', 'success');
        viewLanding().catch(showErr);
      });
  });

  /* save */
  const save = () => saveLanding();
  $('#landingSave').onclick = save;
  $('#landingSave2').onclick = save;
}

function featureIconSvg(name) {
  const paths = {
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.2"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    store: '<path d="M3 9l1.5-5.5h15L21 9"/><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21v-6h6v6"/>',
    boxes: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3.3 8.3L12 13l8.7-4.7"/><path d="M12 13v9"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/>',
    printer: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/>',
    star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
    shield: '<path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z"/>',
    zap: '<path d="M13 2L3 14h7l-1 8 11-13h-7z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    wallet: '<path d="M20 7H4a2 2 0 0 1 0-4h14v4"/><path d="M4 5v14a2 2 0 0 0 2 2h14V7"/><path d="M16 14h2"/>',
  };
  return '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    (paths[name] || paths.star) + '</svg>';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ''));
    r.onerror = () => reject(new Error('READ_FAILED'));
    r.readAsDataURL(file);
  });
}

async function saveLanding() {
  const features = $$('#featList .feat-row').map((row) => ({
    icon: row.querySelector('[data-f="icon"]').value,
    title: row.querySelector('[data-f="title"]').value.trim(),
    text: row.querySelector('[data-f="text"]').value.trim(),
  })).filter((f) => f.title);

  const downloads = {};
  $$('#view [data-dl]').forEach((inp) => {
    downloads[inp.getAttribute('data-dl')] = {
      url: inp.value.trim(),
      enabled: false,
    };
  });
  $$('#view [data-dle]').forEach((sw) => {
    const p = sw.getAttribute('data-dle');
    if (downloads[p]) downloads[p].enabled = sw.checked;
  });

  const body = {
    hero: {
      badge: $('#hBadge').value,
      title: $('#hTitle').value,
      subtitle: $('#hSubtitle').value,
      ctaText: $('#hCta').value,
    },
    features,
    downloads: Object.keys(downloads).map((p) => ({
      platform: p,
      url: downloads[p].url,
      enabled: downloads[p].enabled,
    })),
    pricingShow: $('#hPricing').checked,
    footerNote: $('#hFooter').value,
    seoDescription: $('#hSeo').value,
  };

  try {
    await api('/site', {method: 'PUT', body});
    toast('تم حفظ صفحة الهبوط — التغييرات ظاهرة فوراً', 'success');
  } catch (err) { showErr(err); }
}

/* ═══════════════════ VIEW: contact ═══════════════════ */

const CONTACT_TYPE_META = {
  phone: {label: 'هاتف', bg: 'rgba(34,197,94,0.13)', stroke: '#22c55e'},
  whatsapp: {label: 'واتساب', bg: 'rgba(37,211,102,0.13)', stroke: '#25d366'},
  telegram: {label: 'تيليجرام', bg: 'rgba(56,189,248,0.13)', stroke: '#38bdf8'},
  email: {label: 'بريد إلكتروني', bg: 'rgba(249,115,22,0.13)', stroke: '#f97316'},
  website: {label: 'موقع/رابط', bg: 'rgba(168,85,247,0.13)', stroke: '#a855f7'},
  custom: {label: 'مخصص', bg: 'rgba(148,163,184,0.13)', stroke: '#94a3b8'},
};

function contactTypeSvg(type) {
  const svgs = {
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.13.96.36 1.9.7 2.8a2 2 0 0 1-.45 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.45c.9.34 1.84.57 2.8.7a2 2 0 0 1 1.7 2.05z"/>',
    whatsapp: '<path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2z"/>',
    telegram: '<path d="M21.9 4.6l-3.1 14.5c-.23 1.02-.85 1.27-1.72.79l-4.75-3.5-2.29 2.2c-.25.26-.46.47-.95.47l.34-4.8L18.2 6.7c.38-.34-.08-.53-.6-.19L6.9 13.4l-4.65-1.45c-1.01-.32-1.03-1.01.21-1.5l18.1-6.98c.84-.31 1.58.19 1.34 1.13z"/>',
    email: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M22 7l-10 6L2 7"/>',
    website: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c-2.7 2.6-4 5.7-4 9.5s1.3 6.9 4 9.5c2.7-2.6 4-5.7 4-9.5s-1.3-6.9-4-9.5z"/>',
    custom: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  };
  const m = CONTACT_TYPE_META[type] || CONTACT_TYPE_META.custom;
  return '<svg viewBox="0 0 24 24" fill="none" stroke="' + m.stroke +
    '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    (svgs[type] || svgs.custom) + '</svg>';
}

async function viewContact() {
  const [optsRes, cfg] = await Promise.all([
    api('/contact-options'),
    api('/config'),
  ]);
  const options = optsRes.options || [];

  const optRows = options.map((o) => {
    const m = CONTACT_TYPE_META[o.type] || CONTACT_TYPE_META.custom;
    return '<div class="opt-row">' +
      '<div class="o-icon" style="background:' + m.bg + ';border:1px solid ' + m.stroke + '40">' +
      contactTypeSvg(o.type) + '</div>' +
      '<div class="o-main"><b>' + esc(o.label) + '</b><span>' + esc(o.value) + '</span></div>' +
      '<span class="badge ' + (o.enabled ? 'green' : 'gray') + '">' + (o.enabled ? 'ظاهر' : 'مخفي') + '</span>' +
      '<div class="o-btns">' +
      '<button class="icon-btn" data-oup="' + o.id + '" title="تقديم"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg></button>' +
      '<button class="icon-btn" data-odown="' + o.id + '" title="تأخير"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg></button>' +
      '<button class="icon-btn" data-oedit="' + o.id + '" title="تعديل"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></button>' +
      '<button class="icon-btn" data-otoggle="' + o.id + '" data-enabled="' + o.enabled + '" title="إظهار/إخفاء"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>' +
      '<button class="icon-btn danger" data-odel="' + o.id + '" title="حذف"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>' +
      '</div></div>';
  }).join('');

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>التواصل</h1>' +
    '<div class="sub">خيارات صفحة التواصل + بيانات التواصل داخل التطبيق</div></div>' +
    '<div class="page-actions">' +
    '<a class="btn ghost" href="/contact" target="_blank" rel="noopener">معاينة الصفحة ↗</a>' +
    '<button class="btn primary" id="optAdd">+ إضافة خيار</button>' +
    '</div></div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    'خيارات صفحة التواصل (الموقع)' +
    '<span class="hint">تظهر كبطاقات قابلة للنقر</span></div>' +
    (options.length
      ? optRows
      : '<div class="empty">لا خيارات بعد — أضف هاتفاً أو واتساب ليظهر للزوار</div>') +
    '</div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M12 18h.01"/></svg>' +
    'بيانات التواصل داخل تطبيق سيلا' +
    '<span class="hint">تظهر في شاشة الاشتراك داخل التطبيق</span></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>الهاتف</label><input class="input" id="cPhone" dir="ltr" value="' + esc(cfg.contact.phone || '') + '"></div>' +
    '<div class="field"><label>واتساب</label><input class="input" id="cWhats" dir="ltr" value="' + esc(cfg.contact.whatsapp || '') + '"></div>' +
    '</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>تيليجرام</label><input class="input" id="cTele" dir="ltr" value="' + esc(cfg.contact.telegram || '') + '"></div>' +
    '<div class="field"><label>البريد الإلكتروني</label><input class="input" id="cEmail" dir="ltr" value="' + esc(cfg.contact.email || '') + '"></div>' +
    '</div>' +
    '<div class="field"><label>ملاحظة التواصل</label>' +
    '<input class="input" id="cNote" maxlength="200" value="' + esc(cfg.contact.note || '') + '"></div>' +
    '<button class="btn primary" id="cSave">حفظ بيانات التطبيق</button>' +
    '</div>';

  $('#optAdd').onclick = () => openOptionModal(null);
  $$('#view [data-oedit]').forEach((b) => {
    b.onclick = () => {
      const o = options.filter((x) => String(x.id) === b.getAttribute('data-oedit'))[0];
      if (o) openOptionModal(o);
    };
  });
  $$('#view [data-otoggle]').forEach((b) => {
    b.onclick = async () => {
      const enabled = b.getAttribute('data-enabled') === '1';
      await api('/contact-options/' + b.getAttribute('data-otoggle'), {
        method: 'POST', body: {enabled: !enabled},
      });
      toast(!enabled ? 'أصبح الخيار ظاهراً' : 'تم إخفاء الخيار', 'success');
      viewContact().catch(showErr);
    };
  });
  $$('#view [data-oup]').forEach((b) => {
    b.onclick = async () => {
      await api('/contact-options/' + b.getAttribute('data-oup') + '/move', {method: 'POST', body: {dir: 'up'}});
      viewContact().catch(showErr);
    };
  });
  $$('#view [data-odown]').forEach((b) => {
    b.onclick = async () => {
      await api('/contact-options/' + b.getAttribute('data-odown') + '/move', {method: 'POST', body: {dir: 'down'}});
      viewContact().catch(showErr);
    };
  });
  $$('#view [data-odel]').forEach((b) => {
    b.onclick = () =>
      confirmModal('حذف خيار التواصل', 'سيختفي من صفحة التواصل فوراً.', 'حذف', async () => {
        await api('/contact-options/' + b.getAttribute('data-odel') + '/delete', {method: 'POST'});
        toast('تم الحذف', 'success');
        viewContact().catch(showErr);
      });
  });

  $('#cSave').onclick = async () => {
    try {
      await api('/config', {
        method: 'PUT',
        body: {
          phone: $('#cPhone').value,
          whatsapp: $('#cWhats').value,
          telegram: $('#cTele').value,
          email: $('#cEmail').value,
          note: $('#cNote').value,
        },
      });
      toast('تم حفظ بيانات التواصل داخل التطبيق', 'success');
    } catch (err) { showErr(err); }
  };
}

function openOptionModal(o) {
  const isEdit = !!o;
  showModal(
    '<h3>' + (isEdit ? 'تعديل خيار تواصل' : 'خيار تواصل جديد') + '</h3>' +
    '<div class="row-2">' +
    '<div class="field"><label>النوع</label>' +
    '<select class="input" id="omType">' +
    Object.keys(CONTACT_TYPE_META).map((t) =>
      '<option value="' + t + '"' + (o && o.type === t ? ' selected' : '') + '>' +
      CONTACT_TYPE_META[t].label + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>الاسم الظاهر</label>' +
    '<input class="input" id="omLabel" maxlength="60" value="' + esc(o ? o.label : '') + '" placeholder="مثال: خدمة الزبائن"></div>' +
    '</div>' +
    '<div class="field"><label>القيمة (رقم/رابط/بريد)</label>' +
    '<input class="input" id="omValue" dir="ltr" maxlength="300" value="' + esc(o ? o.value : '') + '" placeholder="+972 5x xxx xxxx"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="omCancel">إلغاء</button>' +
    '<button class="btn primary" id="omOk">' + (isEdit ? 'حفظ' : 'إضافة') + '</button>' +
    '</div>'
  );
  $('#omCancel').onclick = closeModal;
  $('#omOk').onclick = async () => {
    try {
      const body = {
        type: $('#omType').value,
        label: $('#omLabel').value.trim(),
        value: $('#omValue').value.trim(),
      };
      if (!body.label || !body.value) return toast('أكمل الاسم والقيمة', 'error');
      if (isEdit) {
        Object.assign(body, {enabled: o.enabled});
        await api('/contact-options/' + o.id, {method: 'POST', body});
      } else {
        await api('/contact-options', {method: 'POST', body});
      }
      toast(isEdit ? 'تم الحفظ' : 'تمت الإضافة — الخيار ظاهر الآن في الصفحة', 'success');
      closeModal();
      viewContact().catch(showErr);
    } catch (err) { showErr(err); }
  };
}

/* ═══════════════════ VIEW: admins ═══════════════════ */

async function viewAdmins() {
  if (ME.role !== 'owner') {
    $('#view').innerHTML = '<div class="card"><div class="empty">هذا القسم لمدير النظام فقط</div></div>';
    return;
  }
  const data = await api('/admins');
  const admins = data.admins || [];

  const rows = admins.map((a) =>
    '<tr>' +
    '<td class="mono tiny">' + esc(a.email) + '</td>' +
    '<td>' + esc(a.name) + '</td>' +
    '<td>' + (a.role === 'owner' ? '<span class="badge orange">مالك</span>' : '<span class="badge blue">مشرف</span>') + '</td>' +
    '<td>' + (a.disabled ? '<span class="badge red">موقوف</span>' : '<span class="badge green">نشط</span>') + '</td>' +
    '<td class="dim tiny">' + (a.last_login_at ? esc(fmtDateTime(a.last_login_at)) : '—') + '</td>' +
    '<td class="actions">' +
    '<button class="btn ghost small" data-aedit="' + a.id + '">تعديل</button>' +
    '<button class="btn danger small" data-adel="' + a.id + '">حذف</button>' +
    '</td></tr>'
  ).join('');

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>المشرفون</h1>' +
    '<div class="sub">حسابات الدخول للوحة</div></div>' +
    '<div class="page-actions"><button class="btn primary" id="aAdd">+ مشرف جديد</button></div></div>' +
    '<div class="card">' +
    '<div class="table-wrap"><table class="tbl"><thead><tr>' +
    '<th>البريد</th><th>الاسم</th><th>الدور</th><th>الحالة</th><th>آخر دخول</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="cards-list">' + admins.map((a) =>
      '<div class="mcard"><div class="m-top"><span class="m-title">' + esc(a.email) + '</span>' +
      (a.role === 'owner' ? '<span class="badge orange">مالك</span>' : '<span class="badge blue">مشرف</span>') + '</div>' +
      '<div class="m-rows"><div class="r"><span>الاسم</span><b>' + esc(a.name) + '</b></div>' +
      '<div class="r"><span>الحالة</span><b>' + (a.disabled ? 'موقوف' : 'نشط') + '</b></div>' +
      '<div class="r"><span>آخر دخول</span><b>' + (a.last_login_at ? esc(fmtDateTime(a.last_login_at)) : '—') + '</b></div></div>' +
      '<div class="m-actions"><button class="btn ghost small" data-aedit="' + a.id + '">تعديل</button>' +
      '<button class="btn danger small" data-adel="' + a.id + '">حذف</button></div></div>'
    ).join('') + '</div>' +
    '</div>';

  $('#aAdd').onclick = () => openAdminModal(null);
  $$('#view [data-aedit]').forEach((b) => {
    b.onclick = () => {
      const a = admins.filter((x) => String(x.id) === b.getAttribute('data-aedit'))[0];
      if (a) openAdminModal(a);
    };
  });
  $$('#view [data-adel]').forEach((b) => {
    b.onclick = () =>
      confirmModal('حذف المشرف', 'سيُحذف الحساب ولن يستطيع الدخول للوحة.', 'حذف', async () => {
        await api('/admins/' + b.getAttribute('data-adel') + '/delete', {method: 'POST'});
        toast('تم الحذف', 'success');
        viewAdmins().catch(showErr);
      });
  });
}

function openAdminModal(a) {
  const isEdit = !!a;
  showModal(
    '<h3>' + (isEdit ? 'تعديل مشرف' : 'مشرف جديد') + '</h3>' +
    '<div class="field"><label>البريد الإلكتروني</label>' +
    '<input class="input" id="amEmail" dir="ltr" ' + (isEdit ? 'disabled value="' + esc(a.email) + '"' : '') + '></div>' +
    '<div class="row-2">' +
    '<div class="field"><label>الاسم</label>' +
    '<input class="input" id="amName" maxlength="80" value="' + esc(a ? a.name : '') + '"></div>' +
    '<div class="field"><label>الدور</label>' +
    '<select class="input" id="amRole">' +
    '<option value="staff"' + (a && a.role !== 'owner' ? ' selected' : '') + '>مشرف</option>' +
    '<option value="owner"' + (a && a.role === 'owner' ? ' selected' : '') + '>مالك</option>' +
    '</select></div>' +
    '</div>' +
    '<div class="field"><label>كلمة مرور جديدة (اتركها فارغة للإبقاء)</label>' +
    '<input class="input" id="amPass" type="password" minlength="6" dir="ltr"></div>' +
    (isEdit
      ? '<div class="switch-row"><span class="s-label">الحساب مفعّل</span>' +
        '<label class="switch"><input type="checkbox" id="amEnabled"' +
        (!a.disabled ? ' checked' : '') + '><span class="track"></span></label></div>'
      : '') +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="amCancel">إلغاء</button>' +
    '<button class="btn primary" id="amOk">' + (isEdit ? 'حفظ' : 'إنشاء') + '</button>' +
    '</div>'
  );
  $('#amCancel').onclick = closeModal;
  $('#amOk').onclick = async () => {
    try {
      if (isEdit) {
        const body = {
          name: $('#amName').value,
          role: $('#amRole').value,
          disabled: !$('#amEnabled').checked,
        };
        const pass = $('#amPass').value;
        if (pass) body.password = pass;
        await api('/admins/' + a.id, {method: 'POST', body});
      } else {
        await api('/admins', {
          method: 'POST',
          body: {
            email: $('#amEmail').value.trim(),
            name: $('#amName').value,
            password: $('#amPass').value,
            role: $('#amRole').value,
          },
        });
      }
      toast('تم الحفظ', 'success');
      closeModal();
      viewAdmins().catch(showErr);
    } catch (err) { showErr(err); }
  };
}

/* ═══════════════════ VIEW: audit ═══════════════════ */

async function viewAudit() {
  const data = await api('/audit?limit=200');
  const events = data.events || [];
  const uniqEvents = [...new Set(events.map((e) => e.event))];

  const rows = events.map((e) =>
    '<div class="tl-row">' +
    '<span class="tl-time">' + esc(fmtDateTime(e.ts)) + '</span>' +
    '<span class="tl-event">' + esc(e.event) + '</span>' +
    '<span class="tl-detail">' + esc(e.details || e.ip || '') + '</span>' +
    '</div>'
  ).join('');

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>سجل الأحداث</h1>' +
    '<div class="sub">' + events.length + ' حدث — الدخول والعمليات الحساسة</div></div>' +
    '<div class="page-actions"><select class="input" id="auditFilter" style="width:auto">' +
    '<option value="">كل الأحداث</option>' +
    uniqEvents.map((ev) => '<option value="' + esc(ev) + '">' + esc(ev) + '</option>').join('') +
    '</select></div></div>' +
    '<div class="card"><div class="tl">' +
    (rows || '<div class="empty">لا أحداث</div>') +
    '</div></div>';

  $('#auditFilter').onchange = async (e) => {
    const v = e.target.value;
    const d = await api('/audit?limit=200' + (v ? '&event=' + encodeURIComponent(v) : ''));
    const evs2 = d.events || [];
    $('#view .tl').innerHTML = evs2.map((e2) =>
      '<div class="tl-row">' +
      '<span class="tl-time">' + esc(fmtDateTime(e2.ts)) + '</span>' +
      '<span class="tl-event">' + esc(e2.event) + '</span>' +
      '<span class="tl-detail">' + esc(e2.details || e2.ip || '') + '</span>' +
      '</div>'
    ).join('') || '<div class="empty">لا أحداث</div>';
  };
}

/* ═══════════════════ VIEW: market (المتاجر والطلبات) ═══════════════════ */

const MARKET_STATUS_LABELS = {
  new: ['جديد', 'amber'],
  accepted: ['مقبول', 'amber'],
  sent: ['مُرسل', 'amber'],
  delivered: ['مُسلّم', 'green'],
  rejected: ['مرفوض', 'red'],
  cancelled: ['ملغي', 'red'],
  returned: ['مُرجع', 'red'],
};

/* v4.6 — شعار دائري للمتجر (صورة تطبيق نقطة البيع أو الحرف الأول) */
function storeAvatarHtml(logoUrl, name, size) {
  const px = size || 34;
  if (logoUrl) {
    return '<img class="store-logo" src="' + esc(logoUrl) + '" alt="' + esc(name) +
      '" style="width:' + px + 'px;height:' + px + 'px" loading="lazy">';
  }
  return '<span class="store-logo letter" style="width:' + px + 'px;height:' + px + 'px;font-size:' +
    Math.round(px * 0.42) + 'px">' + esc(String(name || 'م').trim().charAt(0) || 'م') + '</span>';
}

/* v4.6 — عرض التقييم نجومًا رقميًا: ★ 4.6 (12 تقييم) */
function ratingHtml(avg, count) {
  if (!count) return '<span class="dim tiny">لا تقييمات بعد</span>';
  return '<span class="rating-inline">' +
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="#fbbf24" stroke="#f59e0b" stroke-width="1"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>' +
    '<b>' + (Number(avg) || 0).toFixed(1) + '</b>' +
    '<small class="dim">(' + count + ')</small></span>';
}

async function viewMarket() {
  const [stats, stores] = await Promise.all([
    api('/market/stats'),
    api('/market/stores'),
  ]);

  const kpi = (label, value, sub, cls) =>
    '<div class="kpi' + (cls ? ' ' + cls : '') + '"><div class="k-label">' + esc(label) +
    '</div><div class="k-value">' + value + '</div>' +
    (sub ? '<div class="k-sub">' + sub + '</div>' : '') + '</div>';

  const money = (minor) => fmtMoney((Number(minor) || 0) / 100);

  /* v4.6: كان الشريط يستخدم فئة kpis غير موجودة (خطأ تاريخي) —
   * الصحيح kpi-grid مثل بقية اللوحة، وإلا انهارت البطاقات عموديًا. */
  const ratingSub = stats.ratingCount
    ? 'متوسط ' + (Number(stats.ratingAvg) || 0).toFixed(1) + ' من ' + stats.ratingCount + ' تقييم'
    : 'لا تقييمات بعد';

  const storeRows = (stores.stores || []).map((s) =>
    '<tr>' +
    '<td><div class="store-cell">' + storeAvatarHtml(s.logo_url, s.name, 34) +
    '<div><b>' + esc(s.name) + '</b><br><span class="dim tiny mono" dir="ltr">' + esc(s.store_number) + '</span></div></div></td>' +
    '<td>' + (s.published
      ? '<span class="badge green">منشور</span>'
      : '<span class="badge">مخفي</span>') + '</td>' +
    '<td>' + (s.subscriptionActive
      ? '<span class="badge green">فعّال</span>'
      : '<span class="badge red">منتهي</span>') + '</td>' +
    '<td class="num">' + (s.products_count || 0) +
      (s.offers_count > 0 ? ' <span class="badge orange">' + s.offers_count + ' عرض</span>' : '') + '</td>' +
    '<td>' + ratingHtml(s.rating_avg, s.rating_count) + '</td>' +
    '<td class="num">' + (s.orders_count || 0) +
      (s.new_orders > 0 ? ' <span class="badge amber">' + s.new_orders + ' جديد</span>' : '') + '</td>' +
    '<td class="dim tiny">' + esc(fmtDate(s.updated_at)) + '</td>' +
    '<td class="actions">' +
    '<button class="btn small" data-mfull="' + s.id + '">بطاقة المتجر</button> ' +
    '<button class="btn ghost small" data-morders="' + s.id + '">الطلبات</button> ' +
    (s.published
      ? '<button class="btn danger small" data-munpublish="' + s.id + '">إخفاء</button>'
      : (s.subscriptionActive
        ? '<button class="btn success small" data-mpublish="' + s.id + '">نشر</button>'
        : '')) +
    '</td></tr>'
  ).join('');

  /* v5.0 — بطاقات جوال للمتاجر: الجداول مخفية تحت 820px (تصميم
   * الجوال) لكن هذا القسم لم يكن يبني بديلاً — فكان المالك على
   * هاتفه يرى الإحصائيات فقط بلا أي متجر (السبب الجذري لشكوى
   * «لا تظهر جداول المتاجر»). نفس أزرار الجدول بعينها عبر data-*. */
  const storeCards = (stores.stores || []).map((s) =>
    '<div class="mcard">' +
    '<div class="m-top">' +
    '<span class="m-title" style="display:flex;align-items:center;gap:8px">' +
    storeAvatarHtml(s.logo_url, s.name, 30) + esc(s.name) + '</span>' +
    (s.published
      ? '<span class="badge green">منشور</span>'
      : '<span class="badge">مخفي</span>') +
    '</div>' +
    '<div class="m-rows">' +
    '<div class="r"><span>الاشتراك</span><b>' +
      (s.subscriptionActive
        ? '<span class="badge green">فعّال</span>'
        : '<span class="badge red">منتهي</span>') + '</b></div>' +
    '<div class="r"><span>المنتجات</span><b>' + (s.products_count || 0) +
      (s.offers_count > 0 ? ' <span class="badge orange">' + s.offers_count + ' عرض</span>' : '') + '</b></div>' +
    '<div class="r"><span>التقييم</span><b>' + (s.rating_count
      ? (Number(s.rating_avg) || 0).toFixed(1) + ' ★ (' + s.rating_count + ')'
      : '—') + '</b></div>' +
    '<div class="r"><span>الطلبات</span><b>' + (s.orders_count || 0) +
      (s.new_orders > 0 ? ' <span class="badge amber">' + s.new_orders + ' جديد</span>' : '') + '</b></div>' +
    '<div class="r"><span>الرقم</span><b class="mono" dir="ltr">' + esc(s.store_number) + '</b></div>' +
    '</div>' +
    '<div class="m-actions">' +
    '<button class="btn small" data-mfull="' + s.id + '">بطاقة المتجر</button>' +
    '<button class="btn ghost small" data-morders="' + s.id + '">الطلبات</button>' +
    (s.published
      ? '<button class="btn danger small" data-munpublish="' + s.id + '">إخفاء</button>'
      : (s.subscriptionActive
        ? '<button class="btn success small" data-mpublish="' + s.id + '">نشر</button>'
        : '')) +
    '</div></div>'
  ).join('');

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>المتاجر والطلبات (البيع أونلاين)</h1>' +
    '<div class="sub">إدارة متاجر نقاط البيع في منصة سيلا ماركت — البطاقات، العروض، التقييمات والمستخدمون</div></div></div>' +

    '<div class="card" style="padding:14px"><div class="kpi-grid">' +
    kpi('متاجر مسجلة', String(stats.stores || 0), (stats.publishedStores || 0) + ' منشورة') +
    kpi('منتجات معروضة', String(stats.products || 0),
      (stats.discountedProducts || 0) + ' عليها عروض تخفيضات', 'accent') +
    kpi('مستخدمو المتجر', String(stats.users || 0),
      (stats.activeUsers || 0) + ' نشط آخر 30 يومًا · ' + (stats.addresses || 0) + ' عنوان') +
    kpi('إجمالي الطلبات', String(stats.orders || 0),
      (stats.newOrders || 0) + ' جديد · ' + (stats.deliveredOrders || 0) + ' مُسلّم') +
    kpi('قيمة البضاعة المبيعة', money(stats.gmvMinor),
      'وفّر المستخدمون ' + money(stats.discountMinor) + ' من عروض التخفيضات', 'green') +
    kpi('تقييم المتاجر', (stats.ratingAvg != null ? (Number(stats.ratingAvg)).toFixed(1) : '—') + ' <small>/5</small>',
      ratingSub, 'accent') +
    '</div></div>' +

    '<div class="card">' +
    ((stores.stores || []).length
      ? '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>المتجر</th><th>النشر</th><th>الاشتراك</th><th>منتجات</th>' +
        '<th>التقييم</th><th>طلبات</th><th>آخر تحديث</th><th></th>' +
        '</tr></thead><tbody>' + storeRows + '</tbody></table></div>' +
        '<div class="cards-list">' + storeCards + '</div>'
      : '<div class="empty">لا متاجر بعد — تُنشأ تلقائياً عندما يفعّل التاجر «البيع أونلاين» من تطبيق نقطة البيع</div>') +
    '</div>' +

    '<div class="card"><div class="card-title">آخر الطلبات</div>' +
    '<div class="card-title hint">اختر «الطلبات» من جدول المتاجر لتظهر هنا</div>' +
    '<div id="marketOrdersBox"><div class="empty">لا طلبات محمّلة</div></div></div>' +

    '<div class="card"><div class="card-title">سجل طلبات المول الحي</div>' +
    '<div class="card-title hint">كل نداء يصله الخادم من تطبيق المستخدمين لحظة بلحظة — ' +
    'من هنا تتحقق بعينك أن طلبات المنتجات تصل فعلاً (الحالة والحجم والزمن وعنوان العميل). ' +
    'إن لم يظهر طلب «/products» هنا أثناء استخدام التطبيق فالطلب يُقتل في الطريق قبل الخادم.</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">' +
    '<button class="btn small" id="mreqLoad">تحديث السجل</button>' +
    '<button class="btn ghost small" id="mreqAuto">تشغيل التحديث التلقائي</button>' +
    '<button class="btn ghost small" id="mreqReset">تصفير العدادات</button>' +
    '</div><div id="marketReqBox"><div class="empty">اضغط «تحديث السجل»</div></div></div>';

  $$('[data-munpublish]').forEach((b) => {
    b.onclick = () =>
      confirmModal('إخفاء المتجر', 'ستختفي منتجات المتجر من تطبيق المستخدمين فوراً. المتجر نفسه بياناته محفوظة.', 'إخفاء', async () => {
        await api('/market/stores/' + b.getAttribute('data-munpublish') + '/publish',
          {method: 'POST', body: {published: false}});
        toast('تم إخفاء المتجر', 'success');
        viewMarket().catch(showErr);
      });
  });
  $$('[data-mpublish]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/market/stores/' + b.getAttribute('data-mpublish') + '/publish',
          {method: 'POST', body: {published: true}});
        toast('تم نشر المتجر', 'success');
        viewMarket().catch(showErr);
      } catch (err) { showErr(err); }
    };
  });
  $$('[data-morders]').forEach((b) => {
    b.onclick = () => loadMarketOrders(Number(b.getAttribute('data-morders'))).catch(showErr);
  });
  $$('[data-mfull]').forEach((b) => {
    b.onclick = () => openStoreFullModal(Number(b.getAttribute('data-mfull'))).catch(showErr);
  });

  /* v5.1: سجل طلبات المول — تحديث يدوي وتلقائي كل 5 ثوانٍ */
  const reqLoadBtn = $('#mreqLoad');
  const reqAutoBtn = $('#mreqAuto');
  const reqResetBtn = $('#mreqReset');
  if (reqLoadBtn) {
    reqLoadBtn.onclick = () => loadMarketRequestLog().catch(showErr);
    loadMarketRequestLog().catch(() => {});
  }
  if (reqAutoBtn) {
    let autoTimer = null;
    reqAutoBtn.onclick = () => {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
        reqAutoBtn.textContent = 'تشغيل التحديث التلقائي';
        reqAutoBtn.classList.remove('success');
      } else {
        autoTimer = setInterval(() => loadMarketRequestLog().catch(() => {}), 5000);
        reqAutoBtn.textContent = 'إيقاف التحديث التلقائي';
        reqAutoBtn.classList.add('success');
      }
    };
  }
  if (reqResetBtn) {
    reqResetBtn.onclick = () =>
      confirmModal('تصفير العدادات', 'يُصفَّر عدّاد النداءات والأخطاء (السجل نفسه يبقى).', 'تصفير', async () => {
        await api('/market/request-log/reset', {method: 'POST'});
        toast('تم التصفير', 'success');
        loadMarketRequestLog().catch(showErr);
      });
  }
}

/* ═════════ v5.1: سجل طلبات المول الحي ═══════════════════════════
 * يعرض آخر 400 نداء /api/market/* وصلت للخادم — الدليل القاطع عند
 * أي شكوى «المنتجات لا تظهر»: إن كان الطلب يصل ويرد 200 فالخلل في
 * الطريق للعميل (شبكة المستخدم)، وإن لم يصل أصلاً فالتطبيق لم
 * يرسله. يعرض أيضاً عدادات المنتجات تحديداً. */
async function loadMarketRequestLog() {
  const box = $('#marketReqBox');
  if (!box) return;
  const d = await api('/market/request-log');
  const t = d.totals || {};
  const list = d.entries || [];
  const mins = Math.max(1, Math.round((Date.now() - (t.since || Date.now())) / 60000));

  const summary =
    '<div class="kpi-grid" style="margin-bottom:12px">' +
    kpi('نداءات منذ التصفير', String(t.requests || 0),
      'خلال ~' + mins + ' دقيقة') +
    kpi('طلبات المنتجات', String(t.productsRequests || 0),
      (t.productsErrors || 0) + ' فشل منها', (t.productsErrors || 0) > 0 ? 'warn' : 'green') +
    kpi('أخطاء (4xx/5xx)', String(t.errors || 0),
      (t.errors || 0) === 0 ? 'لا أخطاء' : 'راجع الأسفل', (t.errors || 0) > 0 ? 'warn' : 'green') +
    '</div>';

  if (!list.length) {
    box.innerHTML = summary + '<div class="empty">لا نداءات مسجلة بعد على /api/market — افتح تطبيق المستخدمين ثم حدّث</div>';
    return;
  }

  const rows = list.slice(0, 120).map((e) => {
    const isProducts = e.path.indexOf('/products') !== -1;
    const statusColor = e.ok ? 'var(--ok, #16a34a)' : 'var(--danger, #dc2626)';
    return '<tr' + (isProducts ? ' style="background:rgba(249,115,22,.07)"' : '') + '>' +
      '<td>' + esc(fmtDateTime(e.at)) + '</td>' +
      '<td><b>' + esc(e.method) + '</b></td>' +
      '<td dir="ltr" style="text-align:left;font-size:11.5px">' + esc(e.path) +
      (isProducts ? ' <span style="color:#f97316;font-weight:700">منتجات</span>' : '') + '</td>' +
      '<td style="color:' + statusColor + ';font-weight:700">' + e.status + '</td>' +
      '<td>' + (e.bytes || '—') + '</td>' +
      '<td>' + e.ms + 'ms</td>' +
      '<td dir="ltr" style="text-align:left;font-size:11px">' + esc(e.ip) + '</td>' +
      '<td dir="ltr" style="text-align:left;font-size:10.5px;color:#888">' + esc(String(e.ua || '').split(' ')[0] || '') + '</td>' +
      '</tr>';
  }).join('');

  box.innerHTML = summary +
    '<div class="card-title hint" style="margin-bottom:6px">آخر ' + Math.min(list.length, 120) +
    ' نداء (الأحدث أولاً) — الصفوف البرتقالية طلبات منتجات · الجدول يتحدث تلقائياً عند التشغيل</div>' +
    '<div class="table-wrap" style="max-height:420px;overflow:auto"><table class="tbl"><thead><tr>' +
    '<th>الوقت</th><th>الطريقة</th><th>المسار</th><th>الحالة</th><th>بايت</th><th>الزمن</th><th>العميل</th><th>الوكيل</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

/* ═══════════════════ VIEW: market users (مستخدمو المتجر) ═══════════════════
 * v4.6 — طلب الجولة 9: «الخيارات والعمليات التي يمكن للادمن أجراها
 * علي المستخدمين او نقاط البيع». المستخدمون: تعطيل فوري (يبطل كل
 * جلساته المفتوحة) وإعادة تفعيل، مع إحصاءات كل مستخدم. */
async function viewMarketUsers() {
  const d = await api('/market/users');
  const users = d.users || [];
  const active30 = users.filter((u) => !u.disabled && u.last_seen_at > Date.now() - 30 * 86400000).length;
  const disabled = users.filter((u) => u.disabled).length;

  const kpi = (label, value, sub, cls) =>
    '<div class="kpi' + (cls ? ' ' + cls : '') + '"><div class="k-label">' + esc(label) +
    '</div><div class="k-value">' + value + '</div>' +
    (sub ? '<div class="k-sub">' + sub + '</div>' : '') + '</div>';

  const rows = users.map((u) =>
    '<tr' + (u.disabled ? ' class="row-off"' : '') + '>' +
    '<td><b>' + esc(u.name || 'مستخدم سيلا') + '</b>' +
    (u.disabled ? ' <span class="badge red">معطّل</span>' : '') + '</td>' +
    '<td class="mono tiny" dir="ltr">' + esc(u.phone || '') + '</td>' +
    '<td class="mono tiny" dir="ltr">' + esc(u.id_number || '') + '</td>' +
    '<td class="num">' + (u.orders_count || 0) +
      (u.delivered_count > 0 ? ' <span class="badge green">' + u.delivered_count + ' مُسلّم</span>' : '') + '</td>' +
    '<td class="num">' + (u.addresses_count || 0) + '</td>' +
    '<td class="num">' + (u.ratings_count || 0) + '</td>' +
    '<td class="dim tiny">' + esc(fmtDateTime(u.last_seen_at)) + '</td>' +
    '<td class="actions">' +
    '<button class="btn ghost small" data-ureset="' + u.id + '" data-ureset-name="' + esc(u.name || '') + '">كلمة مرور</button> ' +
    (u.disabled
      ? '<button class="btn success small" data-uenable="' + u.id + '">تفعيل</button>'
      : '<button class="btn danger small" data-udisable="' + u.id + '">تعطيل</button>') +
    '</td></tr>'
  ).join('');

  /* v5.0 — بطاقات جوال للمستخدمين (الجداول مخفية تحت 820px) مع
   * زر إعادة تعيين كلمة المرور: الاستعادة الرسمية بعد إزالة
   * «نسيت كلمة المرور» الذاتية (ثغرة الهوية+الهاتف). */
  const userCards = users.map((u) =>
    '<div class="mcard' + (u.disabled ? ' row-off' : '') + '">' +
    '<div class="m-top"><span class="m-title">' + esc(u.name || 'مستخدم سيلا') + '</span>' +
    (u.disabled ? '<span class="badge red">معطّل</span>' : '<span class="badge green">نشط</span>') +
    '</div>' +
    '<div class="m-rows">' +
    '<div class="r"><span>الهاتف</span><b class="mono" dir="ltr">' + esc(u.phone || '') + '</b></div>' +
    '<div class="r"><span>رقم الهوية</span><b class="mono" dir="ltr">' + esc(u.id_number || '') + '</b></div>' +
    '<div class="r"><span>الطلبات</span><b>' + (u.orders_count || 0) +
      (u.delivered_count > 0 ? ' (' + u.delivered_count + ' مُسلّم)' : '') + '</b></div>' +
    '<div class="r"><span>العناوين</span><b>' + (u.addresses_count || 0) + '</b></div>' +
    '<div class="r"><span>التقييمات</span><b>' + (u.ratings_count || 0) + '</b></div>' +
    '<div class="r"><span>آخر ظهور</span><b>' + esc(fmtDateTime(u.last_seen_at)) + '</b></div>' +
    '</div>' +
    '<div class="m-actions">' +
    '<button class="btn ghost small" data-ureset="' + u.id + '" data-ureset-name="' + esc(u.name || '') + '">كلمة مرور</button>' +
    (u.disabled
      ? '<button class="btn success small" data-uenable="' + u.id + '">تفعيل</button>'
      : '<button class="btn danger small" data-udisable="' + u.id + '">تعطيل</button>') +
    '</div></div>'
  ).join('');

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>مستخدمو المتجر</h1>' +
    '<div class="sub">حسابات تطبيق سيلا ماركت — التعطيل يبطل جلساتهم المفتوحة فوراً</div></div></div>' +

    '<div class="card" style="padding:14px"><div class="kpi-grid">' +
    kpi('إجمالي المستخدمين', String(users.length), active30 + ' نشط آخر 30 يومًا') +
    kpi('حسابات معطّلة', String(disabled), disabled ? 'فعّلها من العمود الأخير' : 'لا أحد معطّل', disabled ? 'amber' : 'green') +
    kpi('طلبات مُسلّمة', String(users.reduce((a, u) => a + (u.delivered_count || 0), 0)), 'طلبات وصلت أصحابها', 'green') +
    kpi('تقييمات كتبها المستخدمون', String(users.reduce((a, u) => a + (u.ratings_count || 0), 0)), 'تقييمات موثّقة بعد التسليم', 'accent') +
    '</div></div>' +

    '<div class="card">' +
    (users.length
      ? '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>المستخدم</th><th>الهاتف</th><th>رقم الهوية</th><th>طلبات</th>' +
        '<th>عناوين</th><th>تقييمات</th><th>آخر ظهور</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="cards-list">' + userCards + '</div>'
      : '<div class="empty">لا مستخدمين بعد — يُنشؤون حساباتهم من تطبيق سيلا ماركت</div>') +
    '</div>';

  /* v5.0: إعادة تعيين كلمة مرور مستخدم — توليد كلمة مؤقتة (أو
   * كلمة يختارها المالك)، إبطال كل جلساته، وعرضها للنسخ مرة
   * واحدة. المستخدم الناسي يتواصل مع الإدارة — هذا مساره. */
  $$('[data-ureset]').forEach((b) => {
    b.onclick = () => {
      const userId = b.getAttribute('data-ureset');
      const userName = b.getAttribute('data-ureset-name') || 'المستخدم';
      showModal(
        '<h3>إعادة تعيين كلمة المرور</h3>' +
        '<p class="dim" style="font-size:13.5px">' + esc(userName) +
        ' — اترك الحقل فارغاً لتوليد كلمة مؤقتة تلقائياً. ستُبطَل كل جلساته المفتوحة فوراً.</p>' +
        '<div class="field"><label>كلمة مرور جديدة (اختياري — 8+ محارف برقم وحرف)</label>' +
        '<input class="input" id="urNewPass" type="text" dir="ltr" placeholder="اتركه فارغاً للتوليد التلقائي"></div>' +
        '<div class="modal-actions">' +
        '<button class="btn ghost" id="urCancel">إلغاء</button>' +
        '<button class="btn primary" id="urGo">تعيين</button>' +
        '</div>'
      );
      $('#urCancel').onclick = closeModal;
      $('#urGo').onclick = async () => {
        const btn = $('#urGo');
        btn.disabled = true;
        btn.textContent = 'جارٍ…';
        try {
          const res = await api('/market/users/' + userId + '/reset-password', {
            method: 'POST',
            body: {password: $('#urNewPass').value.trim()},
          });
          closeModal();
          showModal(
            '<h3>تم تعيين كلمة المرور</h3>' +
            '<p class="dim" style="font-size:13.5px">أوصلها للمستخدم عبر قناة موثوقة — لن تظهر مرة أخرى:</p>' +
            '<div class="flex"><input class="input grow mono" id="urPass" readonly dir="ltr" value="' + esc(res.password) + '">' +
            '<button class="btn ghost" id="urCopy">نسخ</button></div>' +
            '<div class="modal-actions"><button class="btn primary" id="urDone">تم</button></div>'
          );
          $('#urCopy').onclick = () => {
            copyText(res.password)
              .then(() => toast('تم النسخ', 'success'))
              .catch(() => toast('تعذر النسخ — انسخه يدوياً', 'error'));
          };
          $('#urDone').onclick = closeModal;
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'تعيين';
          showErr(err);
        }
      };
    };
  });

  $$('[data-udisable]').forEach((b) => {
    b.onclick = () =>
      confirmModal('تعطيل الحساب',
        'سيُمنع المستخدم من الدخول فوراً وتُبطل كل جلساته المفتوحة، ويرى رسالة «الحساب معطّل» عند المحاولة. بياناته وطلباته محفوظة ويمكن تفعيله لاحقًا.',
        'تعطيل', async () => {
          await api('/market/users/' + b.getAttribute('data-udisable') + '/disable',
            {method: 'POST', body: {disabled: true}});
          toast('تم تعطيل الحساب وإبطال جلساته', 'success');
          viewMarketUsers().catch(showErr);
        });
  });
  $$('[data-uenable]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/market/users/' + b.getAttribute('data-uenable') + '/disable',
          {method: 'POST', body: {disabled: false}});
        toast('تم تفعيل الحساب', 'success');
        viewMarketUsers().catch(showErr);
      } catch (err) { showErr(err); }
    };
  });
}

/* ═══════════════════ FULL STORE CARD (بطاقة المتجر الكاملة) ═══════════════════
 * v4.6 — GET /market/stores/:id/full: الملف + الشعار + مناطق التوصيل +
 * الكتالوج بالخصومات والصور + التقييمات + الطلبات، مع تعديل الملف
 * من الإدارة مباشرة (POST /market/stores/:id/profile). */
async function openStoreFullModal(storeId) {
  const d = await api('/market/stores/' + storeId + '/full');
  const s = d.store || {};
  const products = d.products || [];
  const reviews = d.reviews || [];
  const orders = d.orders || [];

  const productRows = products.slice(0, 120).map((p) => {
    const price = (Number(p.price_minor) || 0) / 100;
    const disc = Number(p.discount_pct) || 0;
    const final = disc > 0 ? price * (1 - disc / 100) : price;
    const hidden = p.admin_hidden === 1;
    return '<tr' + (hidden ? ' style="opacity:.55"' : '') + '>' +
      '<td><b>' + esc(p.name) + '</b>' +
      (hidden ? ' <span class="badge">مخفي من الإدارة</span>' : '') +
      (p.category ? '<br><span class="dim tiny">' + esc(p.category) + '</span>' : '') + '</td>' +
      '<td class="num">' + (disc > 0
        ? '<s class="dim">' + fmtMoney(price) + '</s> <b>' + fmtMoney(final) + '</b> <span class="badge orange">-' + disc + '%</span>'
        : fmtMoney(price)) + '</td>' +
      '<td class="num">' + (p.stock != null ? p.stock : '—') + '</td>' +
      '<td class="num">' + (p.images && p.images.length
        ? '<span class="badge blue">' + p.images.length + ' صورة</span>'
        : '<span class="dim tiny">بلا صور</span>') + '</td>' +
      '<td class="actions">' +
      (hidden
        ? '<button class="btn success small" data-pshow="' + p.id + '">إظهار</button>'
        : '<button class="btn ghost small" data-phide="' + p.id + '">إخفاء</button>') +
      '</td>' +
      '</tr>';
  }).join('');

  const reviewRows = reviews.slice(0, 20).map((r) =>
    '<div class="tl-row"><span class="tl-time">' + esc(fmtDateTime(r.createdAt)) + '</span>' +
    '<span class="tl-event">' + ratingHtml(r.stars, 0).replace('(' + 0 + ')', '').trim() + '</span>' +
    '<span class="tl-detail">' + esc(r.userName) + ' — ' + esc(r.comment || 'بلا تعليق') + '</span></div>'
  ).join('');

  const orderRows = orders.slice(0, 25).map((o) => {
    const st = MARKET_STATUS_LABELS[o.status] || [o.status, ''];
    return '<div class="tl-row">' +
      '<span class="tl-time">' + esc(fmtDateTime(o.created_at)) + '</span>' +
      '<span class="tl-event">' + esc(o.order_number) + '</span>' +
      '<span class="badge ' + st[1] + '">' + st[0] + '</span>' +
      '<span class="tl-detail">' + esc(o.user_name || '') + ' · ' + fmtMoney(o.total_minor / 100) +
      ' · ' + (o.items_count || 0) + ' أصناف' +
      (o.rating_stars ? ' · قيّمه ★' + o.rating_stars : '') + '</span></div>';
  }).join('');

  const regions = (d.deliveryRegions || []).map((r) =>
    '<span class="chip static">' + esc(r.name) +
    (r.fee_minor != null ? ' — ' + fmtMoney(r.fee_minor / 100) : '') + '</span>'
  ).join('');

  showModal(
    '<div class="store-hero">' +
    storeAvatarHtml(s.logo_url, s.name, 56) +
    '<div class="grow">' +
    '<h3 style="margin:0 0 4px">' + esc(s.name) + '</h3>' +
    '<div class="store-hero-meta">' +
    '<span class="dim tiny mono" dir="ltr">' + esc(s.store_number || '') + '</span> ' +
    (s.published ? '<span class="badge green">منشور</span>' : '<span class="badge">مخفي</span>') + ' ' +
    (s.subscriptionActive ? '<span class="badge green">اشتراك فعّال</span>' : '<span class="badge red">اشتراك منتهي</span>') + ' ' +
    ratingHtml(d.rating, d.ratingCount) +
    '</div></div></div>' +

    '<form id="storeProfileForm">' +
    '<div class="card-title" style="margin-top:18px">ملف المتجر (يظهر في تطبيق المستخدمين)</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>اسم المتجر</label>' +
    '<input class="input" id="spName" maxlength="80" required value="' + esc(s.name || '') + '"></div>' +
    '<div class="field"><label>التصنيف</label>' +
    '<input class="input" id="spCategory" maxlength="40" placeholder="مطاعم، ملابس…" value="' + esc(s.category || '') + '"></div>' +
    '</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>المنطقة الرئيسية</label>' +
    '<input class="input" id="spRegion" maxlength="60" value="' + esc(s.region || '') + '"></div>' +
    '<div class="field"><label>الهاتف</label>' +
    '<input class="input" id="spPhone" maxlength="24" dir="ltr" value="' + esc(s.phone || '') + '"></div>' +
    '</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>واتساب</label>' +
    '<input class="input" id="spWhatsapp" maxlength="24" dir="ltr" value="' + esc(s.whatsapp || '') + '"></div>' +
    '<div class="field"><label>الوصف</label>' +
    '<input class="input" id="spDescription" maxlength="400" placeholder="جملة تعريفية قصيرة" value="' + esc(s.description || '') + '"></div>' +
    '</div>' +
    '<div class="flex">' +
    '<button type="submit" class="btn primary" id="spSave">حفظ التعديلات</button>' +
    '<span class="dim tiny">يتحكم به التاجر من نقطة البيع — التعديل هنا يُطبَّق فورًا على المتجر</span></div>' +
    '</form>' +

    '<div class="card-title" style="margin-top:18px">مناطق التوصيل</div>' +
    '<div class="chips">' + (regions || '<span class="dim tiny">لم يضف التاجر مناطق بعد</span>') + '</div>' +

    '<div class="card-title" style="margin-top:18px">الكتالوج (' + products.length + ' منتجًا)' +
    (products.some((p) => p.admin_hidden === 1)
      ? ' <span class="dim tiny">— المنتجات المخفية لا تظهر للمشترين في المول</span>' : '') + '</div>' +
    (products.length
      ? '<div class="table-wrap" style="max-height:300px;overflow:auto"><table class="tbl"><thead><tr>' +
        '<th>المنتج</th><th>السعر</th><th>المخزون</th><th>الصور</th><th>إجراء</th>' +
        '</tr></thead><tbody>' + productRows + '</tbody></table></div>'
      : '<div class="empty">لا منتجات معروضة — يضيفها التاجر من نقطة البيع</div>') +

    '<div class="card-title" style="margin-top:18px">تقييمات العملاء (' + d.ratingCount + ')</div>' +
    (reviewRows || '<div class="empty">لا تقييمات بعد</div>') +

    '<div class="card-title" style="margin-top:18px">آخر الطلبات</div>' +
    (orderRows || '<div class="empty">لا طلبات</div>') +

    '<div class="modal-actions" style="margin-top:18px">' +
    '<button class="btn ghost" id="sfClose">إغلاق</button>' +
    '</div>',
    true /* wide */
  );

  $('#sfClose').onclick = closeModal;

  /* v4.7: إخفاء/إظهار منتج — قرار إداري دائم يقاوم مزامنات التاجر. */
  $$('[data-phide]').forEach((b) => {
    b.onclick = () =>
      confirmModal('إخفاء المنتج', 'سيختفي هذا المنتج من متجر المشترين فورًا، وسيبقى مخفيًا حتى تقرر إظهاره من هنا (حتى لو أعاد التاجر مزامنة كتالوجه).', 'إخفاء', async () => {
        await api('/market/products/' + b.getAttribute('data-phide') + '/visibility',
          {method: 'POST', body: {hidden: true}});
        toast('أُخفي المنتج من المول', 'success');
        openStoreFullModal(storeId).catch(showErr);
      });
  });
  $$('[data-pshow]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/market/products/' + b.getAttribute('data-pshow') + '/visibility',
          {method: 'POST', body: {hidden: false}});
        toast('أُعيد المنتج للعرض', 'success');
        openStoreFullModal(storeId).catch(showErr);
      } catch (err) { showErr(err); }
    };
  });

  $('#storeProfileForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#spSave');
    btn.disabled = true;
    try {
      await api('/market/stores/' + storeId + '/profile', {method: 'POST', body: {
        name: $('#spName').value.trim(),
        category: $('#spCategory').value.trim(),
        region: $('#spRegion').value.trim(),
        phone: $('#spPhone').value.trim(),
        whatsapp: $('#spWhatsapp').value.trim(),
        description: $('#spDescription').value.trim(),
      }});
      toast('تم حفظ ملف المتجر', 'success');
      closeModal();
      viewMarket().catch(showErr);
    } catch (err) {
      showErr(err);
      btn.disabled = false;
    }
  };
}

async function loadMarketOrders(storeId) {
  const data = await api('/market/orders' + (storeId ? '?storeId=' + storeId : ''));
  const rows = (data.orders || []).slice(0, 50).map((o) => {
    const st = MARKET_STATUS_LABELS[o.status] || [o.status, ''];
    return '<div class="tl-row">' +
      '<span class="tl-time">' + esc(fmtDateTime(o.created_at)) + '</span>' +
      '<span class="tl-event">' + esc(o.order_number) + '</span>' +
      '<span class="badge ' + st[1] + '">' + st[0] + '</span>' +
      '<span class="tl-detail">' + esc(o.user_name || '') + ' · ' + esc(o.user_phone || '') +
      ' · ' + esc(o.store_name || '') + ' · ' + fmtMoney(o.total_minor / 100) +
      ' · ' + (o.items_count || 0) + ' أصناف' +
      (o.rating_stars ? ' · ★' + o.rating_stars : '') +
      (o.invoice_ref ? ' · <span class="mono" dir="ltr">' + esc(o.invoice_ref) + '</span>' : '') +
      '</span></div>';
  }).join('');
  $('#marketOrdersBox').innerHTML = rows || '<div class="empty">لا طلبات لهذا المتجر</div>';
}

/* ═══════════════════ VIEW: settings ═══════════════════ */

async function viewSettings() {
  const cfg = await api('/config');
  const sec = await api('/market/security').catch(() => null);

  const panelPath = location.pathname.replace(/\/+$/, '');

  $('#view').innerHTML =
    '<div class="page-head"><div><h1>الإعدادات</h1>' +
    '<div class="sub">العملة، الأسعار، كلمة المرور ورابط اللوحة</div></div></div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c-2.7 2.6-4 5.7-4 9.5s1.3 6.9 4 9.5c2.7-2.6 4-5.7 4-9.5s-1.3-6.9-4-9.5z"/></svg>' +
    'رابط لوحة التحكم السري</div>' +
    '<p class="dim tiny mb">هذا الرابط سري — لا تشاركه مع أحد. أي مسار آخر يعطي 404.</p>' +
    '<div class="flex"><input class="input grow" id="panelPath" readonly dir="ltr" value="' + esc(location.origin + panelPath) + '">' +
    '<button class="btn ghost" id="copyPath">نسخ</button></div>' +
    '<p class="dim tiny mt">يمكن تغييره من متغير البيئة <b dir="ltr">ADMIN_PATH_SECRET</b> في Coolify.</p>' +
    '</div>' +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="2" y="6" width="20" height="13" rx="2.5"/><path d="M2 10.5h20"/></svg>' +
    'العملة وأسعار الخطط (تظهر في التطبيق وصفحة الهبوط)</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>رمز العملة</label>' +
    '<input class="input" id="stCurrency" maxlength="6" value="' + esc(cfg.currency || '₪') + '"></div>' +
    '<div class="field"><label>سعر التجريبي (7 أيام)</label>' +
    '<input class="input" id="stTrial" type="number" min="0" step="0.5" value="' + esc(String(cfg.pricing.trial)) + '"></div>' +
    '</div>' +
    '<div class="row-3">' +
    '<div class="field"><label>الشهري</label>' +
    '<input class="input" id="stMonthly" type="number" min="0" step="0.5" value="' + esc(String(cfg.pricing.monthly)) + '"></div>' +
    '<div class="field"><label>الربع سنوي</label>' +
    '<input class="input" id="stQuarterly" type="number" min="0" step="0.5" value="' + esc(String(cfg.pricing.quarterly)) + '"></div>' +
    '<div class="field"><label>السنوي</label>' +
    '<input class="input" id="stYearly" type="number" min="0" step="0.5" value="' + esc(String(cfg.pricing.yearly)) + '"></div>' +
    '</div>' +
    '<button class="btn primary" id="stSave">حفظ الأسعار</button>' +
    '</div>' +

    /* v3.3 — رابط سيرفر التفعيل للتطبيق */
    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M10 14L21 3"/><path d="M21 3l-4.5 1L21 8.5 22 3z" fill="currentColor" stroke="none"/><path d="M14 10l-3.5 3.5a2.5 2.5 0 0 1-3.5 0 2.5 2.5 0 0 1 0-3.5L10.5 7"/></svg>' +
    'رابط سيرفر التفعيل (توجيه التطبيق)</div>' +
    '<p class="dim tiny mb">عند نقل الخادم إلى نطاق/عنوان جديد: اكتب الرابط الجديد هنا — كل جهاز يتصل بهذا الخادم (تفعيل أو نبضة التحقق) سيتحول إليه <b>تلقائياً وخلال ساعة كحد أقصى</b>، وبدون ظهور أي حقل للمستخدم في التطبيق.</p>' +
    '<div class="flex"><input class="input grow" id="stActivationUrl" dir="ltr" placeholder="https://example.com" maxlength="200" value="' + esc(cfg.activationUrl || '') + '">' +
    '<button class="btn primary" id="stSaveUrl">حفظ الرابط</button></div>' +
    '<p class="dim tiny mt">ملاحظات مهمة: <b>الخادم الجديد يجب أن يستخدم نفس قاعدة البيانات ونفس مفتاح التوقيع</b> حتى لا تُرفض التراخيص. أبقِ هذا الخادم القديم يعمل حتى تنتقل الأجهزة كلها (يظهر العداد في لوحة المعلومات)، ثم يمكنك إخلاء الحقل لتفريغه.</p>' +
    '</div>' +

    /* v5.0 — أمن حسابات سيلا ماركت: مفتاح «نسيت كلمة المرور» +
     * مزود الرسائل القصيرة متعدد المزودين + رسالة اختبار. */
    (sec ? (
    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>' +
    'أمن حسابات سيلا ماركت (نسيت كلمة المرور والرسائل القصيرة)</div>' +

    '<div class="flex wrap" style="gap:10px;align-items:center;margin-bottom:12px">' +
    '<label class="chips" style="gap:8px"><input type="checkbox" id="secForgot" ' +
    (sec.forgotEnabled ? 'checked' : '') + '> إظهار «نسيت كلمة المرور» في التطبيق (يتطلب مزوداً مكتملًا أدناه)</label>' +
    '<span class="badge ' + (sec.ready ? 'green' : 'amber') + '">' +
    (sec.ready ? 'المزود جاهز' : 'المزود غير مكتمل') + '</span>' +
    '</div>' +
    '<p class="dim tiny mb">عند الإيقاف (الموصى به حالياً): زر «نسيت كلمة المرور؟» في التطبيق يعرض «تواصل مع الإدارة» — والاستعادة تتم من قسم مستخدمي المتجر بزر «كلمة مرور». عند التشغيل: رمز SMS يصل لجوال المستخدم المسجل فقط (صلاحية 10 دقائق) ثم يعيّن كلمته الجديدة بنفسه.</p>' +

    '<div class="row-2">' +
    '<div class="field"><label>مزود الرسائل القصيرة</label>' +
    '<select class="input" id="secProvider">' +
    '<option value="">— بدون مزود —</option>' +
    (sec.providers || []).map((p) =>
      '<option value="' + esc(p) + '"' + (sec.provider === p ? ' selected' : '') + '>' +
      esc({hisms: 'Hisms (hisms.sa)', moltasms: 'MoltaSMS (moltasms.net)',
           unifonic: 'Unifonic', twilio: 'Twilio', generic: 'بوابة HTTP مخصصة'}[p] || p) +
      '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>رقم تواصل الإدارة (يظهر بالتطبيق عند إيقاف الاستعادة)</label>' +
    '<input class="input" id="secContactPhone" dir="ltr" maxlength="24" value="' + esc(sec.contactPhone || '') + '"></div>' +
    '</div>' +

    '<div id="secFields" class="row-2" style="margin-top:4px">' +
    ((sec.fields || []).map((f) =>
      '<div class="field"><label>' + esc(f.label) + '</label>' +
      '<input class="input" id="secf_' + esc(f.key) + '" dir="ltr" ' +
      'value="' + esc((sec.values || {})[f.key] || '') + '" ' +
      (f.key === 'sms_generic_body' ? 'placeholder=\'{"to":"{phone}","text":"{message}"}\'' : '') +
      '></div>'
    ).join('') || '<p class="dim tiny">اختر مزوداً لتظهر حقوله.</p>') +
    '</div>' +

    '<div class="flex wrap" style="gap:8px;margin-top:14px">' +
    '<button class="btn primary" id="secSave">حفظ إعدادات الأمان</button>' +
    '<input class="input" id="secTestPhone" dir="ltr" placeholder="رقم للاختبار 05…" style="max-width:180px">' +
    '<button class="btn ghost" id="secTest">إرسال رسالة اختبار</button>' +
    '</div>' +
    '</div>'
    ) : '') +

    '<div class="card"><div class="card-title">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' +
    'تغيير كلمة المرور</div>' +
    '<div class="row-2">' +
    '<div class="field"><label>كلمة المرور الحالية</label>' +
    '<input class="input" id="pwCurrent" type="password" dir="ltr"></div>' +
    '<div class="field"><label>كلمة المرور الجديدة (6+ محارف)</label>' +
    '<input class="input" id="pwNext" type="password" dir="ltr" minlength="6"></div>' +
    '</div>' +
    '<button class="btn primary" id="pwSave">تغيير كلمة المرور</button>' +
    '</div>';

  $('#copyPath').onclick = () => {
    copyText(location.origin + panelPath)
      .then(() => toast('تم نسخ رابط اللوحة', 'success'))
      .catch(() => toast('تعذر النسخ — انسخه يدوياً', 'error'));
  };
  $('#stSave').onclick = async () => {
    try {
      await api('/config', {
        method: 'PUT',
        body: {
          currency: $('#stCurrency').value,
          pricing: {
            trial: Number($('#stTrial').value),
            monthly: Number($('#stMonthly').value),
            quarterly: Number($('#stQuarterly').value),
            yearly: Number($('#stYearly').value),
          },
        },
      });
      CURRENCY = $('#stCurrency').value || '₪';
      toast('تم حفظ الأسعار', 'success');
    } catch (err) { showErr(err); }
  };
  $('#stSaveUrl').onclick = async () => {
    const val = $('#stActivationUrl').value.trim();
    if (val !== '' && !/^https?:\/\/.+\..+/.test(val)) {
      return toast('الرابط يجب أن يبدأ بـ http:// أو https:// ويحتوي نطاقاً صالحاً', 'error');
    }
    try {
      await api('/config', {
        method: 'PUT',
        body: {activationUrl: val},
      });
      toast(val === '' ? 'تم تفريغ رابط التفعيل — الأجهزة تبقى على عناوينها' : 'تم حفظ رابط التفعيل — ستتبناه الأجهزة تلقائياً', 'success');
    } catch (err) {
      showErr(err.message === 'BAD_ACTIVATION_URL' ? 'رابط غير صالح' : err);
    }
  };
  $('#pwSave').onclick = async () => {
    try {
      await api('/auth/password', {
        method: 'POST',
        body: {current: $('#pwCurrent').value, next: $('#pwNext').value},
      });
      toast('تم تغيير كلمة المرور', 'success');
      $('#pwCurrent').value = '';
      $('#pwNext').value = '';
    } catch (err) {
      showErr(err.message === 'BAD_CREDENTIALS' ? 'كلمة المرور الحالية غير صحيحة' : err);
    }
  };

  /* v5.0 — حفظ إعدادات أمن السوق (المفتاح + المزود + الحقول). */
  if (sec && $('#secSave')) {
    $('#secSave').onclick = async () => {
      try {
        const values = {};
        (sec.fields || []).forEach((f) => {
          const el = $('#secf_' + f.key);
          if (el) values[f.key] = el.value;
        });
        const res = await api('/market/security', {
          method: 'PUT',
          body: {
            forgotEnabled: $('#secForgot').checked,
            contactPhone: $('#secContactPhone').value,
            provider: $('#secProvider').value,
            values,
          },
        });
        toast(res.ready
          ? 'حُفظت الإعدادات — المزود جاهز للعمل'
          : 'حُفظت الإعدادات — المزود غير مكتمل بعد', 'success');
        viewSettings().catch(showErr);
      } catch (err) { showErr(err); }
    };
    $('#secTest').onclick = async () => {
      const phone = $('#secTestPhone').value.trim();
      if (!phone) return toast('اكتب رقم هاتف للاختبار أولاً', 'error');
      const btn = $('#secTest');
      btn.disabled = true;
      btn.textContent = 'جارٍ الإرسال…';
      try {
        const res = await api('/market/security/test-sms', {
          method: 'POST',
          body: {phone},
        });
        if (res.ok) {
          toast('وصلت الرسالة — المزود يعمل', 'success');
        } else {
          toast('فشل الإرسال: ' + (res.detail || 'راجع بيانات المزود'), 'error');
        }
      } catch (err) {
        showErr(err);
      } finally {
        btn.disabled = false;
        btn.textContent = 'إرسال رسالة اختبار';
      }
    };
  }
}

/* ═══════════════════ boot ═══════════════════ */

boot();
