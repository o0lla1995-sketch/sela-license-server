/* ═══════════════════════════════════════════════════════════════
   سيلا — panel app logic (vanilla JS, no build step)
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ── state ────────────────────────────────────────────────────── */
let TOKEN = localStorage.getItem('sela_panel_token') || '';
let ME = null;
let CONFIG = {currency: '₪', pricing: {}};
let keyFilter = 'all';
let keySearch = '';
let auditFilter = '';
let chartCache = {};

const $ = id => document.getElementById(id);
const DAY_MS = 86400000;

/* ── api ──────────────────────────────────────────────────────── */
async function api(path, method = 'GET', body = null) {
  const r = await fetch('/api/admin' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await r.json();
  if (!r.ok || data.ok === false) throw new Error(data.error || 'REQUEST_FAILED');
  return data;
}

/* ── helpers ──────────────────────────────────────────────────── */
function toast(msg, ok = true) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (ok ? '' : ' err');
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.display = 'none'), 2800);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', {maximumFractionDigits: v % 1 ? 1 : 0}) + ' ' + CONFIG.currency;
}

function fmtDate(ms, withTime = true) {
  if (!ms) return '—';
  const d = new Date(ms);
  const date = d.toLocaleDateString('ar-EG-u-nu-latn', {day: 'numeric', month: 'short', year: 'numeric'});
  if (!withTime) return date;
  return date + ' · ' + d.toLocaleTimeString('ar-EG-u-nu-latn', {hour: '2-digit', minute: '2-digit'});
}

function daysLeft(ms) {
  if (!ms) return null;
  return Math.ceil((ms - Date.now()) / DAY_MS);
}

function copyText(txt, label) {
  navigator.clipboard.writeText(txt)
    .then(() => toast('تم نسخ ' + (label || '')))
    .catch(() => toast('تعذر النسخ', false));
}

function planLabel(days) {
  if (days >= 300) return 'سنوي';
  if (days >= 90) return 'ربع سنوي';
  if (days >= 30) return 'شهري';
  if (days <= 7) return 'تجريبي';
  return days + ' يوم';
}

/* ── modal ────────────────────────────────────────────────────── */
function openModal(html) {
  $('modalBox').innerHTML = html;
  $('modalBack').classList.remove('hidden');
}
function closeModal() {
  $('modalBack').classList.add('hidden');
  $('modalBox').innerHTML = '';
}
$('modalBack') && $('modalBack').addEventListener('click', e => {
  if (e.target === $('modalBack')) closeModal();
});

function confirmBox(title, message, okLabel, onOk) {
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="sub" style="margin-top:8px">${esc(message)}</p>
    <div class="modal-actions">
      <button class="btn danger" id="cfOk">${esc(okLabel)}</button>
      <div class="spacer"></div>
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>`);
  $('cfOk').onclick = () => { closeModal(); onOk(); };
}

/* ── icons (SVG) ──────────────────────────────────────────────── */
const ICONS = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
  email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
};

/* ── boot / auth ──────────────────────────────────────────────── */
function showLogin() {
  TOKEN = '';
  localStorage.removeItem('sela_panel_token');
  $('appView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
}

function showApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userName').textContent = ME.name;
  $('userEmail').textContent = ME.email;
  document.querySelectorAll('.owner-only').forEach(el => {
    el.style.display = ME.role === 'owner' ? '' : 'none';
  });
  route();
}

async function boot() {
  if (!TOKEN) return showLogin();
  try {
    const me = await api('/auth/me');
    ME = me.user;
    await loadConfig();
    showApp();
  } catch (_) {
    showLogin();
  }
}

async function loadConfig() {
  try {
    const c = await api('/config');
    CONFIG.currency = c.currency || '₪';
    CONFIG.pricing = c.pricing || {};
    CONFIG.contact = c.contact || {};
  } catch (_) {}
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الدخول…';
  $('loginError').classList.add('hidden');
  try {
    const r = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        email: $('loginEmail').value.trim(),
        password: $('loginPass').value,
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'LOGIN_FAILED');
    TOKEN = data.token;
    localStorage.setItem('sela_panel_token', TOKEN);
    ME = data.user;
    await loadConfig();
    showApp();
    toast('مرحباً ' + ME.name);
  } catch (err) {
    const box = $('loginError');
    box.textContent = {
      BAD_CREDENTIALS: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
      TOO_MANY_ATTEMPTS: 'محاولات كثيرة — انتظر ١٥ دقيقة ثم أعد المحاولة',
    }[err.message] || 'تعذر تسجيل الدخول — تحقق من الاتصال';
    box.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'تسجيل الدخول';
  }
});

$('loginEye').addEventListener('click', () => {
  const p = $('loginPass');
  p.type = p.type === 'password' ? 'text' : 'password';
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/auth/logout', 'POST'); } catch (_) {}
  showLogin();
});

/* ── router ───────────────────────────────────────────────────── */
const routes = {
  dashboard: viewDashboard,
  keys: viewKeys,
  payments: viewPayments,
  contacts: viewContacts,
  admins: viewAdmins,
  audit: viewAudit,
  settings: viewSettings,
};

function route() {
  const hash = (location.hash || '#/dashboard').replace('#/', '');
  const fn = routes[hash] || viewDashboard;
  document.querySelectorAll('.nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === (routes[hash] ? hash : 'dashboard'));
  });
  fn();
}
window.addEventListener('hashchange', () => { if (ME) route(); });

/* ═════════════════════ DASHBOARD ═════════════════════ */
async function viewDashboard() {
  $('view').innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  let stats, an;
  try {
    [stats, an] = await Promise.all([api('/stats'), api('/analytics?days=30')]);
  } catch (_) { return; }

  const monthName = new Date().toLocaleDateString('ar-EG-u-nu-latn', {month: 'long', year: 'numeric'});
  const totalPlans = an.planDistribution.reduce((s, p) => s + p.count, 0) || 1;

  $('view').innerHTML = `
    <div class="kpis">
      <div class="kpi green"><b class="num">${fmtMoney(stats.revenue.thisMonth)}</b><span>إيرادات ${esc(monthName)}</span></div>
      <div class="kpi"><b class="num">${fmtMoney(stats.revenue.mrr)}</b><span>إيراد شهري متوقع MRR</span></div>
      <div class="kpi green"><b class="num">${stats.active}</b><span>اشتراكات نشطة</span></div>
      <div class="kpi blue"><b class="num">${stats.devices}</b><span>أجهزة مفعّلة</span></div>
      <div class="kpi yellow"><b class="num">${stats.expiringSoon}</b><span>تنتهي خلال أسبوع</span></div>
      <div class="kpi red"><b class="num">${stats.unpaid}</b><span>مفاتيح غير مدفوعة</span></div>
    </div>

    <div class="grid2">
      <div class="card">
        <div class="chart-head">
          <h2>الإيرادات الشهرية</h2>
          <div class="val num">${fmtMoney(stats.revenue.total)} <small>الإجمالي الكلي</small></div>
        </div>
        ${barChart(an.revenueByMonth)}
      </div>
      <div class="card">
        <div class="chart-head"><h2>توزيع الخطط</h2></div>
        ${donutChart(an.planDistribution, totalPlans)}
      </div>
    </div>

    <div class="grid2" style="margin-top:16px">
      <div class="card">
        <div class="chart-head">
          <h2>عمليات التفعيل — آخر ٣٠ يوم</h2>
          <div class="dim tiny">${an.deviceActivity.seen24h} جهاز ظهر اليوم · ${an.deviceActivity.seen7d} خلال أسبوع</div>
        </div>
        ${areaChart(an.activationSeries)}
      </div>
      <div class="card">
        <div class="chart-head"><h2>تنتهي قريباً (١٤ يوم)</h2></div>
        ${an.expiringSoon.length ? `<div class="table-wrap"><table>
          <thead><tr><th>المفتاح</th><th>العميل</th><th>الانتهاء</th></tr></thead>
          <tbody>${an.expiringSoon.slice(0, 8).map(x => `
            <tr>
              <td><span class="keycode" onclick="copyText('${esc(x.key_plain)}')">${esc(x.key_plain)}</span></td>
              <td class="wrap-cell">${esc(x.note || '—')}</td>
              <td class="num">${fmtDate(x.expires_at, false)}<br><span class="pill ${daysLeft(x.expires_at) <= 7 ? 'soon' : 'active'}">باقي ${daysLeft(x.expires_at)} يوم</span></td>
            </tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">لا اشتراكات تنتهي خلال أسبوعين</div>'}
      </div>
    </div>

    <div class="card">
      <div class="chart-head"><h2>أحدث المدفوعات</h2>
        <a class="btn ghost small" href="#/payments">كل المدفوعات ←</a></div>
      ${an.recentPayments.length ? `<div class="table-wrap"><table>
        <thead><tr><th>التاريخ</th><th>المفتاح</th><th>المبلغ</th><th>الطريقة</th><th>سجّلها</th></tr></thead>
        <tbody>${an.recentPayments.map(p => `
          <tr>
            <td class="num">${fmtDate(p.created_at)}</td>
            <td>${p.key_plain ? `<span class="keycode" onclick="copyText('${esc(p.key_plain)}')">${esc(p.key_plain)}</span>` : '—'}</td>
            <td class="num"><b style="color:var(--green)">${fmtMoney(p.amount)}</b></td>
            <td>${methodLabel(p.method)}</td>
            <td>${esc(p.admin_name || '—')}</td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">لا مدفوعات مسجلة بعد</div>'}
    </div>`;
}

function methodLabel(m) {
  return {cash: 'نقداً', bank: 'حوالة بنكية', other: 'أخرى'}[m] || esc(m);
}

/* ── charts (pure SVG) ────────────────────────────────────────── */
function barChart(rows) {
  if (!rows || rows.length === 0) return '<div class="empty">لا بيانات بعد</div>';
  const W = 640, H = 200, pad = 26;
  const max = Math.max(...rows.map(r => r.total), 10);
  const bw = (W - pad * 2) / rows.length;
  const bars = rows.map((r, i) => {
    const h = Math.max(2, (r.total / max) * (H - 60));
    const x = pad + i * bw;
    const y = H - 30 - h;
    const label = r.ym.slice(2).replace('-', '/');
    return `
      <rect x="${x + 3}" y="${y}" width="${bw - 6}" height="${h}" rx="4" fill="${i === rows.length - 1 ? '#F97316' : 'rgba(249,115,22,.38)'}">
        <title>${r.ym} — ${fmtMoney(r.total)} (${r.n} دفعة)</title>
      </rect>
      <text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle" font-size="10" fill="#71717a">${label}</text>
      ${r.total > 0 ? `<text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="#a1a1aa">${Math.round(r.total)}</text>` : ''}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" dir="ltr">${bars}</svg>`;
}

function areaChart(series) {
  if (!series || series.length === 0) return '<div class="empty">لا بيانات</div>';
  const W = 640, H = 170, pad = 16;
  const max = Math.max(...series.map(s => s.n), 3);
  const step = (W - pad * 2) / Math.max(1, series.length - 1);
  const pts = series.map((s, i) => [
    pad + i * step,
    H - 24 - (s.n / max) * (H - 50),
  ]);
  const line = pts.map(p => p.join(',')).join(' ');
  const dots = series.map((s, i) =>
    s.n > 0 ? `<circle cx="${pts[i][0]}" cy="${pts[i][1]}" r="3" fill="#F97316"><title>${s.d} — ${s.n} تفعيل</title></circle>` : ''
  ).join('');
  const labels = [0, Math.floor(series.length / 2), series.length - 1].map(i => {
    const d = series[i].d.slice(5);
    return `<text x="${pts[i][0]}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="#71717a">${d}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" dir="ltr">
    <polygon points="${pad},${H - 24} ${line} ${W - pad},${H - 24}" fill="rgba(249,115,22,.14)"/>
    <polyline points="${line}" fill="none" stroke="#F97316" stroke-width="2" stroke-linejoin="round"/>
    ${dots}${labels}
  </svg>`;
}

const DONUT_COLORS = ['#F97316', '#38bdf8', '#22c55e', '#eab308', '#a78bfa'];
function donutChart(dist, total) {
  if (!dist || dist.length === 0) return '<div class="empty">لا اشتراكات نشطة</div>';
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  const segs = dist.map((d, i) => {
    const frac = d.count / total;
    const seg = `
      <circle r="${R}" cx="70" cy="70" fill="none" stroke="${DONUT_COLORS[i % DONUT_COLORS.length]}"
        stroke-width="20" stroke-dasharray="${(frac * C).toFixed(2)} ${C}" stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 70 70)"><title>${esc(d.label)} — ${d.count} (${Math.round(frac * 100)}%)</title></circle>`;
    offset += frac * C;
    return seg;
  }).join('');
  const legend = dist.map((d, i) => `
    <span><i style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></i>
    ${esc(d.label)} · <b class="num">${d.count}</b> (${fmtMoney(d.value)})</span>`).join('');
  return `
    <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <svg viewBox="0 0 140 140" width="140" height="140" style="flex-shrink:0">${segs}
        <text x="70" y="66" text-anchor="middle" font-size="24" font-weight="800" fill="#f4f4f5">${total}</text>
        <text x="70" y="84" text-anchor="middle" font-size="10" fill="#a1a1aa">اشتراك نشط</text>
      </svg>
      <div class="legend" style="flex-direction:column;align-items:flex-start;gap:7px">${legend}</div>
    </div>`;
}

/* ═════════════════════ KEYS ═════════════════════ */
async function viewKeys() {
  $('view').innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  let data;
  try {
    const q = keySearch ? '&q=' + encodeURIComponent(keySearch) : '';
    data = await api('/keys?status=' + keyFilter + q);
  } catch (_) { return; }

  const filters = [
    ['all', 'الكل'], ['active', 'نشطة'], ['unused', 'غير مستخدمة'],
    ['expiring', 'تنتهي قريباً'], ['expired', 'منتهية'],
    ['revoked', 'موقوفة'], ['unpaid', 'غير مدفوعة'],
  ];

  $('view').innerHTML = `
    <div class="toolbar">
      <button class="btn primary" id="createKeyBtn">+ إنشاء مفاتيح</button>
      <div class="chips" id="keyFilters">
        ${filters.map(([v, l]) => `<button class="${keyFilter === v ? 'on' : ''}" data-f="${v}">${l}</button>`).join('')}
      </div>
      <div class="spacer"></div>
      <div class="search-box"><input id="keySearch" placeholder="ابحث بمفتاح أو اسم عميل…" value="${esc(keySearch)}"></div>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>المفتاح</th><th>الخطة</th><th>السعر</th><th>الدفع</th><th>الحالة</th>
          <th>الأجهزة</th><th>الانتهاء / آخر ظهور</th><th>العميل</th><th></th>
        </tr></thead>
        <tbody>
          ${data.keys.length === 0 ? '<tr><td colspan="9"><div class="empty">لا توجد مفاتيح في هذا التصنيف</div></td></tr>' : ''}
          ${data.keys.map(k => keyRow(k)).join('')}
        </tbody>
      </table></div>
    </div>`;

  $('createKeyBtn').onclick = () => keyCreateModal();
  document.querySelectorAll('#keyFilters button').forEach(b => {
    b.onclick = () => { keyFilter = b.dataset.f; viewKeys(); };
  });
  const searchEl = $('keySearch');
  let deb;
  searchEl.oninput = () => {
    clearTimeout(deb);
    deb = setTimeout(() => { keySearch = searchEl.value.trim(); viewKeys(); }, 350);
  };
}

function keyRow(k) {
  const now = Date.now();
  const statusPill =
    k.status === 'active' && k.latest_expiry < now + 7 * DAY_MS
      ? '<span class="pill soon">تنتهي قريباً</span>'
      : `<span class="pill ${k.status}">${{active: 'نشط', expired: 'منتهي', revoked: 'موقوف', unused: 'غير مستخدم'}[k.status]}</span>`;
  const payPill = {
    paid: '<span class="pill paid">مدفوع</span>',
    unpaid: '<span class="pill unpaid">غير مدفوع</span>',
    partial: '<span class="pill partial">جزئي</span>',
    free: '<span class="pill free">مجاني</span>',
  }[k.payStatus];
  return `<tr>
    <td><span class="keycode" title="اضغط للنسخ" onclick="copyText('${esc(k.key_plain)}','المفتاح')">${esc(k.key_plain)}</span></td>
    <td>${esc(k.planLabel)}</td>
    <td class="num">${k.price > 0 ? fmtMoney(k.price) : '—'}</td>
    <td>${payPill}</td>
    <td>${statusPill}</td>
    <td class="num">${k.active_devices}/${k.max_devices}</td>
    <td class="num wrap-cell">${k.latest_expiry ? fmtDate(k.latest_expiry, false) : '—'}${k.last_seen ? `<br><span class="dim tiny">آخر ظهور ${fmtDate(k.last_seen)}</span>` : ''}</td>
    <td class="wrap-cell">${esc(k.note || '—')}</td>
    <td><button class="btn ghost small" onclick="keyDetail(${k.id})">إدارة</button></td>
  </tr>`;
}

function keyCreateModal() {
  const p = CONFIG.pricing || {};
  openModal(`
    <h3>إنشاء مفاتيح جديدة</h3>
    <p class="sub">يُنسخ المفتاح بعد الإنشاء — سلّمه للعميل لتفعيل التطبيق</p>
    <div class="row">
      <div>
        <label>الخطة</label>
        <select id="kcPlan">
          <option value="30" data-price="${p.monthly ?? 50}">شهري — 30 يوم (${fmtMoney(p.monthly ?? 50)})</option>
          <option value="90" data-price="${p.quarterly ?? 120}">ربع سنوي — 90 يوم (${fmtMoney(p.quarterly ?? 120)})</option>
          <option value="365" data-price="${p.yearly ?? 400}">سنوي — 365 يوم (${fmtMoney(p.yearly ?? 400)})</option>
          <option value="7" data-price="${p.trial ?? 0}">تجريبي — 7 أيام (${fmtMoney(p.trial ?? 0)})</option>
          <option value="custom">مخصص…</option>
        </select>
      </div>
      <div id="kcCustomBox" style="display:none">
        <label>عدد الأيام</label>
        <input id="kcDays" type="number" min="1" max="3650" value="60">
      </div>
    </div>
    <div class="row">
      <div>
        <label>السعر (${CONFIG.currency})</label>
        <input id="kcPrice" type="number" min="0" step="0.5" value="${p.monthly ?? 50}">
      </div>
      <div>
        <label>أقصى عدد أجهزة للمفتاح</label>
        <input id="kcDevices" type="number" min="1" max="10" value="1">
      </div>
      <div>
        <label>العدد المطلوب</label>
        <input id="kcCount" type="number" min="1" max="50" value="1">
      </div>
    </div>
    <label>ملاحظة (اسم العميل / المحل)</label>
    <input id="kcNote" placeholder="مثال: محل أبو محمد — الخليل">
    <div class="modal-actions">
      <button class="btn primary" id="kcGo">إنشاء</button>
      <div class="spacer"></div>
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>
    <div id="kcResult"></div>`);

  const planSel = $('kcPlan');
  const syncPrice = () => {
    const opt = planSel.selectedOptions[0];
    $('kcCustomBox').style.display = planSel.value === 'custom' ? '' : 'none';
    if (planSel.value !== 'custom' && opt.dataset.price !== undefined) {
      $('kcPrice').value = opt.dataset.price;
    }
  };
  planSel.onchange = syncPrice;

  $('kcGo').onclick = async () => {
    const days = planSel.value === 'custom' ? Number($('kcDays').value) : Number(planSel.value);
    try {
      const r = await api('/keys', 'POST', {
        planDays: days,
        maxDevices: Number($('kcDevices').value),
        price: Number($('kcPrice').value),
        note: $('kcNote').value,
        count: Number($('kcCount').value),
      });
      $('kcResult').innerHTML = `<div class="newkeys">
        <b>مفاتيح جديدة — اضغط أي مفتاح لنسخه:</b>
        ${r.keys.map(k => `<span class="k" onclick="copyText('${k.key}','المفتاح')">${k.key}</span>`).join('')}
      </div>`;
      toast('تم إنشاء ' + r.keys.length + ' مفتاح');
    } catch (e) {
      toast('فشل الإنشاء: ' + e.message, false);
    }
  };
}

async function keyDetail(id) {
  let d;
  try { d = await api('/keys/' + id); } catch (_) { return; }
  const k = d.key;
  const now = Date.now();

  openModal(`
    <h3 class="ltr mono" style="color:var(--accent)">${esc(k.key_plain)}</h3>
    <p class="sub">${esc(k.planLabel)} · ${k.max_devices} أجهزة كحد أقصى · ${k.price > 0 ? 'السعر ' + fmtMoney(k.price) : 'مجاني'}</p>

    <div class="row" style="margin-bottom:10px">
      <div><span class="pill ${k.revoked_at ? 'revoked' : d.payStatus === 'paid' ? 'paid' : d.payStatus === 'partial' ? 'partial' : d.payStatus === 'free' ? 'free' : 'unpaid'}">${k.revoked_at ? 'موقوف' : {paid: 'مدفوع', unpaid: 'غير مدفوع', partial: 'مدفوع جزئياً', free: 'مجاني'}[d.payStatus]}</span></div>
      <div><span class="dim tiny">مدفوع: <b class="num">${fmtMoney(d.paidSum)}</b></span></div>
      <div><span class="dim tiny">أُنشئ ${fmtDate(k.created_at, false)}</span></div>
    </div>

    <h2 style="font-size:13.5px;margin:6px 0 8px">الأجهزة المرتبطة</h2>
    <div class="device-list">
      ${d.bindings.length === 0 ? '<div class="empty">لا أجهزة فعّلت هذا المفتاح بعد</div>' : ''}
      ${d.bindings.map(b => `
        <div class="device-row">
          <div class="grow">
            <b>${esc(b.device_label || 'جهاز')}</b>
            <div class="id">${esc(b.device_id)}</div>
          </div>
          <span class="dim tiny num">${b.unbound_at ? 'مفكوك ' + fmtDate(b.unbound_at, false) : 'ينتهي ' + fmtDate(b.expires_at, false)}</span>
          ${!b.unbound_at ? `<button class="btn danger small" onclick="unbindDevice(${k.id}, '${esc(b.device_id).replace(/'/g, '&#39;')}')">فك الربط</button>` : ''}
        </div>`).join('')}
    </div>

    <h2 style="font-size:13.5px;margin:14px 0 8px">المدفوعات المرتبطة</h2>
    ${d.payments.length ? `<div class="table-wrap"><table>
      <thead><tr><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th>ملاحظة</th></tr></thead>
      <tbody>${d.payments.map(p => `
        <tr><td class="num">${fmtDate(p.created_at)}</td>
        <td class="num" style="color:var(--green)"><b>${fmtMoney(p.amount)}</b></td>
        <td>${methodLabel(p.method)}</td><td class="wrap-cell">${esc(p.note || '')}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">لا مدفوعات</div>'}

    <div class="modal-actions" style="flex-wrap:wrap">
      ${k.price > 0 && d.payStatus !== 'paid' ? `<button class="btn primary small" onclick="keyPay(${k.id})">تسجيل دفعة (${fmtMoney(Math.max(0, k.price - d.paidSum))})</button>` : ''}
      <button class="btn soft small" onclick="keyExtend(${k.id}, ${k.plan_days})">تمديد / تجديد</button>
      ${k.revoked_at
        ? `<button class="btn ghost small" onclick="keyRestore(${k.id})">استعادة المفتاح</button>`
        : `<button class="btn danger small" onclick="keyRevoke(${k.id})">إيقاف المفتاح</button>`}
      <div class="spacer"></div>
      <button class="btn ghost small" onclick="copyText('${esc(k.key_plain)}','المفتاح')">نسخ المفتاح</button>
      <button class="btn danger small" onclick="keyDelete(${k.id})">حذف نهائي</button>
    </div>`);
}

async function unbindDevice(keyId, deviceId) {
  confirmBox('فك ربط الجهاز', 'سيُحرَّر مقعد الجهاز ويُقفل التطبيق عليه عند أول تحقق. متابعة؟', 'فك الربط', async () => {
    try {
      const r = await api(`/keys/${keyId}/unbind`, 'POST', {deviceId});
      toast(r.freed ? 'تم فك ربط الجهاز' : 'لم يتم العثور على الجهاز', r.freed);
      keyDetail(keyId);
    } catch (_) { toast('فشل فك الربط', false); }
  });
}

function keyPay(id) {
  openModal(`
    <h3>تسجيل دفعة</h3>
    <p class="sub">تُسجَّل في سجل المدفوعات والإيرادات</p>
    <div class="row">
      <div><label>المبلغ (${CONFIG.currency})</label><input id="kpAmount" type="number" min="0" step="0.5"></div>
      <div><label>الطريقة</label><select id="kpMethod"><option value="cash">نقداً</option><option value="bank">حوالة بنكية</option><option value="other">أخرى</option></select></div>
    </div>
    <label>ملاحظة</label><input id="kpNote" placeholder="اختياري">
    <div class="modal-actions">
      <button class="btn primary" id="kpGo">تسجيل</button>
      <div class="spacer"></div>
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>`);
  api('/keys/' + id).then(d => {
    $('kpAmount').value = Math.max(0, Math.round((d.key.price - d.paidSum) * 10) / 10);
  }).catch(() => {});
  $('kpGo').onclick = async () => {
    try {
      await api(`/keys/${id}/pay`, 'POST', {
        amount: Number($('kpAmount').value) || 0,
        method: $('kpMethod').value,
        note: $('kpNote').value,
      });
      toast('تم تسجيل الدفعة');
      keyDetail(id);
    } catch (e) { toast('فشل: ' + e.message, false); }
  };
}

function keyExtend(id, planDays) {
  openModal(`
    <h3>تمديد / تجديد الاشتراك</h3>
    <p class="sub">يمدد كل الأجهزة النشطة على المفتاح — ويسجل الدفعة إن أدخلت مبلغاً</p>
    <div class="row">
      <div><label>عدد الأيام</label>
        <select id="keDays">
          <option value="${planDays}" selected>كالخطة الحالية (${planDays} يوم)</option>
          <option value="30">30 يوم</option><option value="90">90 يوم</option><option value="365">365 يوم</option>
        </select></div>
      <div><label>المبلغ المدفوع (${CONFIG.currency}) — اتركه فارغاً إن لم يُدفع</label>
        <input id="keAmount" type="number" min="0" step="0.5" placeholder="0"></div>
      <div><label>الطريقة</label><select id="keMethod"><option value="cash">نقداً</option><option value="bank">حوالة بنكية</option><option value="other">أخرى</option></select></div>
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="keGo">تمديد</button>
      <div class="spacer"></div>
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>`);
  $('keGo').onclick = async () => {
    const amount = $('keAmount').value === '' ? null : Number($('keAmount').value);
    try {
      const r = await api(`/keys/${id}/extend`, 'POST', {
        days: Number($('keDays').value),
        amount,
        method: $('keMethod').value,
      });
      toast(r.affected > 0
        ? `تم تمديد ${r.affected} جهاز` + (r.paymentId ? ' وتسجيل الدفعة' : '')
        : 'لا يوجد اشتراك نشط لتمديده على هذا المفتاح', r.affected > 0);
      closeModal();
      route();
    } catch (e) { toast('فشل: ' + e.message, false); }
  };
}

function keyRevoke(id) {
  confirmBox('إيقاف المفتاح', 'سيُقفل التطبيق فوراً على كل الأجهزة المرتبطة بهذا المفتاح. متابعة؟', 'إيقاف', async () => {
    try {
      await api(`/keys/${id}/revoke`, 'POST');
      toast('تم إيقاف المفتاح');
      keyDetail(id);
    } catch (_) { toast('فشل الإيقاف', false); }
  });
}

async function keyRestore(id) {
  try {
    await api(`/keys/${id}/restore`, 'POST');
    toast('تمت استعادة المفتاح');
    keyDetail(id);
  } catch (_) { toast('فشلت الاستعادة', false); }
}

function keyDelete(id) {
  confirmBox('حذف نهائي', 'سيُحذف المفتاح مع كل أجهزته ومدفوعاته من السجلات نهائياً. متابعة؟', 'حذف نهائي', async () => {
    try {
      await api(`/keys/${id}/delete`, 'POST');
      toast('تم حذف المفتاح نهائياً');
      closeModal();
      route();
    } catch (_) { toast('فشل الحذف', false); }
  });
}

/* ═════════════════════ PAYMENTS ═════════════════════ */
async function viewPayments() {
  $('view').innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  let data, stats;
  try {
    [data, stats] = await Promise.all([api('/payments?limit=300'), api('/stats')]);
  } catch (_) { return; }

  $('view').innerHTML = `
    <div class="toolbar">
      <div class="kpis" style="flex:1;margin:0;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
        <div class="kpi green"><b class="num">${fmtMoney(stats.revenue.thisMonth)}</b><span>هذا الشهر</span></div>
        <div class="kpi"><b class="num">${fmtMoney(stats.revenue.last30d)}</b><span>آخر ٣٠ يوم</span></div>
        <div class="kpi blue"><b class="num">${fmtMoney(stats.revenue.total)}</b><span>الإجمالي الكلي</span></div>
      </div>
      <button class="btn primary" id="addPayBtn">+ دفعة يدوية</button>
    </div>
    <div class="card">
      <h2>سجل المدفوعات</h2>
      <p class="sub">كل دفعة مرتبطة بمفتاح تدخل في حساب الأرباح والإحصائيات</p>
      <div class="table-wrap"><table>
        <thead><tr><th>التاريخ</th><th>المفتاح</th><th>العميل</th><th>المبلغ</th><th>الطريقة</th><th>ملاحظة</th><th>سجّلها</th><th></th></tr></thead>
        <tbody>
          ${data.payments.length === 0 ? '<tr><td colspan="8"><div class="empty">لا مدفوعات مسجلة بعد</div></td></tr>' : ''}
          ${data.payments.map(p => `
            <tr>
              <td class="num">${fmtDate(p.created_at)}</td>
              <td>${p.key_plain ? `<span class="keycode" onclick="copyText('${esc(p.key_plain)}')">${esc(p.key_plain)}</span>` : '<span class="dim">بدون مفتاح</span>'}</td>
              <td class="wrap-cell">${esc(p.key_note || '—')}</td>
              <td class="num" style="color:var(--green)"><b>${fmtMoney(p.amount)}</b></td>
              <td>${methodLabel(p.method)}</td>
              <td class="wrap-cell">${esc(p.note || '—')}</td>
              <td>${esc(p.admin_name || '—')}</td>
              <td><button class="btn danger small" onclick="delPayment(${p.id})">حذف</button></td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;

  $('addPayBtn').onclick = () => payModal();
}

function payModal() {
  openModal(`
    <h3>إضافة دفعة يدوية</h3>
    <p class="sub">لربطها بمفتاح اختر المفتاح، أو اتركه فارغاً لدفعة عامة</p>
    <label>رقم المفتاح (اختياري)</label>
    <input id="pmKey" class="mono ltr" placeholder="SELA-XXXXX-XXXXX-XXX">
    <div class="row">
      <div><label>المبلغ (${CONFIG.currency})</label><input id="pmAmount" type="number" min="0" step="0.5"></div>
      <div><label>الطريقة</label><select id="pmMethod"><option value="cash">نقداً</option><option value="bank">حوالة بنكية</option><option value="other">أخرى</option></select></div>
    </div>
    <label>ملاحظة</label><input id="pmNote">
    <div class="modal-actions">
      <button class="btn primary" id="pmGo">إضافة</button>
      <div class="spacer"></div>
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>`);
  $('pmGo').onclick = async () => {
    try {
      let keyId = null;
      const keyStr = $('pmKey').value.trim();
      if (keyStr) {
        const found = await api('/keys?q=' + encodeURIComponent(keyStr));
        const match = found.keys.find(k =>
          k.key_plain.toUpperCase() === keyStr.toUpperCase());
        if (!match) throw new Error('KEY_NOT_FOUND');
        keyId = match.id;
      }
      await api('/payments', 'POST', {
        keyId,
        amount: Number($('pmAmount').value),
        method: $('pmMethod').value,
        note: $('pmNote').value,
      });
      toast('تمت إضافة الدفعة');
      closeModal();
      viewPayments();
    } catch (e) {
      toast(e.message === 'KEY_NOT_FOUND' ? 'المفتاح غير موجود' : 'فشل: ' + e.message, false);
    }
  };
}

function delPayment(id) {
  confirmBox('حذف الدفعة', 'سيُخصم المبلغ من الإيرادات والإحصائيات. متابعة؟', 'حذف', async () => {
    try {
      await api(`/payments/${id}/delete`, 'POST');
      toast('تم حذف الدفعة');
      viewPayments();
    } catch (_) { toast('فشل الحذف', false); }
  });
}

/* ═════════════════════ CONTACTS ═════════════════════ */
async function viewContacts() {
  $('view').innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  let c;
  try { c = (await api('/config')).contact; } catch (_) { return; }

  $('view').innerHTML = `
    <div class="grid2" style="align-items:start">
      <div class="card">
        <h2>بيانات التواصل</h2>
        <p class="sub">أي قناة تملؤها تظهر داخل التطبيق كأيقونة يضغط عليها العميل للتواصل معك — اتركها فارغة لتخفيها</p>
        <div class="contact-grid">
          <div>
            <label>📞 الهاتف</label>
            <input id="ctPhone" value="${esc(c.phone || '')}" placeholder="+972 5X XXX XXXX" dir="ltr">
          </div>
          <div>
            <label>واتساب</label>
            <input id="ctWhats" value="${esc(c.whatsapp || '')}" placeholder="+972 5X XXX XXXX" dir="ltr">
          </div>
          <div>
            <label>تيليجرام (معرف أو رقم)</label>
            <input id="ctTg" value="${esc(c.telegram || '')}" placeholder="@username أو +972…" dir="ltr">
          </div>
          <div>
            <label>البريد الإلكتروني</label>
            <input id="ctEmail" value="${esc(c.email || '')}" placeholder="mail@example.com" dir="ltr">
          </div>
        </div>
        <label>رسالة تظهر للعميل في صفحة الاشتراك</label>
        <input id="ctNote" value="${esc(c.note || '')}" placeholder="لشراء أو تجديد الاشتراك تواصل معنا">
        <button class="btn primary" id="ctSave" style="margin-top:14px">حفظ بيانات التواصل</button>
      </div>
      <div class="card">
        <h2>معاينة داخل التطبيق</h2>
        <p class="sub">هكذا يراها العميل في شاشة التفعيل والاشتراك</p>
        <div class="contact-preview">
          <div class="cp-note">${esc(c.note || 'لشراء أو تجديد الاشتراك تواصل معنا')}</div>
          <div class="cp-icons" id="cpIcons"></div>
        </div>
      </div>
    </div>`;

  const renderPreview = () => {
    const box = $('cpIcons');
    const items = [];
    const phone = $('ctPhone').value.trim();
    const whats = $('ctWhats').value.trim();
    const tg = $('ctTg').value.trim();
    const mail = $('ctEmail').value.trim();
    if (phone) items.push(['phone', ICONS.phone, 'اتصال هاتفي']);
    if (whats) items.push(['whatsapp', ICONS.whatsapp, 'واتساب']);
    if (tg) items.push(['telegram', ICONS.telegram, 'تيليجرام']);
    if (mail) items.push(['email', ICONS.email, 'بريد إلكتروني']);
    box.innerHTML = items.length
      ? items.map(([cls, icon, t]) => `<div class="cp-icon ${cls}" title="${t}">${icon}</div>`).join('')
      : '<div class="cp-empty">لم تُضف أي قناة تواصل بعد</div>';
  };
  ['ctPhone', 'ctWhats', 'ctTg', 'ctEmail'].forEach(id =>
    $(id).addEventListener('input', renderPreview));
  renderPreview();

  $('ctSave').onclick = async () => {
    try {
      await api('/config', 'PUT', {
        phone: $('ctPhone').value,
        whatsapp: $('ctWhats').value,
        telegram: $('ctTg').value,
        email: $('ctEmail').value,
        note: $('ctNote').value,
      });
      toast('تم الحفظ — ستظهر القنوات في التطبيق فوراً');
    } catch (_) { toast('فشل الحفظ', false); }
  };
}

/* ═════════════════════ ADMINS ═════════════════════ */
async function viewAdmins() {
  if (ME.role !== 'owner') {
    $('view').innerHTML = '<div class="empty">هذه الصفحة لمالك النظام فقط</div>';
    return;
  }
  $('view').innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  let data;
  try { data = await api('/admins'); } catch (_) { return; }

  $('view').innerHTML = `
    <div class="toolbar">
      <h2 style="font-size:17px">حسابات المشرفين</h2>
      <div class="spacer"></div>
      <button class="btn primary" id="addAdminBtn">+ مشرف جديد</button>
    </div>
    <div class="card">
      <p class="sub">المالك يرى كل الصلاحيات؛ المشرف لا يدير الحسابات</p>
      <div class="table-wrap"><table>
        <thead><tr><th>الاسم</th><th>البريد</th><th>الدور</th><th>الحالة</th><th>آخر دخول</th><th></th></tr></thead>
        <tbody>
          ${data.admins.map(a => `
            <tr>
              <td><b>${esc(a.name)}</b>${a.id === ME.id ? ' <span class="dim tiny">(أنت)</span>' : ''}</td>
              <td class="ltr">${esc(a.email)}</td>
              <td><span class="pill ${a.role}">${a.role === 'owner' ? 'مالك' : 'مشرف'}</span></td>
              <td>${a.disabled ? '<span class="pill revoked">معطّل</span>' : '<span class="pill active">فعّال</span>'}</td>
              <td class="num">${a.last_login_at ? fmtDate(a.last_login_at) : '—'}</td>
              <td><button class="btn ghost small" onclick="editAdmin(${a.id})">تعديل</button></td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;

  $('addAdminBtn').onclick = () => adminModal(null);
}

function adminModal(admin) {
  const isEdit = !!admin;
  openModal(`
    <h3>${isEdit ? 'تعديل مشرف' : 'مشرف جديد'}</h3>
    <label>الاسم</label><input id="adName" value="${esc(admin ? admin.name : '')}">
    ${!isEdit ? `<label>البريد الإلكتروني</label><input id="adEmail" type="email" dir="ltr">` : ''}
    <label>${isEdit ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور'}</label>
    <input id="adPass" type="password" dir="ltr">
    <label>الدور</label>
    <select id="adRole">
      <option value="staff" ${admin && admin.role === 'staff' ? 'selected' : ''}>مشرف</option>
      <option value="owner" ${admin && admin.role === 'owner' ? 'selected' : ''}>مالك</option>
    </select>
    ${isEdit ? `<label style="margin-top:12px;display:flex;gap:8px;align-items:center;cursor:pointer">
      <input type="checkbox" id="adDisabled" style="width:auto" ${admin.disabled ? 'checked' : ''}> معطّل (يُمنع من الدخول)</label>` : ''}
    <div class="modal-actions">
      <button class="btn primary" id="adGo">${isEdit ? 'حفظ' : 'إضافة'}</button>
      <div class="spacer"></div>
      ${isEdit && admin.id !== ME.id ? `<button class="btn danger" id="adDel">حذف الحساب</button>` : ''}
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>`);

  $('adGo').onclick = async () => {
    try {
      if (isEdit) {
        await api(`/admins/${admin.id}`, 'POST', {
          name: $('adName').value,
          role: $('adRole').value,
          disabled: $('adDisabled') ? $('adDisabled').checked : undefined,
          password: $('adPass').value || undefined,
        });
        toast('تم حفظ التعديلات');
      } else {
        await api('/admins', 'POST', {
          email: $('adEmail').value,
          name: $('adName').value,
          password: $('adPass').value,
          role: $('adRole').value,
        });
        toast('تمت إضافة المشرف');
      }
      closeModal();
      viewAdmins();
    } catch (e) {
      toast({
        EMAIL_EXISTS: 'البريد مستخدم مسبقاً',
        WEAK_PASSWORD: 'كلمة المرور 6 أحرف على الأقل',
        BAD_EMAIL: 'بريد غير صالح',
        LAST_OWNER: 'لا يمكن تعديل المالك الأخير',
      }[e.message] || 'فشل: ' + e.message, false);
    }
  };

  if (isEdit && admin.id !== ME.id) {
    $('adDel').onclick = () => {
      confirmBox('حذف الحساب', `سيُحذف حساب ${admin.name} نهائياً. متابعة؟`, 'حذف', async () => {
        try {
          await api(`/admins/${admin.id}/delete`, 'POST');
          toast('تم حذف الحساب');
          closeModal();
          viewAdmins();
        } catch (e) { toast(e.message === 'LAST_OWNER' ? 'لا يمكن حذف المالك الأخير' : 'فشل الحذف', false); }
      });
    };
  }
}

async function editAdmin(id) {
  const data = await api('/admins');
  const admin = data.admins.find(a => a.id === id);
  if (admin) adminModal(admin);
}

/* ═════════════════════ AUDIT ═════════════════════ */
async function viewAudit() {
  $('view').innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  let data;
  try { data = await api('/audit?limit=200'); } catch (_) { return; }

  const events = {};
  data.events.forEach(e => { events[e.event] = (events[e.event] || 0) + 1; });
  const eventLabels = {
    login_success: 'دخول ناجح', login_failed: 'دخول فاشل', login_throttled: 'محاولات كثيرة',
    logout: 'خروج', password_changed: 'تغيير كلمة مرور', admin_created: 'إنشاء مشرف',
    admin_updated: 'تعديل مشرف', admin_deleted: 'حذف مشرف', admin_create_keys: 'إنشاء مفاتيح',
    admin_extend: 'تمديد اشتراك', admin_revoke: 'إيقاف مفتاح', admin_restore: 'استعادة مفتاح',
    admin_unbind: 'فك ربط جهاز', admin_payment: 'تسجيل دفعة', admin_payment_deleted: 'حذف دفعة',
    admin_update_config: 'تحديث الإعدادات', activate_new_device: 'تفعيل جهاز جديد',
    activate_invalid_key: 'مفتاح غير صالح', activate_revoked_key: 'تفعيل مفتاح موقوف',
    activate_device_limit: 'تجاوز حد الأجهزة', activate_expired: 'تفعيل منتهي',
    activate_reactivation: 'إعادة تفعيل', heartbeat_revoked: 'تحقق مفتاح موقوف',
    heartbeat_expired: 'تحقق منتهي', heartbeat_bad_signature: 'توقيع غير صالح',
    heartbeat_clock_rollback_suspected: 'اشتباه رجوع بالساعة', unbind: 'فك ربط من التطبيق',
  };
  const sortedEvents = Object.keys(events).sort();

  $('view').innerHTML = `
    <div class="toolbar">
      <h2 style="font-size:17px">سجل الأحداث الأمنية</h2>
      <div class="spacer"></div>
      <select id="auditFilter" style="width:auto">
        <option value="">كل الأحداث</option>
        ${sortedEvents.map(ev => `<option value="${ev}" ${auditFilter === ev ? 'selected' : ''}>${eventLabels[ev] || ev} (${events[ev]})</option>`).join('')}
      </select>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>الوقت</th><th>الحدث</th><th>الجهاز / IP</th><th>تفاصيل</th></tr></thead>
        <tbody>
          ${data.events.filter(e => !auditFilter || e.event === auditFilter).map(e => `
            <tr>
              <td class="num">${fmtDate(e.ts)}</td>
              <td><b>${eventLabels[e.event] || esc(e.event)}</b></td>
              <td class="wrap-cell" style="direction:ltr;text-align:left;font-size:10.5px;color:var(--dim)">${esc(e.device_id || e.ip || '—')}</td>
              <td class="wrap-cell"><span class="mono-list">${esc(e.details || '—')}</span></td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;

  $('auditFilter').onchange = () => { auditFilter = $('auditFilter').value; viewAudit(); };
}

/* ═════════════════════ SETTINGS ═════════════════════ */
async function viewSettings() {
  $('view').innerHTML = '<div class="empty">جارٍ التحميل…</div>';
  let c;
  try { c = await api('/config'); } catch (_) { return; }
  const p = c.pricing || {};

  $('view').innerHTML = `
    <div class="grid2" style="align-items:start">
      <div class="card">
        <h2>أسعار الخطط</h2>
        <p class="sub">تُستخدم تلقائياً عند إنشاء المفاتيح وتظهر داخل التطبيق</p>
        <div class="row">
          <div><label>سعر التجريبي (7 أيام)</label><input id="stTrial" type="number" min="0" step="0.5" value="${p.trial ?? 0}"></div>
          <div><label>سعر الشهري (30 يوم)</label><input id="stMonthly" type="number" min="0" step="0.5" value="${p.monthly ?? 50}"></div>
          <div><label>سعر الربع سنوي (90)</label><input id="stQuarterly" type="number" min="0" step="0.5" value="${p.quarterly ?? 120}"></div>
          <div><label>سعر السنوي (365)</label><input id="stYearly" type="number" min="0" step="0.5" value="${p.yearly ?? 400}"></div>
          <div><label>رمز العملة</label><input id="stCurrency" value="${esc(c.currency)}" maxlength="5" placeholder="₪"></div>
        </div>
        <button class="btn primary" id="stSave" style="margin-top:14px">حفظ الأسعار</button>
      </div>
      <div class="card">
        <h2>كلمة المرور الخاصة بك</h2>
        <p class="sub">تغييرها يُخرجك من بقية الأجهزة</p>
        <label>كلمة المرور الحالية</label>
        <input id="pwCurrent" type="password" dir="ltr">
        <label>كلمة المرور الجديدة (6+ أحرف)</label>
        <input id="pwNext" type="password" dir="ltr">
        <button class="btn primary" id="pwSave" style="margin-top:14px">تغيير كلمة المرور</button>
      </div>
    </div>`;

  $('stSave').onclick = async () => {
    try {
      await api('/config', 'PUT', {
        currency: $('stCurrency').value,
        pricing: {
          trial: Number($('stTrial').value),
          monthly: Number($('stMonthly').value),
          quarterly: Number($('stQuarterly').value),
          yearly: Number($('stYearly').value),
        },
      });
      await loadConfig();
      toast('تم حفظ الأسعار');
    } catch (_) { toast('فشل الحفظ', false); }
  };

  $('pwSave').onclick = async () => {
    try {
      await api('/auth/password', 'POST', {
        current: $('pwCurrent').value,
        next: $('pwNext').value,
      });
      toast('تم تغيير كلمة المرور');
      $('pwCurrent').value = $('pwNext').value = '';
    } catch (e) {
      toast({
        WEAK_PASSWORD: 'كلمة المرور 6 أحرف على الأقل',
        BAD_CREDENTIALS: 'كلمة المرور الحالية غير صحيحة',
      }[e.message] || 'فشل التغيير', false);
    }
  };
}

/* ── clock ────────────────────────────────────────────────────── */
setInterval(() => {
  const el = $('serverClock');
  if (el) el.textContent = new Date().toLocaleTimeString('ar-EG-u-nu-latn');
}, 1000);

boot();
