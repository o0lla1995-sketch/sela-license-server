/**
 * marketlog.js — سجل طلبات المول الحي (v5.1).
 * ─────────────────────────────────────────────────────────────────
 * وُلد من سبع جولات تشخيص «المنتجات لا تظهر» كان أصعب ما فيها أن
 * لا أحد يرى الطلبات: التطبيق مشفّر HTTPS فلا تظهر في برامج
 * الالتقاط، والمالك لا يملك سجلات وصول سهلة من Coolify. الآن
 * يسجِّل الخادم نفسه كل نداء يصله على /api/market/* في حلقة آخر
 * 400 نداء (الطريقة، المسار، الحالة، الحجم، الزمن، عنوان العميل،
 * الوكيل) ويعرضها المالك في لوحة الإدارة — قسم «سجل طلبات المول».
 *
 * الحجمة صفر تقنياً: خريطة صغيرة في الذاكرة تُفقد عند إعادة
 * التشغيل (مقبول تماماً لغرض التشخيص) ولا تكتب على القرص أبداً.
 */
'use strict';

const MAX_ENTRIES = 400;

/** @type {Array<{at:number, method:string, path:string, status:number, ms:number, bytes:number, ip:string, ua:string, ok:boolean}>} */
const entries = [];

/** عدّادات تراكمية للوحة القيادة: إجمالي النداءات وأخطاء آخر ساعة. */
const totals = {
  since: Date.now(),
  requests: 0,
  errors: 0,
  productsRequests: 0,
  productsErrors: 0,
};

function push(entry) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

/** وسيط التسجيل — يُركَّب على /api/market قبل الموجهات. */
function middleware(req, res, next) {
  const startedAt = Date.now();
  const isProducts = /\/products(\?|$)/.test(req.originalUrl || req.url);
  totals.requests += 1;
  if (isProducts) totals.productsRequests += 1;

  res.on('finish', () => {
    const rec = {
      at: startedAt,
      method: req.method,
      path: (req.originalUrl || req.url || '').slice(0, 160),
      status: res.statusCode,
      ms: Date.now() - startedAt,
      bytes: Number(res.getHeader('Content-Length') || 0),
      ip: String(req.ip || req.socket.remoteAddress || '?').slice(0, 45),
      ua: String(req.headers['user-agent'] || '').slice(0, 80),
      ok: res.statusCode < 400,
    };
    push(rec);
    if (!rec.ok) {
      totals.errors += 1;
      if (isProducts) totals.productsErrors += 1;
    }
  });
  next();
}

/** لقطة السجل (الأحدث أولاً) + العدادات. */
function snapshot() {
  return {
    entries: entries.slice().reverse(),
    totals: {...totals},
  };
}

function reset() {
  entries.splice(0, entries.length);
  totals.since = Date.now();
  totals.requests = 0;
  totals.errors = 0;
  totals.productsRequests = 0;
  totals.productsErrors = 0;
}

module.exports = {middleware, snapshot, reset, MAX_ENTRIES};
