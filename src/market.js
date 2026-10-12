/**
 * market.js — v4.0 منصة البيع أونلاين (سيلا ماركت).
 * ─────────────────────────────────────────────────────────────────
 * ثلاث مجموعات واجهات فوق نفس قاعدة بيانات التراخيص:
 *
 *  1) Merchant API  /api/v1/store/*   — تطبيق نقطة البيع سيلا
 *     (مصادقة صامتة بنفس زوج license+signature+deviceId الخاص بالنبضة):
 *       POST /register        إنشاء/تحديث ملف المتجر + مناطق التوصيل
 *       POST /products/sync   مزامنة الكتالوج (idempotent بـ product_ref)
 *       POST /orders/poll     طلبات جديدة/محدثة منذ مؤشر زمني
 *       POST /orders/action   قبول/رفض/إرسال/تسليم/إلغاء (+invoice_ref)
 *
 *  2) Market API   /api/market/*      — تطبيق المتجر للمستخدمين (عام)
 *       GET  /stores · /stores/:id · /stores/:id/products
 *       GET  /products (عابر للمتاجر) · /categories
 *       POST /auth/register · /auth/login        (token جلسة)
 *       POST /orders · GET /orders · POST /orders/:id/cancel
 *
 *  3) Admin API    /api/admin/market/* — لوحة التحكم (متاجر + طلبات)
 *
 * مبادئ الحماية:
 *  • هوية التاجر = مفتاح اشتراكه: كل نداء تجاري يعيد بيانات متجر
 *    المفتاح نفسه فقط — عزل كامل بين نقاط البيع.
 *  • النشر مربوط بحيوية الاشتراك: حارس دوري + فحص لحظي عند كل نداء؛
 *    مفتاح موقوف/منتهٍ ⇒ published=0 فتختفي المنتجات من المتجر.
 *  • الأسعار والتوتال تُحسب على الخادم من أسعار المتجر المخزنة — لا
 *    يُثق أبداً بأسعار العميل.
 *  • كل تغيير حالة يرفع revision — نداءات POS idempotent.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const {db, stmt, getSetting, audit} = require('./db');
const {verifyLicensePair} = require('./crypto');

const DAY_MS = 24 * 3600 * 1000;

/* ════════════════════════════════════════════════════════════════
 * DDL — جداول المنصة (idempotent، تعمل مع ترقية أي نشر قائم)
 * ════════════════════════════════════════════════════════════════ */
db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id        INTEGER NOT NULL UNIQUE REFERENCES keys(id),
  store_number  TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  region        TEXT,
  phone         TEXT,
  whatsapp      TEXT,
  published     INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'ILS',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stores_published ON stores(published);

CREATE TABLE IF NOT EXISTS store_delivery_regions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  fee_minor     INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(store_id, name)
);

CREATE TABLE IF NOT EXISTS store_products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_ref   TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT,
  price_minor   INTEGER NOT NULL CHECK (price_minor >= 0),
  stock         REAL NOT NULL DEFAULT 0,
  barcode       TEXT,
  sold_by_weight INTEGER NOT NULL DEFAULT 0,
  unit_label    TEXT,
  description   TEXT,
  available     INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL,
  UNIQUE(store_id, product_ref)
);
CREATE INDEX IF NOT EXISTS idx_store_products_store ON store_products(store_id, available);
CREATE INDEX IF NOT EXISTS idx_store_products_category ON store_products(category);

CREATE TABLE IF NOT EXISTS market_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  id_number     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS market_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_tokens_user ON market_tokens(user_id);

CREATE TABLE IF NOT EXISTS market_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number  TEXT NOT NULL UNIQUE,
  store_id      INTEGER NOT NULL REFERENCES stores(id),
  user_id       INTEGER NOT NULL REFERENCES market_users(id),
  status        TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','accepted','rejected','sent','delivered','cancelled','returned')),
  region_name   TEXT,
  address       TEXT,
  note          TEXT,
  delivery_fee_minor INTEGER NOT NULL DEFAULT 0,
  items_total_minor  INTEGER NOT NULL DEFAULT 0,
  total_minor        INTEGER NOT NULL DEFAULT 0,
  returned_minor     INTEGER NOT NULL DEFAULT 0,
  invoice_ref   TEXT,
  reject_reason TEXT,
  cancel_reason TEXT,
  revision      INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  sent_at       INTEGER,
  delivered_at  INTEGER,
  cancelled_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_store ON market_orders(store_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_user ON market_orders(user_id, updated_at);

CREATE TABLE IF NOT EXISTS market_order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES market_orders(id) ON DELETE CASCADE,
  product_id    INTEGER,
  product_ref   TEXT,
  product_name  TEXT NOT NULL,
  unit_price_minor INTEGER NOT NULL,
  quantity      REAL NOT NULL CHECK (quantity > 0),
  line_total_minor INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON market_order_items(order_id);
`);

/* ── عبارات معدّة مسبقاً (نفس انضباط db.js: تنشأ مرة واحدة) ───── */
const m = {
  storeByKey: db.prepare('SELECT * FROM stores WHERE key_id = ?'),
  storeById: db.prepare('SELECT * FROM stores WHERE id = ?'),
  insertStore: db.prepare(
    `INSERT INTO stores (key_id, store_number, name, description, category, region, phone, whatsapp, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`),
  updateStore: db.prepare(
    `UPDATE stores SET name = ?, description = ?, category = ?, region = ?, phone = ?, whatsapp = ?, updated_at = ?
     WHERE id = ?`),
  setStorePublished: db.prepare('UPDATE stores SET published = ?, updated_at = ? WHERE id = ?'),
  touchStore: db.prepare('UPDATE stores SET last_seen_at = ? WHERE id = ?'),
  clearRegions: db.prepare('DELETE FROM store_delivery_regions WHERE store_id = ?'),
  insertRegion: db.prepare(
    `INSERT INTO store_delivery_regions (store_id, name, fee_minor, enabled, sort_order)
     VALUES (?, ?, ?, 1, ?)`),
  listRegions: db.prepare(
    'SELECT name, fee_minor, enabled, sort_order FROM store_delivery_regions WHERE store_id = ? ORDER BY sort_order ASC'),

  upsertProduct: db.prepare(
    `INSERT INTO store_products
       (store_id, product_ref, name, category, price_minor, stock, barcode, sold_by_weight, unit_label, description, available, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(store_id, product_ref) DO UPDATE SET
       name = excluded.name, category = excluded.category,
       price_minor = excluded.price_minor, stock = excluded.stock,
       barcode = excluded.barcode, sold_by_weight = excluded.sold_by_weight,
       unit_label = excluded.unit_label, description = excluded.description,
       available = 1, updated_at = excluded.updated_at`),
  markMissingUnavailable: db.prepare(
    `UPDATE store_products SET available = 0, updated_at = ?
     WHERE store_id = ? AND updated_at < ?`),
  countProducts: db.prepare(
    'SELECT COUNT(*) AS n FROM store_products WHERE store_id = ? AND available = 1'),

  insertUser: db.prepare(
    'INSERT INTO market_users (id_number, name, phone, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'),
  userByIdNumber: db.prepare('SELECT * FROM market_users WHERE id_number = ?'),
  userById: db.prepare('SELECT * FROM market_users WHERE id = ?'),
  touchUser: db.prepare('UPDATE market_users SET last_seen_at = ? WHERE id = ?'),
  insertToken: db.prepare(
    'INSERT INTO market_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  tokenByHash: db.prepare('SELECT * FROM market_tokens WHERE token_hash = ?'),
  purgeTokens: db.prepare('DELETE FROM market_tokens WHERE expires_at < ?'),
  // v4.1: حذف الحساب — إلغاء الجلسات ثم مسح الهوية الشخصية
  // (disabled=1 + تحرير رقم الهوية ببادئة DEL- + تفريغ الاسم/الهاتف).
  deleteTokensOfUser: db.prepare('DELETE FROM market_tokens WHERE user_id = ?'),
  anonymizeUser: db.prepare(
    `UPDATE market_users SET
       id_number = ?, name = '', phone = '', disabled = 1, last_seen_at = ?
     WHERE id = ?`),

  insertOrder: db.prepare(
    `INSERT INTO market_orders
       (order_number, store_id, user_id, status, region_name, address, note,
        delivery_fee_minor, items_total_minor, total_minor, created_at, updated_at)
     VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`),
  orderById: db.prepare('SELECT * FROM market_orders WHERE id = ?'),
  orderByNumber: db.prepare('SELECT * FROM market_orders WHERE order_number = ?'),
  ordersForStoreSince: db.prepare(
    `SELECT * FROM market_orders WHERE store_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT 500`),
  ordersForUser: db.prepare(
    `SELECT * FROM market_orders WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`),
  updateOrderStatus: db.prepare(
    `UPDATE market_orders SET status = ?, updated_at = ?, revision = revision + 1,
       accepted_at = COALESCE(?, accepted_at), sent_at = COALESCE(?, sent_at),
       delivered_at = COALESCE(?, delivered_at), cancelled_at = COALESCE(?, cancelled_at),
       invoice_ref = COALESCE(?, invoice_ref), reject_reason = COALESCE(?, reject_reason),
       cancel_reason = COALESCE(?, cancel_reason), returned_minor = ?
     WHERE id = ?`),
  insertOrderItem: db.prepare(
    `INSERT INTO market_order_items
       (order_id, product_id, product_ref, product_name, unit_price_minor, quantity, line_total_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?)`),
  orderItems: db.prepare('SELECT * FROM market_order_items WHERE order_id = ?'),

  publishedStores: db.prepare(
    `SELECT s.id, s.store_number, s.name, s.description, s.category, s.region, s.phone, s.whatsapp
     FROM stores s JOIN keys k ON k.id = s.key_id
     WHERE s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
     ORDER BY s.updated_at DESC LIMIT 500`),
  storeProductsPage: db.prepare(
    `SELECT p.id, p.product_ref, p.name, p.category, p.price_minor, p.stock, p.barcode,
            p.sold_by_weight, p.unit_label, p.description, p.store_id
     FROM store_products p WHERE p.store_id = ? AND p.available = 1
     ORDER BY p.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`),
  storeProductsSearch: db.prepare(
    `SELECT p.id, p.product_ref, p.name, p.category, p.price_minor, p.stock, p.barcode,
            p.sold_by_weight, p.unit_label, p.description, p.store_id
     FROM store_products p WHERE p.store_id = ? AND p.available = 1
       AND p.name LIKE ? ESCAPE '\\'
     ORDER BY p.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`),
  storeProductByIds: db.prepare(
    `SELECT * FROM store_products WHERE store_id = ? AND available = 1 AND id = ?`),
  crossProducts: db.prepare(
    `SELECT p.id, p.product_ref, p.name, p.category, p.price_minor, p.stock, p.barcode,
            p.sold_by_weight, p.unit_label, p.store_id, s.name AS store_name, s.store_number
     FROM store_products p
     JOIN stores s ON s.id = p.store_id
     JOIN keys k ON k.id = s.key_id
     WHERE p.available = 1 AND s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
     ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`),
  categories: db.prepare(
    `SELECT p.category AS category, COUNT(*) AS n FROM store_products p
     JOIN stores s ON s.id = p.store_id
     JOIN keys k ON k.id = s.key_id
     WHERE p.available = 1 AND p.category IS NOT NULL AND p.category != ''
       AND s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
     GROUP BY p.category ORDER BY n DESC LIMIT 100`),
};

/* ── أدوات مساعدة ─────────────────────────────────────────────── */

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** ORD-YYYYMMDD-XXXXXX — اليوم + 6 محارف عشوائية (تصادم شبه مستحيل،
 *  وقيد UNIQUE يحسم أي تصادم نظري بإعادة المحاولة). */
function generateOrderNumber() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `ORD-${day}-${rand}`;
}

/** هل اشتراك المفتاح حي؟ (غير موقوف + نافذة الخطة منتهية بعد) */
function keyActive(keyRow, now) {
  if (!keyRow) return false;
  if (keyRow.revoked_at) return false;
  if (keyRow.plan_expires_at == null) return false;
  return keyRow.plan_expires_at > now;
}

/** الحارس الدوري: إخفاء متاجر المفاتيح المنتهية/الموقوفة.
 *  تُشغَّل أيضاً يدوياً عند اكتشاف مفتاح منتهٍ في أي نداء. */
function sweepInactiveStores() {
  const now = Date.now();
  const result = db.prepare(
    `UPDATE stores SET published = 0, updated_at = ?
     WHERE published = 1 AND key_id IN (
       SELECT id FROM keys
       WHERE revoked_at IS NOT NULL
          OR plan_expires_at IS NULL
          OR plan_expires_at <= ?
     )`,
  ).run(now, now);
  return result.changes;
}

/* ════════════════════════════════════════════════════════════════
 * 1) Merchant API — /api/v1/store/*
 * ════════════════════════════════════════════════════════════════ */

function buildStoreRouter() {
  const router = express.Router();

  /** مصادقة التاجر: نفس زوج النبضة (license+signature+deviceId).
   *  يفشل صراحة عندما ينتهي الاشتراك ويخفي المتجر فوراً. */
  function authenticate(body, res) {
    const {license, signature, deviceId} = body || {};
    if (
      typeof license !== 'string' ||
      typeof signature !== 'string' ||
      typeof deviceId !== 'string'
    ) {
      res.status(400).json({ok: false, error: 'BAD_AUTH'});
      return null;
    }
    const payload = verifyLicensePair(license, signature);
    if (!payload || payload.deviceId !== deviceId) {
      res.status(403).json({ok: false, error: 'INVALID_LICENSE'});
      return null;
    }
    const binding = stmt.bindingByKeyDevice.get(payload.keyId, deviceId);
    if (!binding) {
      res.status(403).json({ok: false, error: 'UNKNOWN_DEVICE'});
      return null;
    }
    const keyRow = stmt.keyById.get(payload.keyId);
    const now = Date.now();
    if (!keyActive(keyRow, now)) {
      sweepInactiveStores();
      res.status(403).json({ok: false, error: 'SUBSCRIPTION_ENDED'});
      return null;
    }
    const store = m.storeByKey.get(payload.keyId);
    if (store != null) {
      m.touchStore.run(now, store.id);
    }
    return {payload, keyRow, binding, store, now};
  }

  function requireStore(auth, res) {
    if (auth.store == null) {
      res.status(404).json({ok: false, error: 'STORE_NOT_REGISTERED'});
      return false;
    }
    return true;
  }

  /* ── register: إنشاء/تحديث ملف المتجر + مناطق التوصيل ────── */
  router.post('/register', (req, res) => {
    const auth = authenticate(req.body, res);
    if (!auth) return;
    const {store, deliveryRegions, published} = req.body || {};
    if (store == null || typeof store !== 'object' ||
        typeof store.name !== 'string' || store.name.trim().length < 2) {
      return res.status(400).json({ok: false, error: 'BAD_STORE'});
    }
    const name = store.name.trim().slice(0, 80);
    const description = String(store.description || '').trim().slice(0, 400) || null;
    const category = String(store.category || '').trim().slice(0, 40) || null;
    const region = String(store.region || '').trim().slice(0, 60) || null;
    const phone = String(store.phone || '').trim().slice(0, 24) || null;
    const whatsapp = String(store.whatsapp || '').trim().slice(0, 24) || null;

    const regions = Array.isArray(deliveryRegions)
      ? deliveryRegions
          .filter(r => r && typeof r.name === 'string' && r.name.trim().length > 0)
          .slice(0, 30)
          .map((r, i) => ({
            name: r.name.trim().slice(0, 60),
            feeMinor: Math.max(0, Math.min(100000000, Math.round(Number(r.feeMinor) || 0))),
            sort: i,
          }))
      : [];

    const now = auth.now;
    let storeId;
    db.transaction(() => {
      if (auth.store == null) {
        const info = m.insertStore.run(
          auth.keyRow.id,
          '', // store_number يُولَّد بعد الإدراج (يحتاج id)
          name, description, category, region, phone, whatsapp,
          now, now,
        );
        storeId = Number(info.lastInsertRowid);
        const storeNumber = 'ST-' + String(100000 + storeId).slice(-6);
        db.prepare('UPDATE stores SET store_number = ? WHERE id = ?').run(storeNumber, storeId);
      } else {
        storeId = auth.store.id;
        m.updateStore.run(name, description, category, region, phone, whatsapp, now, storeId);
        // النشر المطلوب صراحة من التاجر (تفعيل/تعطيل البيع أونلاين)
        m.setStorePublished.run(published === false ? 0 : 1, now, storeId);
        m.clearRegions.run(storeId);
      }
      if (auth.store == null) {
        // متجر جديد: النشر يبدأ مفعّلاً (التاجر ضغط «تفعيل» في POS)
        m.setStorePublished.run(published === false ? 0 : 1, now, storeId);
      }
      for (const r of regions) {
        m.insertRegion.run(storeId, r.name, r.feeMinor, r.sort);
      }
    })();

    audit('store_register', {
      keyId: auth.keyRow.id,
      deviceId: auth.payload.deviceId,
      ip: req.ip,
      details: {storeId, name},
    });
    const fresh = m.storeById.get(storeId);
    res.json({
      ok: true,
      store: {
        id: fresh.id,
        storeNumber: fresh.store_number,
        published: fresh.published === 1,
      },
      serverTime: now,
    });
  });

  /* ── products/sync: الكتالوج الكامل (idempotent) ─────────── */
  router.post('/products/sync', (req, res) => {
    const auth = authenticate(req.body, res);
    if (!auth) return;
    if (!requireStore(auth, res)) return;
    const {products} = req.body || {};
    if (!Array.isArray(products) || products.length > 5000) {
      return res.status(400).json({ok: false, error: 'BAD_PRODUCTS'});
    }
    const now = auth.now;
    let saved = 0;
    db.transaction(() => {
      for (const p of products) {
        if (p == null || typeof p.ref !== 'string' || typeof p.name !== 'string') {
          continue;
        }
        const priceMinor = Math.max(0, Math.min(100000000, Math.round(Number(p.priceMinor) || 0)));
        m.upsertProduct.run(
          auth.store.id,
          String(p.ref).slice(0, 40),
          p.name.slice(0, 120),
          String(p.category || '').trim().slice(0, 40) || null,
          priceMinor,
          Number.isFinite(Number(p.stock)) ? Math.max(0, Number(p.stock)) : 0,
          String(p.barcode || '').trim().slice(0, 60) || null,
          p.soldByWeight ? 1 : 0,
          String(p.unitLabel || '').trim().slice(0, 20) || null,
          String(p.description || '').trim().slice(0, 300) || null,
          now,
        );
        saved += 1;
      }
      // المنتجات الغائبة عن هذه المزامنة → غير متاحة (لا حذف أبداً)
      m.markMissingUnavailable.run(now, auth.store.id, now);
    })();
    res.json({
      ok: true,
      saved,
      published: auth.store.published === 1,
      serverTime: now,
    });
  });

  /* ── orders/poll: طلبات جديدة/محدثة منذ مؤشر ─────────────── */
  router.post('/orders/poll', (req, res) => {
    const auth = authenticate(req.body, res);
    if (!auth) return;
    if (!requireStore(auth, res)) return;
    const since = Number(req.body?.since) || 0;
    const rows = m.ordersForStoreSince.all(auth.store.id, since);
    const orders = rows.map(o => {
      const user = m.userById.get(o.user_id);
      return {
        ...o,
        items: m.orderItems.all(o.id),
        customer: user
          ? {name: user.name, phone: user.phone, idNumber: user.id_number}
          : null,
      };
    });
    res.json({ok: true, orders, serverTime: auth.now});
  });

  /* ── orders/action: انتقالات الحالة (idempotent بالمراجعة) ── */
  router.post('/orders/action', (req, res) => {
    const auth = authenticate(req.body, res);
    if (!auth) return;
    if (!requireStore(auth, res)) return;
    const {orderNumber, action, reason, invoiceRef, returnedMinor} = req.body || {};
    const order = typeof orderNumber === 'string'
      ? m.orderByNumber.get(orderNumber)
      : null;
    if (order == null || order.store_id !== auth.store.id) {
      return res.status(404).json({ok: false, error: 'ORDER_NOT_FOUND'});
    }
    const now = auth.now;
    const reasonText = String(reason || '').trim().slice(0, 200) || null;

    /** خريطة الانتقالات المسموحة — قاعدة الحالة الواحدة المصدر. */
    const ALLOWED = {
      accept:   {from: ['new'],                to: 'accepted'},
      reject:   {from: ['new'],                to: 'rejected'},
      send:     {from: ['accepted'],           to: 'sent'},
      deliver:  {from: ['sent'],               to: 'delivered'},
      cancel:   {from: ['new', 'accepted'],    to: 'cancelled'},
      return:   {from: ['sent', 'delivered'],  to: null}, // حالة خاصة أدناه
    };
    const rule = ALLOWED[action];
    if (rule == null) {
      return res.status(400).json({ok: false, error: 'BAD_ACTION'});
    }
    if (action === 'return') {
      // إرجاع كلي/جزئي: يُرحَّل المبلغ المرتجع؛ الكلي فقط يقلب الحالة.
      // القيمة يجب ألا تتجاوز المتبقي القابل للإرجاع فعلاً.
      const value = Math.max(0, Math.round(Number(returnedMinor) || 0));
      const returnableLeft = order.items_total_minor - order.returned_minor;
      if (value <= 0 || value > returnableLeft) {
        return res.status(400).json({ok: false, error: 'BAD_RETURN_VALUE'});
      }
      const newReturned = order.returned_minor + value;
      const fullReturn = newReturned >= order.items_total_minor;
      db.transaction(() => {
        m.updateOrderStatus.run(
          fullReturn ? 'returned' : order.status,
          now, null, null, null, null,
          typeof invoiceRef === 'string' ? invoiceRef : null,
          null, null,
          newReturned,
          order.id,
        );
      })();
      audit('store_order_return', {
        keyId: auth.keyRow.id,
        deviceId: auth.payload.deviceId,
        ip: req.ip,
        details: {order: order.order_number, value, fullReturn},
      });
      return res.json({ok: true, order: m.orderById.get(order.id), serverTime: now});
    }
    if (!rule.from.includes(order.status)) {
      // idempotent: إعادة نداء لانتقال تم أصلاً بنفس النتيجة ≠ خطأ
      const idempotent =
        (action === 'accept' && order.status === 'accepted') ||
        (action === 'send' && order.status === 'sent' && order.invoice_ref === (invoiceRef ?? order.invoice_ref)) ||
        (action === 'deliver' && order.status === 'delivered') ||
        ((action === 'reject' || action === 'cancel') && ['rejected', 'cancelled'].includes(order.status));
      if (idempotent) {
        return res.json({ok: true, order, serverTime: now});
      }
      return res.status(409).json({ok: false, error: 'BAD_STATUS', status: order.status});
    }
    db.transaction(() => {
      m.updateOrderStatus.run(
        rule.to,
        now,
        action === 'accept' ? now : null,
        action === 'send' ? now : null,
        action === 'deliver' ? now : null,
        ['reject', 'cancel'].includes(action) ? now : null,
        action === 'send' && typeof invoiceRef === 'string' ? invoiceRef : null,
        action === 'reject' ? reasonText : null,
        action === 'cancel' ? reasonText : null,
        order.returned_minor,
        order.id,
      );
    })();
    audit('store_order_' + action, {
      keyId: auth.keyRow.id,
      deviceId: auth.payload.deviceId,
      ip: req.ip,
      details: {order: order.order_number},
    });
    res.json({ok: true, order: m.orderById.get(order.id), serverTime: now});
  });

  return router;
}

/* ════════════════════════════════════════════════════════════════
 * 2) Market API — /api/market/* (تطبيق المتجر للمستخدمين)
 * ════════════════════════════════════════════════════════════════ */

function buildMarketRouter() {
  const router = express.Router();

  const TOKEN_HEADER = 'x-market-token';

  /** يقرأ رمز الجلسة ويرجع المستخدم (أو null). */
  function currentUser(req) {
    const token = String(req.get(TOKEN_HEADER) || '').trim();
    if (token.length < 16) return null;
    const row = m.tokenByHash.get(sha256(token));
    if (row == null || row.expires_at < Date.now()) return null;
    const user = m.userById.get(row.user_id);
    if (user == null || user.disabled) return null;
    m.touchUser.run(Date.now(), user.id);
    return user;
  }

  function storePublic(storeId) {
    const store = m.storeById.get(storeId);
    if (store == null) return null;
    const keyRow = stmt.keyById.get(store.key_id);
    if (store.published !== 1 || !keyActive(keyRow, Date.now())) return null;
    return store;
  }

  /* ── المتاجر والمنتجات (عام) ───────────────────────────────── */

  router.get('/stores', (_req, res) => {
    const now = Date.now();
    res.json({ok: true, stores: m.publishedStores.all(now)});
  });

  router.get('/stores/:id', (req, res) => {
    const store = storePublic(Number(req.params.id));
    if (!store) return res.status(404).json({ok: false, error: 'STORE_NOT_FOUND'});
    res.json({
      ok: true,
      store: {
        id: store.id,
        storeNumber: store.store_number,
        name: store.name,
        description: store.description,
        category: store.category,
        region: store.region,
        phone: store.phone,
        whatsapp: store.whatsapp,
      },
      deliveryRegions: m.listRegions.all(store.id).filter(r => r.enabled === 1),
    });
  });

  router.get('/stores/:id/products', (req, res) => {
    const store = storePublic(Number(req.params.id));
    if (!store) return res.status(404).json({ok: false, error: 'STORE_NOT_FOUND'});
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    const per = Math.min(100, Math.max(10, Number(req.query.per) || 50));
    const like = q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    const rows = q
      ? m.storeProductsSearch.all(store.id, like, per, (page - 1) * per)
      : m.storeProductsPage.all(store.id, per, (page - 1) * per);
    res.json({ok: true, products: rows, page});
  });

  router.get('/products', (req, res) => {
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    const per = Math.min(100, Math.max(10, Number(req.query.per) || 50));
    const rows = m.crossProducts.all(Date.now(), per, (page - 1) * per);
    res.json({ok: true, products: rows, page});
  });

  router.get('/categories', (_req, res) => {
    res.json({ok: true, categories: m.categories.all(Date.now())});
  });

  /* ── حسابات المستخدمين ─────────────────────────────────────── */

  function issueToken(user) {
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    m.insertToken.run(sha256(token), user.id, now, now + 90 * DAY_MS);
    m.purgeTokens.run(now);
    return token;
  }

  router.post('/auth/register', (req, res) => {
    const {idNumber, name, phone} = req.body || {};
    const id = String(idNumber || '').replace(/\s+/g, '');
    const cleanName = String(name || '').trim();
    const cleanPhone = String(phone || '').replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(id)) {
      return res.status(400).json({ok: false, error: 'BAD_ID_NUMBER'});
    }
    if (cleanName.length < 2 || cleanName.length > 60) {
      return res.status(400).json({ok: false, error: 'BAD_NAME'});
    }
    if (!/^\+?\d{9,15}$/.test(cleanPhone)) {
      return res.status(400).json({ok: false, error: 'BAD_PHONE'});
    }
    if (m.userByIdNumber.get(id) != null) {
      return res.status(409).json({ok: false, error: 'ID_ALREADY_REGISTERED'});
    }
    const now = Date.now();
    const info = m.insertUser.run(id, cleanName, cleanPhone, now, now);
    const user = m.userById.get(Number(info.lastInsertRowid));
    res.json({ok: true, token: issueToken(user), user: {name: user.name, idNumber: user.id_number}});
  });

  router.post('/auth/login', (req, res) => {
    const {idNumber, phone} = req.body || {};
    const id = String(idNumber || '').replace(/\s+/g, '');
    const user = m.userByIdNumber.get(id);
    if (user == null || user.disabled ||
        String(user.phone) !== String(phone || '').replace(/[\s-]/g, '')) {
      return res.status(403).json({ok: false, error: 'BAD_CREDENTIALS'});
    }
    res.json({ok: true, token: issueToken(user), user: {name: user.name, idNumber: user.id_number}});
  });

  /* ── الطلبات ───────────────────────────────────────────────── */

  /* ── حذف الحساب (سياسة جوجل بلاي: مسار حذف داخل التطبيق) ──
   * v4.1: حذف ناعم يحقق سياسة «حذف بيانات الحساب» دون كسر
   * سلامة الطلبات التاريخية للتجار:
   *  • disabled = 1 → الجلسات تلغى والدخول بهذا الصف مستحيل.
   *  • تُحذف كل رموز الجلسة فوراً (قطع الوصول الحالي).
   *  • تُمس الهوية الشخصية: الاسم والهاتف يصبحان فارغين
   *    ورقم الهوية يُحرَّر (بادئة DEL-) ليستطيع صاحبه التسجيل
   *    مجدداً بنفس الهوية إن عاد.
   *  • طلباته السابقة تبقى للتجار (سجلات فواتيرهم) دون أي
   *    بيانات تعريف شخصية — الطلبات أصلاً لا تحمل الاسم/الهاتف.
   */
  router.post('/auth/delete', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const now = Date.now();
    db.transaction(() => {
      m.deleteTokensOfUser.run(user.id);
      m.anonymizeUser.run(`DEL-${user.id}-${now}`, now, user.id);
    })();
    audit('market_account_deleted', {
      ip: req.ip,
      details: {userId: user.id},
    });
    res.json({ok: true});
  });

  router.post('/orders', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const {storeId, items, regionName, address, note} = req.body || {};
    const store = storePublic(Number(storeId));
    if (!store) return res.status(404).json({ok: false, error: 'STORE_NOT_FOUND'});
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
      return res.status(400).json({ok: false, error: 'BAD_ITEMS'});
    }
    const region = String(regionName || '').trim();
    const regions = m.listRegions.all(store.id).filter(r => r.enabled === 1);
    const matched = regions.find(r => r.name === region);
    if (matched == null) {
      return res.status(400).json({ok: false, error: 'BAD_REGION',
        regions: regions.map(r => ({name: r.name, feeMinor: r.fee_minor}))});
    }

    // الأسعار تُقرأ من كتالوج المتجر على الخادم — لا ثقة بأي سعر من العميل.
    let itemsTotal = 0;
    const lines = [];
    for (const it of items) {
      const product = m.storeProductByIds.get(store.id, Number(it?.productId));
      if (product == null) {
        return res.status(400).json({ok: false, error: 'PRODUCT_NOT_FOUND',
          productId: it?.productId});
      }
      const quantity = Number(it?.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
        return res.status(400).json({ok: false, error: 'BAD_QUANTITY'});
      }
      const lineTotal = Math.round(product.price_minor * quantity);
      itemsTotal += lineTotal;
      lines.push({product, quantity, lineTotal});
    }
    const deliveryFee = matched.fee_minor;
    const total = itemsTotal + deliveryFee;

    const now = Date.now();
    let order = null;
    db.transaction(() => {
      let orderNumber = generateOrderNumber();
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const info = m.insertOrder.run(
            orderNumber, store.id, user.id,
            matched.name,
            String(address || '').trim().slice(0, 200) || null,
            String(note || '').trim().slice(0, 300) || null,
            deliveryFee, itemsTotal, total, now, now,
          );
          const orderId = Number(info.lastInsertRowid);
          for (const l of lines) {
            m.insertOrderItem.run(
              orderId, l.product.id, l.product.product_ref, l.product.name,
              l.product.price_minor, l.quantity, l.lineTotal,
            );
          }
          order = m.orderById.get(orderId);
          break;
        } catch (e) {
          if (!/UNIQUE/i.test(String(e?.message))) throw e;
          orderNumber = generateOrderNumber();
        }
      }
      if (order == null) throw new Error('ORDER_NUMBER_COLLISION');
    })();

    audit('market_order_placed', {
      ip: req.ip,
      details: {order: order.order_number, storeId: store.id},
    });
    res.json({ok: true, order});
  });

  router.get('/orders', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const orders = m.ordersForUser.all(user.id).map(o => ({
      ...o,
      items: m.orderItems.all(o.id),
      store: (() => {
        const s = m.storeById.get(o.store_id);
        return s ? {id: s.id, name: s.name, storeNumber: s.store_number} : null;
      })(),
    }));
    res.json({ok: true, orders});
  });

  router.post('/orders/:id/cancel', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const order = m.orderById.get(Number(req.params.id));
    if (order == null || order.user_id !== user.id) {
      return res.status(404).json({ok: false, error: 'ORDER_NOT_FOUND'});
    }
    if (!['new', 'accepted'].includes(order.status)) {
      return res.status(409).json({ok: false, error: 'BAD_STATUS', status: order.status});
    }
    const now = Date.now();
    m.updateOrderStatus.run('cancelled', now, null, null, null, now, null, null,
      'ألغى المستخدم الطلب', order.returned_minor, order.id);
    audit('market_order_cancelled', {ip: req.ip, details: {order: order.order_number}});
    res.json({ok: true, order: m.orderById.get(order.id)});
  });

  return router;
}

/* ════════════════════════════════════════════════════════════════
 * 3) Admin API — /api/admin/market/* (لوحة التحكم)
 * ════════════════════════════════════════════════════════════════ */

function buildMarketAdminRouter() {
  const router = express.Router();

  router.get('/stores', (req, res) => {
    const rows = db.prepare(
      `SELECT s.*, k.key_plain, k.revoked_at, k.plan_expires_at,
         (SELECT COUNT(*) FROM store_products p
           WHERE p.store_id = s.id AND p.available = 1) AS products_count,
         (SELECT COUNT(*) FROM market_orders o WHERE o.store_id = s.id) AS orders_count,
         (SELECT COUNT(*) FROM market_orders o
           WHERE o.store_id = s.id AND o.status = 'new') AS new_orders
       FROM stores s JOIN keys k ON k.id = s.key_id
       ORDER BY s.updated_at DESC LIMIT 500`,
    ).all();
    const now = Date.now();
    res.json({
      ok: true,
      stores: rows.map(r => ({
        ...r,
        subscriptionActive: !r.revoked_at && r.plan_expires_at != null && r.plan_expires_at > now,
      })),
    });
  });

  router.post('/stores/:id/publish', (req, res) => {
    const id = Number(req.params.id);
    const store = m.storeById.get(id);
    if (!store) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const keyRow = stmt.keyById.get(store.key_id);
    const published = req.body?.published ? 1 : 0;
    if (published && !keyActive(keyRow, Date.now())) {
      return res.status(409).json({ok: false, error: 'SUBSCRIPTION_ENDED'});
    }
    m.setStorePublished.run(published, Date.now(), id);
    audit('admin_market_publish', {adminId: req.adminUser.id, ip: req.ip,
      details: {storeId: id, published}});
    res.json({ok: true});
  });

  router.get('/orders', (req, res) => {
    const storeId = Number(req.query.storeId) || 0;
    const status = String(req.query.status || '').trim();
    let sql = `SELECT o.*, s.name AS store_name, u.name AS user_name, u.phone AS user_phone
               FROM market_orders o
               JOIN stores s ON s.id = o.store_id
               JOIN market_users u ON u.id = o.user_id`;
    const where = [];
    const params = [];
    if (storeId > 0) { where.push('o.store_id = ?'); params.push(storeId); }
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY o.updated_at DESC LIMIT 500';
    res.json({ok: true, orders: db.prepare(sql).all(...params)});
  });

  router.get('/stats', (_req, res) => {
    const now = Date.now();
    const count = (sql, ...p) => db.prepare(sql).get(...p).n;
    res.json({
      ok: true,
      stores: count('SELECT COUNT(*) n FROM stores'),
      publishedStores: count(
        `SELECT COUNT(*) n FROM stores s JOIN keys k ON k.id = s.key_id
         WHERE s.published = 1 AND k.revoked_at IS NULL
           AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?`, now),
      users: count('SELECT COUNT(*) n FROM market_users'),
      products: count('SELECT COUNT(*) n FROM store_products WHERE available = 1'),
      orders: count('SELECT COUNT(*) n FROM market_orders'),
      newOrders: count(`SELECT COUNT(*) n FROM market_orders WHERE status = 'new'`),
      deliveredOrders: count(`SELECT COUNT(*) n FROM market_orders WHERE status = 'delivered'`),
      gmvMinor: db.prepare(
        `SELECT COALESCE(SUM(total_minor - delivery_fee_minor), 0) v
         FROM market_orders WHERE status IN ('sent','delivered','returned')`).get().v,
    });
  });

  return router;
}

/* ── الحارس الدوري (كل 10 دقائق) + تنظيف الجلسات المنتهية ──── */
sweepInactiveStores();
setInterval(() => {
  try {
    const hidden = sweepInactiveStores();
    if (hidden > 0) {
      audit('market_sweep_hidden_stores', {details: {hidden}});
    }
    m.purgeTokens.run(Date.now());
  } catch (e) {
    console.error('[sela-market] sweep error:', e);
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  buildStoreRouter,
  buildMarketRouter,
  buildMarketAdminRouter,
  sweepInactiveStores,
  marketStatements: m,
};
