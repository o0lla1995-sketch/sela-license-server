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
 *       v4.4: GET /regions · ?region= على /stores · دفتر عناوين
 *            (GET/POST /addresses · /addresses/:id/default|delete)
 *            · تقييم المتجر عند التسليم (POST /orders/:id/rate
 *            · GET /stores/:id/ratings) بمتوسط يظهر على كل المتاجر
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
const fs = require('fs');
const path = require('path');
const {db, stmt, getSetting, setSetting, audit} = require('./db');
const {verifyLicensePair} = require('./crypto');
const {sendSms, smsConfigComplete} = require('./sms');

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
  logo_image_id INTEGER REFERENCES store_images(id) ON DELETE SET NULL,
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
  discount_pct  REAL NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 95),
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
  password_hash TEXT,
  pw_updated_at INTEGER,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE IF NOT EXISTS store_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  hash          TEXT NOT NULL,
  ext           TEXT NOT NULL DEFAULT 'webp',
  bytes         INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE(store_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_store_images_store ON store_images(store_id);

CREATE TABLE IF NOT EXISTS store_product_images (
  product_id    INTEGER NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  image_id      INTEGER NOT NULL REFERENCES store_images(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_store_product_images_p ON store_product_images(product_id, sort_order);

CREATE TABLE IF NOT EXISTS market_tokens (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_tokens_user ON market_tokens(user_id);

/* ── v5.0: رموز استعادة كلمة المرور (نسيت كلمة المرور برمز SMS)
 * ──── خزن الرمز مُعمّى (scrypt) لا نصاً صريحاً — اختراق قاعدة
 * البيانات لا يكشف رموزاً صالحة. صلاحية 10 دقائق وحد أقصى 5
 * محاولات تحقق لكل رمز و3 رموز/ساعة لكل حساب (محدد المعدل في
 * الذاكرة أدناه). */
CREATE TABLE IF NOT EXISTS market_reset_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reset_codes_user ON market_reset_codes(user_id, created_at);

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
  items_discount_minor INTEGER NOT NULL DEFAULT 0,
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

/* ── v4.4: عناوين المستخدمين المحفوظة ────────────────────────
 * عنوان كامل (منطقة/مدينة/شارع/بناية/طابق/شقة) بلقب (منزل/عمل…)
 * وعنوان افتراضي واحد — يغذي التصفية «متاجر تخدم منطقتك»، مقارنة
 * رسوم التوصيل بين المتاجر، وإتمام الطلب بلمسة واحدة. */
CREATE TABLE IF NOT EXISTS market_addresses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT 'المنزل',
  region        TEXT NOT NULL,
  city          TEXT,
  street        TEXT,
  building      TEXT,
  floor         TEXT,
  apartment     TEXT,
  phone         TEXT,
  notes         TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_addresses_user ON market_addresses(user_id);

/* ── v4.4: تقييمات المتاجر عند استلام الطلب ──────────────────
 * تقييم واحد لكل طلب (owner فقط، بعد التسليم) 1–5 نجوم + تعليق
 * اختياري — يجمّع لكل متجر متوسطاً وعدداً يظهر في التطبيق. */
CREATE TABLE IF NOT EXISTS market_ratings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL UNIQUE REFERENCES market_orders(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
  store_id      INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment       TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_ratings_store ON market_ratings(store_id, created_at);
CREATE INDEX IF NOT EXISTS idx_market_ratings_user ON market_ratings(user_id);

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

/* ── v4.7: قرارات الإدارة بإخفاء منتجات بعينها ───────────────
 * إخفاء إداري دائم: مزامنة POS التالية ترفع available=1 لكل
 * الكتالوج، لذا يُخزَّن القرار هنا ويُعاد تطبيقه بعد كل مزامنة
 * (upsert → إعادة الإخفاء) — لا يعود منتج أخفته الإدارة إلا
 * بقرار من الإدارة نفسها. */
CREATE TABLE IF NOT EXISTS admin_hidden_products (
  product_id INTEGER PRIMARY KEY REFERENCES store_products(id) ON DELETE CASCADE,
  admin_id   INTEGER,
  hidden_at  INTEGER NOT NULL
);
`);

/* ── ترحيل v4.2: أعمدة كلمة المرور على نشر قائم (CREATE IF NOT
 *    EXISTS لا يضيف أعمدة لجدول موجود). PRAGMA table_info مرة واحدة. */
(function migrateUsersPassword() {
  const cols = db.prepare('PRAGMA table_info(market_users)').all().map(c => c.name);
  if (!cols.includes('password_hash')) {
    db.exec('ALTER TABLE market_users ADD COLUMN password_hash TEXT');
  }
  if (!cols.includes('pw_updated_at')) {
    db.exec('ALTER TABLE market_users ADD COLUMN pw_updated_at INTEGER');
  }
})();

/* ── ترحيل v4.3: خيارات المنتجات (مقاسات/ألوان/أحجام المشروبات…)
 *    + لقطة الخيار المختار على سطر الطلب (variant). */
(function migrateProductOptions() {
  const cols = db.prepare('PRAGMA table_info(store_products)').all().map(c => c.name);
  if (!cols.includes('options')) {
    db.exec('ALTER TABLE store_products ADD COLUMN options TEXT');
  }
  const itemCols = db.prepare('PRAGMA table_info(market_order_items)').all().map(c => c.name);
  if (!itemCols.includes('variant')) {
    db.exec('ALTER TABLE market_order_items ADD COLUMN variant TEXT');
  }
})();

/* ── تخزين صور المنتجات: DATA_DIR/market-images/<store_id>/<hash>.<ext>
 *    مسارات المحتوى المُوجّهة بالهاش تسمح بكاش دائم (immutable). */
const IMAGES_DIR = path.join(
  process.env.DATA_DIR || '/data', 'market-images');
fs.mkdirSync(IMAGES_DIR, {recursive: true});

/* ── ترحيل v4.5: خصومات المنتجات + شعار المتجر + خصم أسطر الطلب.
 *    (CREATE IF NOT EXISTS لا يضيف أعمدة لجداول منشورة قائمة). */
(function migrateV45() {
  const p = db.prepare('PRAGMA table_info(store_products)').all().map(c => c.name);
  if (!p.includes('discount_pct')) {
    db.exec('ALTER TABLE store_products ADD COLUMN discount_pct REAL NOT NULL DEFAULT 0');
  }
  const s = db.prepare('PRAGMA table_info(stores)').all().map(c => c.name);
  if (!s.includes('logo_image_id')) {
    db.exec('ALTER TABLE stores ADD COLUMN logo_image_id INTEGER REFERENCES store_images(id) ON DELETE SET NULL');
  }
  const o = db.prepare('PRAGMA table_info(market_orders)').all().map(c => c.name);
  if (!o.includes('items_discount_minor')) {
    db.exec('ALTER TABLE market_orders ADD COLUMN items_discount_minor INTEGER NOT NULL DEFAULT 0');
  }
})();

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
       (store_id, product_ref, name, category, price_minor, stock, barcode, sold_by_weight, unit_label, description, options, discount_pct, available, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(store_id, product_ref) DO UPDATE SET
       name = excluded.name, category = excluded.category,
       price_minor = excluded.price_minor, stock = excluded.stock,
       barcode = excluded.barcode, sold_by_weight = excluded.sold_by_weight,
       unit_label = excluded.unit_label, description = excluded.description,
       options = excluded.options, discount_pct = excluded.discount_pct,
       available = 1, updated_at = excluded.updated_at`),
  markMissingUnavailable: db.prepare(
    `UPDATE store_products SET available = 0, updated_at = ?
     WHERE store_id = ? AND updated_at < ?`),
  countProducts: db.prepare(
    'SELECT COUNT(*) AS n FROM store_products WHERE store_id = ? AND available = 1'),

  insertUser: db.prepare(
    'INSERT INTO market_users (id_number, name, phone, password_hash, pw_updated_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  userByIdNumber: db.prepare('SELECT * FROM market_users WHERE id_number = ?'),
  userById: db.prepare('SELECT * FROM market_users WHERE id = ?'),
  touchUser: db.prepare('UPDATE market_users SET last_seen_at = ? WHERE id = ?'),
  // v4.2: كلمات المرور
  setUserPassword: db.prepare(
    'UPDATE market_users SET password_hash = ?, pw_updated_at = ? WHERE id = ?'),
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
        delivery_fee_minor, items_total_minor, items_discount_minor, total_minor, created_at, updated_at)
     VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
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
       (order_id, product_id, product_ref, product_name, unit_price_minor, quantity, line_total_minor, variant)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  orderItems: db.prepare('SELECT * FROM market_order_items WHERE order_id = ?'),

  // v4.2: صور المنتجات (content-addressed داخل نطاق المتجر)
  imageByStoreHash: db.prepare(
    'SELECT * FROM store_images WHERE store_id = ? AND hash = ?'),
  insertImage: db.prepare(
    `INSERT OR IGNORE INTO store_images (store_id, hash, ext, bytes, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`),
  imageById: db.prepare('SELECT * FROM store_images WHERE id = ?'),
  clearProductImages: db.prepare('DELETE FROM store_product_images WHERE product_id = ?'),
  linkProductImage: db.prepare(
    `INSERT OR REPLACE INTO store_product_images (product_id, image_id, sort_order)
     VALUES (?, ?, ?)`),
  imagesOfProducts: db.prepare(
    `SELECT pi.product_id, i.store_id, i.hash, i.ext
     FROM store_product_images pi JOIN store_images i ON i.id = pi.image_id
     WHERE pi.product_id = ? ORDER BY pi.sort_order ASC, i.id ASC`),
  productByRef: db.prepare(
    'SELECT id FROM store_products WHERE store_id = ? AND product_ref = ?'),
  storeProductAnyById: db.prepare('SELECT * FROM store_products WHERE id = ?'),
  orphanImages: db.prepare(
    `SELECT id, store_id, hash, ext FROM store_images
     WHERE store_id = ? AND id NOT IN (SELECT image_id FROM store_product_images)`),
  deleteImageRow: db.prepare('DELETE FROM store_images WHERE id = ?'),

  /* v4.7: الإخفاء الإداري الدائم للمنتجات */
  hideProduct: db.prepare(
    `INSERT OR REPLACE INTO admin_hidden_products (product_id, admin_id, hidden_at) VALUES (?, ?, ?)`),
  unhideProduct: db.prepare('DELETE FROM admin_hidden_products WHERE product_id = ?'),
  isHiddenByAdmin: db.prepare(
    'SELECT product_id FROM admin_hidden_products WHERE product_id = ?'),
  reapplyAdminHides: db.prepare(
    `UPDATE store_products SET available = 0
     WHERE id IN (SELECT product_id FROM admin_hidden_products)`),
  adminHiddenIdsOfStore: db.prepare(
    `SELECT p.id AS id FROM store_products p
     JOIN admin_hidden_products h ON h.product_id = p.id
     WHERE p.store_id = ?`),

  publishedStores: db.prepare(
    `SELECT s.id, s.store_number, s.name, s.description, s.category, s.region, s.phone, s.whatsapp,
            s.logo_image_id
     FROM stores s JOIN keys k ON k.id = s.key_id
     WHERE s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
     ORDER BY s.updated_at DESC LIMIT 500`),
  storeProductsPage: db.prepare(
    `SELECT p.id, p.product_ref, p.name, p.category, p.price_minor, p.stock, p.barcode,
            p.sold_by_weight, p.unit_label, p.description, p.options, p.discount_pct, p.store_id
     FROM store_products p WHERE p.store_id = ? AND p.available = 1
     ORDER BY p.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`),
  storeProductsSearch: db.prepare(
    `SELECT p.id, p.product_ref, p.name, p.category, p.price_minor, p.stock, p.barcode,
            p.sold_by_weight, p.unit_label, p.description, p.options, p.discount_pct, p.store_id
     FROM store_products p WHERE p.store_id = ? AND p.available = 1
       AND p.name LIKE ? ESCAPE '\\'
     ORDER BY p.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`),
  /* v4.5: عروض المتجر — المخفّضة فقط مرتبة بالخصم الأكبر أولاً */
  storeProductsOffers: db.prepare(
    `SELECT p.id, p.product_ref, p.name, p.category, p.price_minor, p.stock, p.barcode,
            p.sold_by_weight, p.unit_label, p.description, p.options, p.discount_pct, p.store_id
     FROM store_products p
     WHERE p.store_id = ? AND p.available = 1 AND p.discount_pct > 0
     ORDER BY p.discount_pct DESC, p.updated_at DESC LIMIT ? OFFSET ?`),
  storeProductByIds: db.prepare(
    `SELECT * FROM store_products WHERE store_id = ? AND available = 1 AND id = ?`),
  crossProducts: db.prepare(
    `SELECT p.id, p.product_ref, p.name, p.category, p.price_minor, p.stock, p.barcode,
            p.sold_by_weight, p.unit_label, p.options, p.discount_pct, p.store_id, s.name AS store_name, s.store_number
     FROM store_products p
     JOIN stores s ON s.id = p.store_id
     JOIN keys k ON k.id = s.key_id
     WHERE p.available = 1 AND s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
     ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`),
  // v4.1: البحث العابر للمتاجر (q) + فلتر التصنيف (category) — استعلام
  // واحد مُعدّ مسبقاً: المعامل الفارغ يعطّل الفلتر (لا تضاعف للعبارات).
  crossProductsFiltered: db.prepare(
    `SELECT p.id, p.product_ref, p.name, p.category, p.price_minor, p.stock, p.barcode,
            p.sold_by_weight, p.unit_label, p.options, p.discount_pct, p.store_id, s.name AS store_name, s.store_number
     FROM store_products p
     JOIN stores s ON s.id = p.store_id
     JOIN keys k ON k.id = s.key_id
     WHERE p.available = 1 AND s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
       AND (? = '' OR p.name LIKE ? ESCAPE '\\')
       AND (? = '' OR p.category = ?)
     ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`),
  categories: db.prepare(
    `SELECT p.category AS category, COUNT(*) AS n FROM store_products p
     JOIN stores s ON s.id = p.store_id
     JOIN keys k ON k.id = s.key_id
     WHERE p.available = 1 AND p.category IS NOT NULL AND p.category != ''
       AND s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
     GROUP BY p.category ORDER BY n DESC LIMIT 100`),

  /* ── v4.4: متاجر تخدم منطقة محددة (مع رسم توصيلها لها) ──── */
  publishedStoresInRegion: db.prepare(
    `SELECT s.id, s.store_number, s.name, s.description, s.category, s.region, s.logo_image_id,
            s.phone, s.whatsapp, r.fee_minor AS region_fee_minor
     FROM stores s
     JOIN store_delivery_regions r ON r.store_id = s.id AND r.enabled = 1 AND r.name = ?
     JOIN keys k ON k.id = s.key_id
     WHERE s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
     ORDER BY r.fee_minor ASC, s.updated_at DESC LIMIT 500`),
  allDeliveryRegions: db.prepare(
    `SELECT DISTINCT r.name AS name FROM store_delivery_regions r
     JOIN stores s ON s.id = r.store_id
     JOIN keys k ON k.id = s.key_id
     WHERE r.enabled = 1 AND s.published = 1 AND k.revoked_at IS NULL
       AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?
     ORDER BY r.name ASC LIMIT 200`),

  /* ── v4.4: العناوين المحفوظة ─────────────────────────────── */
  addressesOfUser: db.prepare(
    'SELECT * FROM market_addresses WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC'),
  addressById: db.prepare('SELECT * FROM market_addresses WHERE id = ?'),
  insertAddress: db.prepare(
    `INSERT INTO market_addresses
       (user_id, label, region, city, street, building, floor, apartment, phone, notes, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateAddress: db.prepare(
    `UPDATE market_addresses SET label = ?, region = ?, city = ?, street = ?, building = ?,
       floor = ?, apartment = ?, phone = ?, notes = ?, is_default = ?, updated_at = ?
     WHERE id = ?`),
  clearDefaultAddress: db.prepare(
    'UPDATE market_addresses SET is_default = 0, updated_at = ? WHERE user_id = ?'),
  setDefaultAddress: db.prepare(
    'UPDATE market_addresses SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?'),
  deleteAddress: db.prepare(
    'DELETE FROM market_addresses WHERE id = ? AND user_id = ?'),

  /* ── v4.4: التقييمات ──────────────────────────────────────── */
  insertRating: db.prepare(
    `INSERT INTO market_ratings (order_id, user_id, store_id, stars, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`),
  ratingByOrder: db.prepare(
    'SELECT stars, comment, created_at FROM market_ratings WHERE order_id = ?'),
  ratingsOfStore: db.prepare(
    `SELECT r.stars, r.comment, r.created_at, u.name AS user_name
     FROM market_ratings r JOIN market_users u ON u.id = r.user_id
     WHERE r.store_id = ? ORDER BY r.created_at DESC LIMIT 50`),
  ratingStatsAll: db.prepare(
    `SELECT store_id, AVG(stars) AS avg_stars, COUNT(*) AS n
     FROM market_ratings GROUP BY store_id`),
  ratingStatsStore: db.prepare(
    `SELECT AVG(stars) AS avg_stars, COUNT(*) AS n FROM market_ratings WHERE store_id = ?`),
};

/* ── أدوات مساعدة ─────────────────────────────────────────────── */

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/* ── v4.3: خيارات المنتجات — [{name, values:[…]}] ──────────────
 * التطبيع والتحقق: حتى 4 مجموعات (مقاس/لون/حجم…)، اسم ≤24 محرفاً،
 * حتى 12 قيمة لكل مجموعة بقيمة ≤24 محرفاً — أي تجاوز يُقصّ بأمان. */
function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return null;
  const groups = [];
  for (const g of raw.slice(0, 4)) {
    if (g == null || typeof g !== 'object') continue;
    const name = String(g.name || '').trim().slice(0, 24);
    const values = (Array.isArray(g.values) ? g.values : [])
      .map(v => String(v || '').trim().slice(0, 24))
      .filter(v => v.length > 0)
      .slice(0, 12);
    if (name.length > 0 && values.length > 0) {
      groups.push({name, values});
    }
  }
  return groups.length > 0 ? JSON.stringify(groups) : null;
}

/** يفكّ JSON الخيارات المخزّن — null عند الغياب/الفساد. */
function parseOptions(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) && arr.length > 0 ? arr : null;
  } catch (_) {
    return null;
  }
}

/* ── v4.2: كلمات المرور (scrypt — مكتبة Node المدمجة، بلا اعتماديات) ──
 * سياسة: 8–72 محرفاً، حرف واحد على الأقل + رقم واحد على الأقل. */
const SCRYPT_OPTS = {N: 16384, r: 8, p: 1};

function passwordProblem(password) {
  if (typeof password !== 'string') return 'BAD_PASSWORD';
  if (password.length < 8 || password.length > 72) return 'BAD_PASSWORD';
  if (!/[0-9]/.test(password) || !/[^\d]/.test(password)) return 'BAD_PASSWORD';
  return null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_OPTS).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const check = crypto.scryptSync(String(password), parts[1], 32, SCRYPT_OPTS);
  const expected = Buffer.from(parts[2], 'hex');
  return expected.length === check.length &&
    crypto.timingSafeEqual(expected, check);
}

/* قفل محاولات الدخول الفاشلة: 10 محاولات / 15 دقيقة لكل حساب.
 * في الذاكرة (نسخة واحدة) — عداد وقفل بلا ثبات مقبولان تماماً هنا. */
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // id_number → {count, lockedUntil}
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of loginFails) {
    if (rec.lockedUntil < now && now - (rec.lastAt || 0) > LOGIN_LOCK_MS) {
      loginFails.delete(id);
    }
  }
}, 60 * 1000).unref();

function loginLocked(idNumber) {
  const rec = loginFails.get(idNumber);
  return rec != null && rec.lockedUntil > Date.now();
}

function recordLoginFail(idNumber) {
  const rec = loginFails.get(idNumber) || {count: 0, lockedUntil: 0, lastAt: 0};
  rec.count += 1;
  rec.lastAt = Date.now();
  if (rec.count >= LOGIN_FAIL_LIMIT) {
    rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(idNumber, rec);
}

function clearLoginFails(idNumber) {
  loginFails.delete(idNumber);
}

/* ── v5.0: رموز استعادة كلمة المرور ──────────────────────────
 * تعمية الرمز بنفس بنية كلمات المرور (scrypt$salt$hash) لكن
 * بتكلفة أخف (N=4096) — الرمز عمره 10 دقائق فلا يستحق تكلفة
 * 16384، ويظل مقاوماً للتفكير الشامل عند تسريب القاعدة. */
const RESET_CODE_TTL_MS = 10 * 60 * 1000;   // صلاحية الرمز
const RESET_MAX_ATTEMPTS = 5;               // محاولات تحقق لكل رمز
const RESET_CODES_PER_HOUR = 3;             // رموز لكل حساب/ساعة
const SCRYPT_LIGHT = {N: 4096, r: 8, p: 1};

function hashResetCode(code) {
  const salt = crypto.randomBytes(12).toString('hex');
  const hash = crypto.scryptSync(String(code), salt, 24, SCRYPT_LIGHT).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyResetCode(code, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  try {
    const check = crypto.scryptSync(String(code), parts[1], 24, SCRYPT_LIGHT);
    const expected = Buffer.from(parts[2], 'hex');
    return expected.length === check.length &&
      crypto.timingSafeEqual(expected, check);
  } catch {
    return false;
  }
}

/** محدد المعدل: user_id → أوقات طلب الرموز (ذاكرة فقط). */
const resetCodeTimes = new Map(); // userId → [ts, ...]
setInterval(() => {
  const cutoff = Date.now() - 3600 * 1000;
  for (const [uid, list] of resetCodeTimes) {
    const kept = list.filter(t => t > cutoff);
    if (kept.length === 0) {
      resetCodeTimes.delete(uid);
    } else {
      resetCodeTimes.set(uid, kept);
    }
  }
}, 10 * 60 * 1000).unref();

function resetCodeRateExceeded(userId) {
  const cutoff = Date.now() - 3600 * 1000;
  const list = (resetCodeTimes.get(userId) || []).filter(t => t > cutoff);
  return list.length >= RESET_CODES_PER_HOUR;
}

function recordResetCodeRequest(userId) {
  const list = resetCodeTimes.get(userId) || [];
  list.push(Date.now());
  resetCodeTimes.set(userId, list);
}

/** إعدادات SMS الحالية (قراءة موحدة من settings). */
function smsSettings() {
  const keys = [
    'sms_provider', 'sms_username', 'sms_password', 'sms_sender',
    'sms_app_sid', 'sms_account_sid', 'sms_auth_token',
    'sms_generic_url', 'sms_generic_method', 'sms_generic_body',
  ];
  const out = {};
  for (const k of keys) out[k] = getSetting(k, '');
  return out;
}

/** هل مزود SMS جاهز للعمل الآن؟ */
function smsReady() {
  const s = smsSettings();
  return smsConfigComplete(s.sms_provider, s);
}

/* ── v4.2: مساعدات الصور ────────────────────────────────────── */

/** رابط عام لصورة (نسبي — التطبيق يضيف عنوان الخادم). */
function imageUrl(row) {
  return `/api/market/img/${row.store_id}/${row.hash}.${row.ext}`;
}

/* ── v4.5: JSON مُدمج للمنتجات ──────────────────────────────────
 *  سبب الجذري لاختفاء المنتجات من التطبيق على شبكات الجوال: كل
 *  الحمولات التي كانت تعمل <~430B (متاجر 284B، تفاصيل متجر ~430B)
 *  بينما قوائم المنتجات ~2KB — إطارات TCP متعددة تنكسر على مسلك
 *  الشبكة. الحل: حذف كل حقل فارغ (null/0/[]) فتنزل القائمة تحت
 *  حد الإطار الواحد، مع سقف per=1 على الخادم يسمح للتطبيق بتفكيك
 *  الطلب لصفحات صغيرة عند التعثر (سلم 12→6→3→1). */
function finalMinor(product) {
  const pct = Number(product.discount_pct) || 0;
  if (pct <= 0) return product.price_minor;
  return Math.max(0, Math.round(product.price_minor * (1 - pct / 100)));
}

/** يحوّل صف منتج إلى كائن JSON مُدمج — الحقول الفارغة تُحذف تماماً
 *  (التطبيق يقرأها بـ ?. و?? فالغياب = القيمة المحايدة نفسها). */
function productJson(row, opts) {
  const cross = opts != null && opts.cross === true;
  const out = {
    id: row.id,
    name: row.name,
    price_minor: row.price_minor,
    stock: row.stock,
    store_id: row.store_id,
  };
  if (row.sold_by_weight) out.sold_by_weight = 1;
  if (row.category) out.category = row.category;
  if (row.barcode) out.barcode = row.barcode;
  if (row.unit_label) out.unit_label = row.unit_label;
  if (row.description) out.description = row.description;
  if (row.product_ref) out.product_ref = row.product_ref;
  const options = parseOptions(row.options);
  if (options) out.options = options;
  const pct = Number(row.discount_pct) || 0;
  if (pct > 0) {
    out.discount_pct = pct;
    out.final_minor = finalMinor(row);
  }
  const images = m.imagesOfProducts.all(row.id).map(imageUrl);
  if (images.length > 0) out.images = images;
  if (cross) {
    out.store_name = row.store_name;
    out.store_number = row.store_number;
  }
  return out;
}

/** v4.5: رابط شعار المتجر العمومي أو null. */
function storeLogoUrl(store) {
  if (store.logo_image_id == null) return null;
  const img = m.imageById.get(store.logo_image_id);
  if (img == null || img.store_id !== store.id) return null;
  return imageUrl(img);
}

/** فحص البصمة السحرية للصورة المستقبلة + حد الحجم. */
const IMAGE_MAX_BYTES = 1024 * 1024; // 1MB لكل صورة مضغوطة (WebP ~30–120KB)
function decodeUpload(up) {
  if (up == null || typeof up !== 'object') return null;
  const hash = String(up.hash || '').toLowerCase();
  const ext = String(up.ext || 'webp').toLowerCase();
  const data = String(up.data || '');
  if (!/^[a-f0-9]{16,64}$/.test(hash)) return null;
  if (!['webp', 'jpg'].includes(ext)) return null;
  const buf = Buffer.from(data, 'base64');
  if (buf.length < 64 || buf.length > IMAGE_MAX_BYTES) return null;
  const isWebp = buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49 &&
    buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'webp' ? !isWebp : !isJpg) return null;
  // الهاش المعروف يجب أن يطابق المحتوى فعلاً (integrity)
  if (crypto.createHash('sha256').update(buf).digest('hex').slice(0, hash.length) !== hash) {
    return null;
  }
  return {hash, ext, buf, width: Math.round(Number(up.width)) || null,
    height: Math.round(Number(up.height)) || null};
}

/** v4.5: مثل decodeUpload لكن يُحسب الهاش على الخادم — لشعار
 *  المتجر الذي يرفعه POS بلا مكتبة تشفير على الجهاز. */
function decodeUploadServerHash(up) {
  if (up == null || typeof up !== 'object') return null;
  const ext = String(up.ext || 'webp').toLowerCase();
  const data = String(up.data || '');
  if (!['webp', 'jpg'].includes(ext)) return null;
  const buf = Buffer.from(data, 'base64');
  if (buf.length < 64 || buf.length > IMAGE_MAX_BYTES) return null;
  const isWebp = buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49 &&
    buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'webp' ? !isWebp : !isJpg) return null;
  return {
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    ext, buf,
    width: Math.round(Number(up.width)) || null,
    height: Math.round(Number(up.height)) || null,
  };
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

    /* v4.5: شعار المتجر — يُرفع هنا (يُحسب الهاش على الخادم).
     *  logo: {data, ext, width, height} → تخزين content-addressed
     *  وربطه بعمود stores.logo_image_id. logo: null → إزالة الشعار.
     *  غياب الحقل تماماً → لا تغيير (idempotent). */
    let logoUrl = null;
    if (req.body && 'logo' in (req.body || {})) {
      const logo = req.body.logo;
      if (logo == null) {
        db.prepare('UPDATE stores SET logo_image_id = NULL, updated_at = ? WHERE id = ?')
          .run(now, storeId);
      } else {
        const decoded = decodeUploadServerHash(logo);
        if (decoded != null) {
          const storeDir = path.join(IMAGES_DIR, String(storeId));
          fs.mkdirSync(storeDir, {recursive: true});
          let imageId;
          const existing = m.imageByStoreHash.get(storeId, decoded.hash);
          if (existing != null) {
            imageId = existing.id; // dedupe — نفس الشعار بلا إعادة تخزين
          } else {
            const file = path.join(storeDir, `${decoded.hash}.${decoded.ext}`);
            fs.writeFileSync(file, decoded.buf);
            m.insertImage.run(
              storeId, decoded.hash, decoded.ext, decoded.buf.length,
              decoded.width, decoded.height, now);
            // INSERT OR IGNORE: بعد الإدراج نقرأ الصف عبر الهاش — لا
            // last_insert_rowid (قد يعيد صفقاً قديماً لو تجاهل الإدراج).
            const row = m.imageByStoreHash.get(storeId, decoded.hash);
            if (row == null) {
              return res.status(500).json({ok: false, error: 'LOGO_STORE_FAILED'});
            }
            imageId = row.id;
          }
          db.prepare('UPDATE stores SET logo_image_id = ?, updated_at = ? WHERE id = ?')
            .run(imageId, now, storeId);
          logoUrl = imageUrl(m.imageById.get(imageId));
        } else {
          return res.status(400).json({ok: false, error: 'BAD_LOGO'});
        }
      }
    }

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
        logoUrl,
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
        // v4.5: خصم المنتج — نسبة مئوية 0–95 تُحسب عند البيع وفي المتجر
        const discountPct = Math.max(0, Math.min(95, Number(p.discountPct) || 0));
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
          normalizeOptions(p.options),
          discountPct,
          now,
        );
        saved += 1;
      }
      // المنتجات الغائبة عن هذه المزامنة → غير متاحة (لا حذف أبداً)
      m.markMissingUnavailable.run(now, auth.store.id, now);
      // v4.7: قرارات إخفاء الإدارة تعود للتطبيق بعد كل مزامنة —
      // الكتالوج يعود available=1 من upsert ثم تُطرد المنتجات
      // المخفية إدارياً من العرض مجدداً داخل نفس المعاملة.
      m.reapplyAdminHides.run();
    })();
    res.json({
      ok: true,
      saved,
      published: auth.store.published === 1,
      serverTime: now,
    });
  });

  /* ── images/sync: صور المنتجات (v4.2، موسّعة v4.5) ────────────
   * منفصلة عن مزامنة الكتالوج كي تبقى الأخيرة خفيفة سريعة.
   * POS يضغط الصور إلى WebP (~800px، ~40–120KB) قبل الإرسال،
   * والخادم يخزنها موجّهةً بالمحتوى (sha256) فيملك:
   *   • إرسال الهاش فقط للصور غير المتغيرة (بلا رفع متكرر)؛
   *   • كاش HTTP دائم لأن الرابط يحمل الهاش (immutable).
   * الطلب: images: [{ref, items: [{hash, slot}]}], uploads: [{hash, ext, data, width, height}]
   * كل منتج يستبدل روابطه بالكامل بالقائمة المرسلة (idempotent).
   * v4.5: item قد يكون رفعاً مضمّناً {data, ext, width, height, slot}
   * بدل {hash, slot} — يُخزَّن ويُربط بنداء واحد بلا مكتبة تشفير
   * على جهاز التاجر (الهاش يُحسب هنا). */
  router.post('/images/sync', (req, res) => {
    const auth = authenticate(req.body, res);
    if (!auth) return;
    if (!requireStore(auth, res)) return;
    const {images, uploads} = req.body || {};
    if (!Array.isArray(images) || images.length > 2000 ||
        (uploads != null && !Array.isArray(uploads)) || (uploads || []).length > 150) {
      return res.status(400).json({ok: false, error: 'BAD_IMAGES'});
    }
    const now = auth.now;
    const storeDir = path.join(IMAGES_DIR, String(auth.store.id));
    fs.mkdirSync(storeDir, {recursive: true});

    /** v4.5: تخزين بايتات صورة موجّهة بالمحتوى — يعيد الصف
     *  (dedupe عبر imageByStoreHash). null عند فشل الكتابة. */
    function storeBytes(decoded) {
      const existing = m.imageByStoreHash.get(auth.store.id, decoded.hash);
      if (existing != null) {
        return existing;
      }
      const file = path.join(storeDir, `${decoded.hash}.${decoded.ext}`);
      try {
        fs.writeFileSync(file, decoded.buf);
      } catch (err) {
        return null;
      }
      m.insertImage.run(
        auth.store.id, decoded.hash, decoded.ext, decoded.buf.length,
        decoded.width, decoded.height, now);
      return m.imageByStoreHash.get(auth.store.id, decoded.hash);
    }

    // 1) تخزين الرفعات المنفصلة (تجاوز للصور الموجودة مسبقاً بنفس الهاش)
    let stored = 0;
    for (const up of uploads || []) {
      const decoded = decodeUpload(up);
      if (decoded == null) {
        return res.status(400).json({ok: false, error: 'BAD_IMAGE_DATA'});
      }
      const known = m.imageByStoreHash.get(auth.store.id, decoded.hash);
      if (known != null) {
        continue; // dedupe — لا إعادة تخزين ولا يُحسب stored
      }
      const row = storeBytes(decoded);
      if (row == null) {
        return res.status(500).json({ok: false, error: 'IMAGE_STORE_FAILED'});
      }
      stored += 1;
    }

    // 2) ربط روابط الصور بكل منتج (استبدال كامل — idempotent)
    let linked = 0;
    let missing = 0;
    let inline = 0;
    db.transaction(() => {
      for (const entry of images) {
        if (entry == null || typeof entry.ref !== 'string') continue;
        const product = m.productByRef.get(auth.store.id, String(entry.ref).slice(0, 40));
        if (product == null) {
          missing += 1;
          continue;
        }
        m.clearProductImages.run(product.id);
        const items = (Array.isArray(entry.items) ? entry.items : [])
          .filter(it => it != null && typeof it === 'object')
          .slice(0, 8);
        items.forEach((it, index) => {
          const slot = Math.max(0, Math.round(Number(it.slot) || index));
          let img = null;
          if (typeof it.hash === 'string' && /^[a-f0-9]{16,64}$/i.test(it.hash)) {
            img = m.imageByStoreHash.get(auth.store.id, String(it.hash).toLowerCase());
          } else if (typeof it.data === 'string') {
            // v4.5: رفع مضمّن — الهاش هنا على الخادم
            const decoded = decodeUploadServerHash(it);
            if (decoded != null) {
              img = storeBytes(decoded);
              if (img != null) inline += 1;
            }
          }
          if (img != null) {
            m.linkProductImage.run(product.id, img.id, slot);
          }
        });
        linked += 1;
      }
    })();

    // 3) كنس الصور اليتيمة (بلا أي منتج يشير إليها) — صفوف وملفات
    // v4.5: شعار المتجر الحالي محمي من الكنس (لا يشير إليه منتج).
    let cleaned = 0;
    try {
      const logoImageId = m.storeById.get(auth.store.id)?.logo_image_id ?? null;
      const orphans = m.orphanImages.all(auth.store.id)
        .filter(o => o.id !== logoImageId);
      db.transaction(() => {
        for (const orphan of orphans) {
          m.deleteImageRow.run(orphan.id);
          try {
            fs.unlinkSync(path.join(storeDir, `${orphan.hash}.${orphan.ext}`));
          } catch (_) { /* الملف قد يكون محذوفاً أصلاً */ }
          cleaned += 1;
        }
      })();
    } catch (_) { /* الكنس أفضل جهد — لا يفشل النداء بسببه */ }

    res.json({ok: true, stored, linked, missing, inline, cleaned, serverTime: now});
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

  /* v4.4→v4.7: منع أي وسيط شبكة من «تحويل» الردود (ضغط gzip عبر بوابة
   * النشر أو بروكسيات مزودي الجوال على HTTP الصريح) + منع التخزين
   * وإعادة التحقق نهائياً (no-store) — مع ETag معطّل على مستوى
   * التطبيق لا يمكن أن يولّد هذا المسار 304 بعد اليوم.
   * التطبيق يطلب identity أيضاً — هذا الحزام الاحتياطي الثاني. */
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-transform');
    next();
  });

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

  /** v4.4: متوسط التقييم وعدده لكل متجر (استعلام واحد لكل نداء قائمة). */
  function ratingStatsMap() {
    const map = new Map();
    for (const row of m.ratingStatsAll.all()) {
      map.set(row.store_id, {
        rating: Math.round(row.avg_stars * 10) / 10,
        ratingCount: row.n,
      });
    }
    return map;
  }

  router.get('/stores', (req, res) => {
    const now = Date.now();
    const ratings = ratingStatsMap();
    // v4.4: ?region=غزة — متاجر تخدم المنطقة مرتبة برسم التوصيل لها
    // تصاعدياً (أرخص توصيل أولاً) مع رسم كل متجر لتلك المنطقة — أساس
    // قسم «متاجر تخدم منطقتك» ومقارنة رسوم التوصيل في التطبيق.
    const region = String(req.query.region || '').trim();
    if (region.length > 0) {
      const rows = m.publishedStoresInRegion.all(region, now).map(s => ({
        id: s.id,
        store_number: s.store_number,
        name: s.name,
        description: s.description,
        category: s.category,
        region: s.region,
        phone: s.phone,
        whatsapp: s.whatsapp,
        deliveryFeeMinor: s.region_fee_minor,
        logo_url: storeLogoUrl(s),
        ...(ratings.get(s.id) ?? {rating: null, ratingCount: 0}),
      }));
      rows.forEach(r => { if (r.logo_url == null) delete r.logo_url; });
      return res.json({ok: true, stores: rows});
    }
    const rows = m.publishedStores.all(now).map(s => {
      const out = {
        ...s,
        ...(ratings.get(s.id) ?? {rating: null, ratingCount: 0}),
      };
      const logo = storeLogoUrl(s);
      if (logo != null) out.logo_url = logo;
      return out;
    });
    res.json({ok: true, stores: rows});
  });

  /* v4.4: كل مناطق التوصيل المتاحة عبر المول — تغذي مسجل العنوان في
   * التطبيق (اختيار المنطقة من قائمة حقيقية لا كتابة حرة). */
  router.get('/regions', (_req, res) => {
    const now = Date.now();
    res.json({ok: true, regions: m.allDeliveryRegions.all(now).map(r => r.name)});
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
        ...(storeLogoUrl(store) != null ? {logo_url: storeLogoUrl(store)} : {}),
        rating: (() => {
          const r = m.ratingStatsStore.get(store.id);
          return r != null && r.n > 0 ? Math.round(r.avg_stars * 10) / 10 : null;
        })(),
        ratingCount: (() => {
          const r = m.ratingStatsStore.get(store.id);
          return r != null ? r.n : 0;
        })(),
      },
      deliveryRegions: m.listRegions.all(store.id).filter(r => r.enabled === 1),
    });
  });

  /* v4.4: تقييمات متجر — أحدث 50 تعليقاً مع الاسم الأول وحرف الأب
   * فقط (خصوصية المستخدم: «محمد ع.» لا الاسم الكامل ولا الهاتف). */
  router.get('/stores/:id/ratings', (req, res) => {
    const store = storePublic(Number(req.params.id));
    if (!store) return res.status(404).json({ok: false, error: 'STORE_NOT_FOUND'});
    const stats = m.ratingStatsStore.get(store.id);
    res.json({
      ok: true,
      rating: stats != null && stats.n > 0 ? Math.round(stats.avg_stars * 10) / 10 : null,
      ratingCount: stats != null ? stats.n : 0,
      reviews: m.ratingsOfStore.all(store.id).map(r => ({
        stars: r.stars,
        comment: r.comment,
        createdAt: r.created_at,
        userName: String(r.user_name || '').trim().split(/\s+/).slice(0, 2)
          .map((w, i) => (i === 0 ? w : `${w.charAt(0)}.`)).join(' ') || 'مستخدم سيلا',
      })),
    });
  });

  router.get('/stores/:id/products', (req, res) => {
    const store = storePublic(Number(req.params.id));
    if (!store) return res.status(404).json({ok: false, error: 'STORE_NOT_FOUND'});
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    // v4.5: الحد الأدنى 1 (كان 10) — يسمح للتطبيق بتفكيك الطلب
    // لصفحات صغيرة جداً عند تعثر الشبكة (سلم 12→6→3→1).
    const per = Math.min(100, Math.max(1, Number(req.query.per) || 50));
    const offers = req.query.offers === '1' || req.query.offers === 'true';
    const like = q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    let rows;
    if (offers) {
      rows = m.storeProductsOffers.all(store.id, per, (page - 1) * per);
    } else if (q) {
      rows = m.storeProductsSearch.all(store.id, like, per, (page - 1) * per);
    } else {
      rows = m.storeProductsPage.all(store.id, per, (page - 1) * per);
    }
    // v4.5: JSON مُدمج — الحقول الفارغة تُحذف (نصف حجم الرد تقريباً)
    res.json({ok: true, products: rows.map(r => productJson(r)), page});
  });

  router.get('/products', (req, res) => {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const page = Math.max(1, Math.min(1000, Number(req.query.page) || 1));
    const per = Math.min(100, Math.max(1, Number(req.query.per) || 50));
    // v4.1: بحث عابر للمتاجر + فلتر تصنيف — نفس الاستعلام المُعدّ مسبقاً
    // بتركيبة «معامل فارغ = بلا فلتر» حتى لا تتضاعف العبارات.
    const like = q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    const rows = m.crossProductsFiltered.all(
      Date.now(), q, like, category, category, per, (page - 1) * per);
    res.json({ok: true, products: rows.map(r => productJson(r, {cross: true})), page});
  });

  router.get('/categories', (_req, res) => {
    res.json({ok: true, categories: m.categories.all(Date.now())});
  });

  /* ── تقديم صور المنتجات — موجّهة بالمحتوى ⇒ كاش دائم ────────
   * /api/market/img/<store_id>/<sha256>.<ext> — الرابط نفسه يتغير
   * متى تغيرت الصورة، لذا cache-control: immutable لسنة كاملة. */
  router.get('/img/:storeId/:name', (req, res) => {
    const match = /^([a-f0-9]{16,64})\.(webp|jpg)$/.exec(String(req.params.name || ''));
    if (!match) {
      return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    }
    const storeId = Number(req.params.storeId);
    const row = m.imageByStoreHash.get(storeId, match[1]);
    if (row == null) {
      return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    }
    // الصورة تُقدَّم لمتجر منشور فقط (نفس عزل باقي الواجهات العامة)
    const store = m.storeById.get(storeId);
    if (store == null || store.published !== 1) {
      return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    }
    const file = path.join(IMAGES_DIR, String(storeId), `${match[1]}.${match[2]}`);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', match[2] === 'webp' ? 'image/webp' : 'image/jpeg');
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(file).pipe(res);
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
    const {idNumber, name, phone, password} = req.body || {};
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
    // v4.2: كلمة المرور إلزامية — لا حساب بلا حماية.
    const pwProblem = passwordProblem(password);
    if (pwProblem != null) {
      return res.status(400).json({ok: false, error: pwProblem});
    }
    if (m.userByIdNumber.get(id) != null) {
      return res.status(409).json({ok: false, error: 'ID_ALREADY_REGISTERED'});
    }
    const now = Date.now();
    const info = m.insertUser.run(
      id, cleanName, cleanPhone, hashPassword(password), now, now, now);
    const user = m.userById.get(Number(info.lastInsertRowid));
    res.json({ok: true, token: issueToken(user), user: {name: user.name, idNumber: user.id_number}});
  });

  /* ── login (v4.2): رقم الهوية + كلمة المرور ──────────────────
   * مسار ترحيل واحد للحسابات المُنشأة قبل كلمات المرور: إن أرسل
   * العميل الهاتف والحساب بلا كلمة مرور بعد → جلسة صالحة مع
   * mustSetPassword:true فيفرض التطبيق شاشة تعيينها فوراً.
   * الحسابات ذات كلمة مرور ترفض الدخول بالهاتف (PASSWORD_REQUIRED). */
  router.post('/auth/login', (req, res) => {
    const {idNumber, password, phone} = req.body || {};
    const id = String(idNumber || '').replace(/\s+/g, '');
    if (loginLocked(id)) {
      return res.status(429).json({ok: false, error: 'ACCOUNT_LOCKED'});
    }
    const user = m.userByIdNumber.get(id);
    if (user == null || user.disabled) {
      recordLoginFail(id);
      return res.status(403).json({ok: false, error: 'BAD_CREDENTIALS'});
    }
    // ترحيل: حساب قديم بلا كلمة مرور + هاتف مطابق → جلسة مؤقتة
    if (user.password_hash == null) {
      if (String(user.phone) !== String(phone || '').replace(/[\s-]/g, '')) {
        recordLoginFail(id);
        return res.status(403).json({ok: false, error: 'BAD_CREDENTIALS'});
      }
      clearLoginFails(id);
      return res.json({
        ok: true,
        token: issueToken(user),
        user: {name: user.name, idNumber: user.id_number},
        mustSetPassword: true,
      });
    }
    // المسار القياسي: كلمة مرور (الدخول بالهاتف مرفوض صراحة
    // للحسابات المحمية — يعرض التطبيق حقل كلمة المرور عندئذٍ)
    if (typeof password !== 'string' || password.length === 0) {
      if (typeof phone === 'string' && phone.length > 0) {
        return res.status(400).json({ok: false, error: 'PASSWORD_REQUIRED'});
      }
      recordLoginFail(id);
      return res.status(403).json({ok: false, error: 'BAD_CREDENTIALS'});
    }
    if (!verifyPassword(password, user.password_hash)) {
      recordLoginFail(id);
      return res.status(403).json({ok: false, error: 'BAD_CREDENTIALS'});
    }
    clearLoginFails(id);
    res.json({ok: true, token: issueToken(user), user: {name: user.name, idNumber: user.id_number}});
  });

  /* ── set-password (بالجلسة): تعيين بعد الترحيل أو تغيير بكلمة الحالية. */
  router.post('/auth/set-password', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const {password, currentPassword} = req.body || {};
    const pwProblem = passwordProblem(password);
    if (pwProblem != null) {
      return res.status(400).json({ok: false, error: pwProblem});
    }
    // التغيير على حساب له كلمة مرور يتطلب الكلمة الحالية.
    if (user.password_hash != null &&
        (typeof currentPassword !== 'string' ||
         !verifyPassword(currentPassword, user.password_hash))) {
      return res.status(403).json({ok: false, error: 'BAD_CURRENT_PASSWORD'});
    }
    const now = Date.now();
    m.setUserPassword.run(hashPassword(password), now, user.id);
    audit('market_password_set', {ip: req.ip, details: {userId: user.id}});
    res.json({ok: true});
  });

  /* ── v5.0: config عام — يقرأ منه التطبيق حالة «نسيت كلمة المرور»
   * ورقم تواصل الإدارة. الخيار الخفي (market_forgot_enabled=0)
   * يحوّل زر «نسيت كلمة المرور؟» في التطبيق إلى «تواصل مع الإدارة»
   * — استعادة الحسابات تصبح من اللوحة فقط بقرار المالك. */
  router.get('/config', (_req, res) => {
    const forgotEnabled = getSetting('market_forgot_enabled', '0') === '1' && smsReady();
    res.json({
      ok: true,
      forgotPassword: forgotEnabled,
      contactPhone: getSetting('market_contact_phone', '') || null,
    });
  });

  /* ── v5.0: نسيت كلمة المرور — خطوة 1: طلب رمز SMS ───────────
   * الاستعادة القديمة (هوية + هاتف ⇒ تغيير فوري) كانت ثغرة تتيح
   * سرقة أي حساب بمعرفة رقمي هويته وجواله. المسار الجديد:
   *  • مفعّل من اللوحة فقط (market_forgot_enabled=1) ومزود SMS
   *    مكتمل — وإلا فالزر أصلاً لا يظهر في التطبيق (config أعلاه).
   *  • الرمز يصل للجوال المسجل في الحساب نفسه فقط.
   *  • قفل محاولات الدخول + 3 رموز/ساعة/حساب.
   *  • الرمز مخزن معمّى بصلاحية 10 دقائق. */
  router.post('/auth/forgot/request', (req, res) => {
    const {idNumber, phone} = req.body || {};
    const id = String(idNumber || '').replace(/\s+/g, '');
    if (getSetting('market_forgot_enabled', '0') !== '1') {
      return res.status(403).json({ok: false, error: 'FORGOT_DISABLED'});
    }
    if (!smsReady()) {
      return res.status(503).json({ok: false, error: 'SMS_NOT_CONFIGURED'});
    }
    if (loginLocked(id)) {
      return res.status(429).json({ok: false, error: 'ACCOUNT_LOCKED'});
    }
    const user = m.userByIdNumber.get(id);
    if (user == null || user.disabled ||
        String(user.phone) !== String(phone || '').replace(/[\s-]/g, '')) {
      recordLoginFail(id);
      return res.status(403).json({ok: false, error: 'BAD_CREDENTIALS'});
    }
    if (resetCodeRateExceeded(user.id)) {
      return res.status(429).json({ok: false, error: 'TOO_MANY_CODES'});
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const now = Date.now();
    const message =
      'سيلا ماركت — رمز استعادة كلمة المرور: ' + code +
      ' (صالح 10 دقائق). لا تشاركه مع أحد.';
    const provider = getSetting('sms_provider', '');
    const s = smsSettings();
    // إرسال متزامن مقصود: نجاح الطلب = رسالة انطلقت فعلاً.
    // eslint-disable-next-line no-undef
    sendSms(provider, s, user.phone, message).then((result) => {
      if (!result.ok) {
        audit('market_forgot_sms_failed', {
          ip: req.ip, details: {userId: user.id, provider, detail: result.detail},
        });
        res.status(502).json({ok: false, error: 'SMS_SEND_FAILED'});
        return;
      }
      db.prepare(
        'INSERT INTO market_reset_codes (user_id, code_hash, attempts, created_at, expires_at) VALUES (?, ?, 0, ?, ?)',
      ).run(user.id, hashResetCode(code), now, now + RESET_CODE_TTL_MS);
      recordResetCodeRequest(user.id);
      clearLoginFails(id);
      audit('market_forgot_code_sent', {ip: req.ip, details: {userId: user.id}});
      res.json({ok: true, expiresInSeconds: RESET_CODE_TTL_MS / 1000});
    });
  });

  /* ── v5.0: نسيت كلمة المرور — خطوة 2: الرمز + الكلمة الجديدة.
   * عند النجاح: تعيين الكلمة، إبطال كل الجلسات ومسح الرموز —
   * لا جلسة تلقائية في الرد (المستخدم يسجل الدخول بكلمته الجديدة:
   * خطوة تحقق فعلية ثانية لا يمكن الاكتفاء بسرقة رمز واحد). */
  router.post('/auth/forgot/verify', (req, res) => {
    const {idNumber, phone, code, newPassword} = req.body || {};
    const id = String(idNumber || '').replace(/\s+/g, '');
    const pwProblem = passwordProblem(newPassword);
    if (pwProblem != null) {
      return res.status(400).json({ok: false, error: pwProblem});
    }
    if (loginLocked(id)) {
      return res.status(429).json({ok: false, error: 'ACCOUNT_LOCKED'});
    }
    const user = m.userByIdNumber.get(id);
    if (user == null || user.disabled ||
        String(user.phone) !== String(phone || '').replace(/[\s-]/g, '')) {
      recordLoginFail(id);
      return res.status(403).json({ok: false, error: 'BAD_CREDENTIALS'});
    }
    if (!/^\d{6}$/.test(String(code || ''))) {
      return res.status(400).json({ok: false, error: 'BAD_CODE'});
    }
    const row = db.prepare(
      'SELECT * FROM market_reset_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    ).get(user.id);
    if (row == null || row.expires_at < Date.now() || row.attempts >= RESET_MAX_ATTEMPTS) {
      return res.status(403).json({ok: false, error: 'BAD_CODE'});
    }
    if (!verifyResetCode(String(code), row.code_hash)) {
      db.prepare('UPDATE market_reset_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      recordLoginFail(id);
      return res.status(403).json({ok: false, error: 'BAD_CODE'});
    }
    const now = Date.now();
    db.transaction(() => {
      m.setUserPassword.run(hashPassword(newPassword), now, user.id);
      m.deleteTokensOfUser.run(user.id);
      db.prepare('DELETE FROM market_reset_codes WHERE user_id = ?').run(user.id);
    })();
    clearLoginFails(id);
    audit('market_forgot_verified', {ip: req.ip, details: {userId: user.id}});
    res.json({ok: true});
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
    // v4.5: خصم المنتج يُطبَّق هنا — unit_price المسجّل هو السعر المدفوع
    // فعلاً بعد الخصم، وitems_discount_minor يلخص وفورات المشتري.
    let itemsTotal = 0;
    let itemsDiscount = 0;
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
      // v4.3: لقطة الخيار المختار (مقاس/لون…) — نص عرض فقط ≤120 محرفاً؛
      // الأسعار تبقى من الكتالوج مهما أُرسل. لا يُشترط لإبقاء توافق
      // الإصدارات الأقدم من التطبيق.
      const variant = String(it?.variant || '').trim().slice(0, 120) || null;
      const unit = finalMinor(product);
      const lineTotal = Math.round(unit * quantity);
      const lineList = Math.round(product.price_minor * quantity);
      const lineDiscount = Math.max(0, lineList - lineTotal);
      itemsTotal += lineTotal;
      itemsDiscount += lineDiscount;
      lines.push({product, unit, quantity, lineTotal, variant});
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
            deliveryFee, itemsTotal, itemsDiscount, total, now, now,
          );
          const orderId = Number(info.lastInsertRowid);
          for (const l of lines) {
            m.insertOrderItem.run(
              orderId, l.product.id, l.product.product_ref, l.product.name,
              l.unit, l.quantity, l.lineTotal, l.variant,
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
    // v4.3: الطلب يُعاد كاملاً بأسطره (مع لقطة الخيار المختار) —
    // التطبيق يعرض تفاصيل الطلب فور نجاح الشراء دون نداء إضافي.
    res.json({ok: true, order: {...order, items: m.orderItems.all(order.id)}});
  });

  router.get('/orders', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const orders = m.ordersForUser.all(user.id).map(o => ({
      ...o,
      items: m.orderItems.all(o.id),
      // v4.4: تقييم الطلب إن وُجد — يعرض التطبيق زر «قيّم» للطلبات
      // المسلّمة غير المقيّمة ونجوم التقييم للمقيّمة.
      rating: (() => {
        const r = m.ratingByOrder.get(o.id);
        return r == null ? null : {stars: r.stars, comment: r.comment};
      })(),
      store: (() => {
        const s = m.storeById.get(o.store_id);
        if (s == null) return null;
        const logo = storeLogoUrl(s);
        return logo != null
          ? {id: s.id, name: s.name, storeNumber: s.store_number, logo_url: logo}
          : {id: s.id, name: s.name, storeNumber: s.store_number};
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

  /* ── v4.4: تقييم الطلب بعد الاستلام ────────────────────────
   * مالك الطلب فقط + حالة delivered فقط + تقييم واحد لكل طلب.
   * يغذي متوسط تقييم المتجر الذي يظهر لكل مستخدمي المول. */
  router.post('/orders/:id/rate', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const order = m.orderById.get(Number(req.params.id));
    if (order == null || order.user_id !== user.id) {
      return res.status(404).json({ok: false, error: 'ORDER_NOT_FOUND'});
    }
    if (order.status !== 'delivered') {
      return res.status(409).json({ok: false, error: 'BAD_STATUS', status: order.status});
    }
    if (m.ratingByOrder.get(order.id) != null) {
      return res.status(409).json({ok: false, error: 'ALREADY_RATED'});
    }
    const stars = Math.round(Number(req.body?.stars));
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ok: false, error: 'BAD_RATING'});
    }
    const comment = String(req.body?.comment || '').trim().slice(0, 300) || null;
    m.insertRating.run(order.id, user.id, order.store_id, stars, comment, Date.now());
    const stats = m.ratingStatsStore.get(order.store_id);
    audit('market_order_rated', {
      ip: req.ip,
      details: {order: order.order_number, stars, storeId: order.store_id},
    });
    res.json({
      ok: true,
      rating: {stars, comment},
      storeRating: {
        rating: stats != null && stats.n > 0 ? Math.round(stats.avg_stars * 10) / 10 : null,
        ratingCount: stats != null ? stats.n : 0,
      },
    });
  });

  /* ── v4.4: دفتر عناوين المستخدم ───────────────────────── */
  // الحد: 10 عناوين لكل حساب — كافٍ ومنع للإساءة.
  function addressFromBody(body) {
    return {
      label: String(body?.label || '').trim().slice(0, 24) || 'المنزل',
      region: String(body?.region || '').trim().slice(0, 60),
      city: String(body?.city || '').trim().slice(0, 60) || null,
      street: String(body?.street || '').trim().slice(0, 80) || null,
      building: String(body?.building || '').trim().slice(0, 24) || null,
      floor: String(body?.floor || '').trim().slice(0, 12) || null,
      apartment: String(body?.apartment || '').trim().slice(0, 12) || null,
      phone: String(body?.phone || '').replace(/[\s-]/g, '').slice(0, 16) || null,
      notes: String(body?.notes || '').trim().slice(0, 200) || null,
    };
  }

  router.get('/addresses', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    res.json({ok: true, addresses: m.addressesOfUser.all(user.id)});
  });

  router.post('/addresses', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const input = addressFromBody(req.body);
    if (input.region.length === 0) {
      return res.status(400).json({ok: false, error: 'BAD_REGION'});
    }
    const existing = m.addressesOfUser.all(user.id);
    if (existing.length >= 10) {
      return res.status(400).json({ok: false, error: 'TOO_MANY_ADDRESSES'});
    }
    const addressId = Number(req.body?.id) || 0;
    const makeDefault = req.body?.isDefault === true || existing.length === 0;
    const now = Date.now();
    let saved = null;
    db.transaction(() => {
      if (makeDefault) {
        m.clearDefaultAddress.run(now, user.id);
      }
      if (addressId > 0) {
        const current = m.addressById.get(addressId);
        if (current == null || current.user_id !== user.id) {
          throw new Error('ADDRESS_NOT_FOUND');
        }
        m.updateAddress.run(
          input.label, input.region, input.city, input.street, input.building,
          input.floor, input.apartment, input.phone, input.notes,
          makeDefault ? 1 : current.is_default, now, addressId);
        saved = m.addressById.get(addressId);
      } else {
        const info = m.insertAddress.run(
          user.id, input.label, input.region, input.city, input.street, input.building,
          input.floor, input.apartment, input.phone, input.notes, makeDefault ? 1 : 0,
          now, now);
        saved = m.addressById.get(Number(info.lastInsertRowid));
      }
    })();
    res.json({ok: true, address: saved});
  });

  router.post('/addresses/:id/default', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const address = m.addressById.get(Number(req.params.id));
    if (address == null || address.user_id !== user.id) {
      return res.status(404).json({ok: false, error: 'ADDRESS_NOT_FOUND'});
    }
    const now = Date.now();
    db.transaction(() => {
      m.clearDefaultAddress.run(now, user.id);
      m.setDefaultAddress.run(now, address.id, user.id);
    })();
    res.json({ok: true, address: m.addressById.get(address.id)});
  });

  router.post('/addresses/:id/delete', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ok: false, error: 'AUTH_REQUIRED'});
    const address = m.addressById.get(Number(req.params.id));
    if (address == null || address.user_id !== user.id) {
      return res.status(404).json({ok: false, error: 'ADDRESS_NOT_FOUND'});
    }
    const wasDefault = address.is_default === 1;
    m.deleteAddress.run(address.id, user.id);
    // حذف الافتراضي: أول عنوان متبقٍ يصبح افتراضياً (يبقى للتطبيق
    // منطق «متاجر منطقتك» فعالاً دائماً).
    if (wasDefault) {
      const rest = m.addressesOfUser.all(user.id);
      if (rest.length > 0) {
        m.setDefaultAddress.run(Date.now(), rest[0].id, user.id);
      }
    }
    res.json({ok: true});
  });

  return router;
}

/* ════════════════════════════════════════════════════════════════
 * 3) Admin API — /api/admin/market/* (لوحة التحكم)
 * ════════════════════════════════════════════════════════════════ */

function buildMarketAdminRouter() {
  const router = express.Router();

  /* ── متجر عمومي للإدارة (بغض النظر عن النشر) ─────────────── */
  function adminStore(id) {
    return m.storeById.get(Number(id)) || null;
  }

  router.get('/stores', (req, res) => {
    const rows = db.prepare(
      `SELECT s.*, k.key_plain, k.revoked_at, k.plan_expires_at,
         (SELECT COUNT(*) FROM store_products p
           WHERE p.store_id = s.id AND p.available = 1) AS products_count,
         (SELECT COUNT(*) FROM store_products p
           WHERE p.store_id = s.id AND p.available = 1 AND p.discount_pct > 0) AS offers_count,
         (SELECT COUNT(*) FROM market_orders o WHERE o.store_id = s.id) AS orders_count,
         (SELECT COUNT(*) FROM market_orders o
           WHERE o.store_id = s.id AND o.status = 'new') AS new_orders,
         (SELECT AVG(r.stars) FROM market_ratings r WHERE r.store_id = s.id) AS rating_avg,
         (SELECT COUNT(*) FROM market_ratings r WHERE r.store_id = s.id) AS rating_count
       FROM stores s JOIN keys k ON k.id = s.key_id
       ORDER BY s.updated_at DESC LIMIT 500`,
    ).all();
    const now = Date.now();
    res.json({
      ok: true,
      stores: rows.map(r => {
        const logo = storeLogoUrl(r);
        return {
          ...r,
          subscriptionActive: !r.revoked_at && r.plan_expires_at != null && r.plan_expires_at > now,
          ...(logo != null ? {logo_url: logo} : {}),
        };
      }),
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

  /* v4.5: تعديل ملف المتجر من الإدارة — نفس قيود register. */
  router.post('/stores/:id/profile', (req, res) => {
    const store = adminStore(req.params.id);
    if (!store) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const b = req.body || {};
    const name = String(b.name ?? store.name).trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ok: false, error: 'BAD_STORE'});
    const category = String(b.category ?? store.category ?? '').trim().slice(0, 40) || null;
    const region = String(b.region ?? store.region ?? '').trim().slice(0, 60) || null;
    const description = String(b.description ?? store.description ?? '').trim().slice(0, 400) || null;
    const phone = String(b.phone ?? store.phone ?? '').trim().slice(0, 24) || null;
    const whatsapp = String(b.whatsapp ?? store.whatsapp ?? '').trim().slice(0, 24) || null;
    m.updateStore.run(name, description, category, region, phone, whatsapp, Date.now(), store.id);
    audit('admin_market_store_profile', {adminId: req.adminUser.id, ip: req.ip,
      details: {storeId: store.id}});
    res.json({ok: true});
  });

  /* v4.7: إخفاء/إظهار منتج واحد من الإدارة — قرار دائم يقاوم
   * مزامنات POS التالية (يُعاد تطبيقه بعد كل upsert). المتجر
   * يراه في كتالوجه ولا يراه المشتري في المول. */
  router.post('/products/:id/visibility', (req, res) => {
    const id = Number(req.params.id);
    const product = m.storeProductAnyById.get(id);
    if (product == null) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const hidden = req.body?.hidden ? true : false;
    const now = Date.now();
    if (hidden) {
      m.hideProduct.run(id, req.adminUser.id, now);
      db.prepare('UPDATE store_products SET available = 0 WHERE id = ?').run(id);
    } else {
      m.unhideProduct.run(id);
      db.prepare('UPDATE store_products SET available = 1 WHERE id = ?').run(id);
    }
    audit('admin_market_product_visibility', {adminId: req.adminUser.id, ip: req.ip,
      details: {productId: id, storeId: product.store_id, hidden}});
    res.json({ok: true});
  });

  /* v4.5: بطاقة المتجر الكاملة — ملف + شعار + مناطق + كتالوج
   * (بالخصومات والصور) + التقييمات + الطلبات الأخيرة.
   * v4.7: الكتالوج يعرض المعروض والمخفي إدارياً معاً (الإخفاء
   * بقرار الإدارة لا يغيّر بيانات التاجر — قابل للتراجع). */
  router.get('/stores/:id/full', (req, res) => {
    const store = adminStore(req.params.id);
    if (!store) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const keyRow = stmt.keyById.get(store.key_id);
    const now = Date.now();
    const stats = m.ratingStatsStore.get(store.id);
    const products = db.prepare(
      `SELECT p.*, (h.product_id IS NOT NULL) AS admin_hidden
       FROM store_products p
       LEFT JOIN admin_hidden_products h ON h.product_id = p.id
       WHERE p.store_id = ? AND (p.available = 1 OR h.product_id IS NOT NULL)
       ORDER BY p.name COLLATE NOCASE ASC LIMIT 500`,
    ).all(store.id);
    res.json({
      ok: true,
      store: {
        ...store,
        subscriptionActive: !keyRow.revoked_at && keyRow.plan_expires_at != null && keyRow.plan_expires_at > now,
        ...(storeLogoUrl(store) != null ? {logo_url: storeLogoUrl(store)} : {}),
      },
      deliveryRegions: m.listRegions.all(store.id),
      products: products.map(p => {
        const j = productJson(p);
        // للإدارة: نعرض الحقول الفارغة أيضاً (تعديل أدق)
        return {...p, ...j, images: m.imagesOfProducts.all(p.id).map(imageUrl)};
      }),
      rating: stats != null && stats.n > 0 ? Math.round(stats.avg_stars * 10) / 10 : null,
      ratingCount: stats != null ? stats.n : 0,
      reviews: m.ratingsOfStore.all(store.id).map(r => ({
        stars: r.stars, comment: r.comment, createdAt: r.created_at,
        userName: String(r.user_name || '').trim() || 'مستخدم سيلا',
      })),
      orders: db.prepare(
        `SELECT o.*, u.name AS user_name, u.phone AS user_phone,
           (SELECT COUNT(*) FROM market_order_items i WHERE i.order_id = o.id) AS items_count
         FROM market_orders o JOIN market_users u ON u.id = o.user_id
         WHERE o.store_id = ? ORDER BY o.updated_at DESC LIMIT 50`,
      ).all(store.id),
    });
  });

  /* v4.5: إدارة مستخدمي المتجر — قائمة + تعطيل/تفعيل. */
  router.get('/users', (req, res) => {
    const rows = db.prepare(
      `SELECT u.id, u.id_number, u.name, u.phone, u.disabled, u.created_at, u.last_seen_at,
         (SELECT COUNT(*) FROM market_orders o WHERE o.user_id = u.id) AS orders_count,
         (SELECT COUNT(*) FROM market_orders o
           WHERE o.user_id = u.id AND o.status = 'delivered') AS delivered_count,
         (SELECT COUNT(*) FROM market_addresses a WHERE a.user_id = u.id) AS addresses_count,
         (SELECT COUNT(*) FROM market_ratings r WHERE r.user_id = u.id) AS ratings_count
       FROM market_users u ORDER BY u.last_seen_at DESC LIMIT 500`,
    ).all();
    res.json({ok: true, users: rows});
  });

  router.post('/users/:id/disable', (req, res) => {
    const id = Number(req.params.id);
    const user = m.userById.get(id);
    if (!user) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const disabled = req.body?.disabled ? 1 : 0;
    db.prepare('UPDATE market_users SET disabled = ? WHERE id = ?').run(disabled, id);
    if (disabled) {
      // تعطيل فوري لكل جلساته المفتوحة
      m.deleteTokensOfUser.run(id);
    }
    audit('admin_market_user_disable', {adminId: req.adminUser.id, ip: req.ip,
      details: {userId: id, disabled}});
    res.json({ok: true});
  });

  /* ── v5.0: إعادة تعيين كلمة مرور مستخدم من الإدارة ───────────
   * المسار الرسمي للاستعادة (طلب المالك): المستخدم الناسي يتواصل
   * مع الإدارة، والإدارة تعيّن كلمة مؤقتة هنا — تُبطَل كل جلساته
   * فوراً ويسجل الدخول بكلمته الجديدة. */
  router.post('/users/:id/reset-password', (req, res) => {
    const id = Number(req.params.id);
    const user = m.userById.get(id);
    if (!user) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const body = req.body || {};
    let password = String(body.password || '');
    // توليد كلمة مؤقتة ذكية إن لم تُرسل: 10 محارف بحرفين ورقمين مضمونين.
    if (password === '') {
      const alphabet = 'abcdefghjkmnpqrstuvwxyz';
      let gen = '';
      for (let i = 0; i < 6; i++) {
        gen += alphabet[crypto.randomInt(0, alphabet.length)];
      }
      password = 'Sm' + gen + crypto.randomInt(10, 100);
    }
    const pwProblem = passwordProblem(password);
    if (pwProblem != null) return res.status(400).json({ok: false, error: pwProblem});
    const now = Date.now();
    db.transaction(() => {
      m.setUserPassword.run(hashPassword(password), now, user.id);
      m.deleteTokensOfUser.run(user.id);
      db.prepare('DELETE FROM market_reset_codes WHERE user_id = ?').run(user.id);
    })();
    audit('admin_market_user_reset_password', {adminId: req.adminUser.id, ip: req.ip,
      details: {userId: user.id}});
    res.json({ok: true, password});
  });

  /* ── v5.0: إعدادات أمن السوق (نسيت كلمة المرور + مزود SMS) ── */
  router.get('/security', (_req, res) => {
    const {PROVIDER_FIELDS, maskSecret} = require('./sms');
    const provider = getSetting('sms_provider', '');
    const providerFields = PROVIDER_FIELDS[provider] || [];
    // الأسرار تُرد مُقنّعة — اللوحة تعرض آخر محرفين فقط، ولا تُكتب
    // أبداً إلا إذا غيّرها المالك صراحة (القناع يبدأ بـ ••••).
    const masked = {};
    for (const f of providerFields) {
      const v = getSetting(f.key, '');
      const isSecret = /password|token/i.test(f.key);
      masked[f.key] = isSecret ? maskSecret(v) : v;
    }
    res.json({
      ok: true,
      forgotEnabled: getSetting('market_forgot_enabled', '0') === '1',
      contactPhone: getSetting('market_contact_phone', ''),
      provider,
      providers: Object.keys(PROVIDER_FIELDS),
      fields: providerFields,
      values: masked,
      ready: smsReady(),
    });
  });

  router.put('/security', (req, res) => {
    const {PROVIDER_FIELDS} = require('./sms');
    const b = req.body || {};
    if (b.forgotEnabled !== undefined) {
      setSetting('market_forgot_enabled', b.forgotEnabled ? '1' : '0');
    }
    if (typeof b.contactPhone === 'string') {
      setSetting('market_contact_phone', b.contactPhone.trim().slice(0, 24));
    }
    if (typeof b.provider === 'string') {
      const valid = Object.keys(PROVIDER_FIELDS);
      if (b.provider !== '' && !valid.includes(b.provider)) {
        return res.status(400).json({ok: false, error: 'BAD_PROVIDER'});
      }
      setSetting('sms_provider', b.provider.trim());
    }
    // الحقول: نكتب فقط ما أُرسل غير مقنّع (القناع يبدأ بـ ••••).
    const allFields = new Set();
    for (const list of Object.values(PROVIDER_FIELDS)) {
      for (const f of list) {
        allFields.add(f);
      }
    }
    if (b.values && typeof b.values === 'object') {
      for (const f of allFields) {
        const v = b.values[f.key];
        if (typeof v === 'string' && !v.startsWith('••')) {
          setSetting(f.key, v.trim().slice(0, 500));
        }
      }
    }
    audit('admin_market_security_update', {adminId: req.adminUser.id, ip: req.ip,
      details: {forgotEnabled: b.forgotEnabled, provider: b.provider}});
    res.json({ok: true, ready: smsReady()});
  });

  /* ── v5.0: رسالة اختبار للمزود المُعدّ — يتحقق المالك من بياناته
   * قبل تفعيل التدفق للعلن. */
  router.post('/security/test-sms', (req, res) => {
    const phone = String((req.body || {}).phone || '').trim();
    if (!/^\+?\d[\d\s-]{5,19}$/.test(phone)) {
      return res.status(400).json({ok: false, error: 'BAD_PHONE'});
    }
    const provider = getSetting('sms_provider', '');
    if (!provider) return res.status(400).json({ok: false, error: 'NO_PROVIDER'});
    const s = smsSettings();
    sendSms(provider, s, phone,
      'سيلا ماركت — رسالة اختبار من لوحة الإدارة. بيانات المزود تعمل بنجاح.')
      .then((result) => {
        audit('admin_market_sms_test', {adminId: req.adminUser.id, ip: req.ip,
          details: {provider, ok: result.ok, detail: result.detail}});
        res.json(result);
      });
  });

  router.get('/orders', (req, res) => {
    const storeId = Number(req.query.storeId) || 0;
    const status = String(req.query.status || '').trim();
    let sql = `SELECT o.*, s.name AS store_name, u.name AS user_name, u.phone AS user_phone,
        (SELECT COUNT(*) FROM market_order_items i WHERE i.order_id = o.id) AS items_count,
        (SELECT r.stars FROM market_ratings r WHERE r.order_id = o.id) AS rating_stars
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
    const ratingRow = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(AVG(stars), 0) AS avg_stars FROM market_ratings`,
    ).get();
    res.json({
      ok: true,
      stores: count('SELECT COUNT(*) n FROM stores'),
      publishedStores: count(
        `SELECT COUNT(*) n FROM stores s JOIN keys k ON k.id = s.key_id
         WHERE s.published = 1 AND k.revoked_at IS NULL
           AND k.plan_expires_at IS NOT NULL AND k.plan_expires_at > ?`, now),
      users: count('SELECT COUNT(*) n FROM market_users'),
      activeUsers: count(
        'SELECT COUNT(*) n FROM market_users WHERE disabled = 0 AND last_seen_at > ?',
        now - 30 * DAY_MS),
      addresses: count('SELECT COUNT(*) n FROM market_addresses'),
      products: count('SELECT COUNT(*) n FROM store_products WHERE available = 1'),
      discountedProducts: count(
        'SELECT COUNT(*) n FROM store_products WHERE available = 1 AND discount_pct > 0'),
      ratingCount: ratingRow.n,
      ratingAvg: ratingRow.n > 0 ? Math.round(ratingRow.avg_stars * 10) / 10 : null,
      orders: count('SELECT COUNT(*) n FROM market_orders'),
      newOrders: count(`SELECT COUNT(*) n FROM market_orders WHERE status = 'new'`),
      deliveredOrders: count(`SELECT COUNT(*) n FROM market_orders WHERE status = 'delivered'`),
      gmvMinor: db.prepare(
        `SELECT COALESCE(SUM(total_minor - delivery_fee_minor), 0) v
         FROM market_orders WHERE status IN ('sent','delivered','returned')`).get().v,
      discountMinor: db.prepare(
        `SELECT COALESCE(SUM(items_discount_minor), 0) v FROM market_orders`).get().v,
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
