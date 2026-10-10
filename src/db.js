/**
 * db.js — SQLite storage (better-sqlite3, file under DATA_DIR).
 * ─────────────────────────────────────────────────────────────────
 * ALL prepared statements are created ONCE at module load — per-request
 * db.prepare() would leak Statement objects whose native finalizers can
 * crash under GC on newer Node versions, and it's slower anyway.
 *
 * Tables (v2):
 *  keys          — activation keys the owner creates/sells (+price)
 *  activations   — device ↔ key bindings with their expiry
 *  payments      — actual money received per key (revenue ledger)
 *  admin_users   — panel accounts (email + scrypt password hash)
 *  admin_sessions— hashed session tokens for the panel
 *  settings      — key/value (contact info, pricing, currency…)
 *  audit         — every security-relevant event
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA_DIR, {recursive: true});

const db = new Database(path.join(DATA_DIR, 'sela-license.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_plain     TEXT UNIQUE NOT NULL,
  key_hash      TEXT UNIQUE NOT NULL,
  plan_days     INTEGER NOT NULL,
  max_devices   INTEGER NOT NULL DEFAULT 1,
  price         REAL NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE TABLE IF NOT EXISTS activations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id        INTEGER NOT NULL REFERENCES keys(id),
  device_id     TEXT NOT NULL,
  device_label  TEXT,
  activated_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen     INTEGER,
  last_device_time INTEGER,
  unbound_at    INTEGER,
  UNIQUE(key_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_activations_key ON activations(key_id);
CREATE INDEX IF NOT EXISTS idx_activations_device ON activations(device_id);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id        INTEGER REFERENCES keys(id),
  amount        REAL NOT NULL,
  method        TEXT NOT NULL DEFAULT 'cash',
  note          TEXT,
  admin_id      INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_key ON payments(key_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  last_login_ip TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES admin_users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON admin_sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT UNIQUE NOT NULL,
  title         TEXT,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS download_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT UNIQUE NOT NULL,  -- google_play | direct_apk | desktop | apple_store
  url           TEXT NOT NULL DEFAULT '',
  label         TEXT,
  enabled       INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_options (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,          -- phone | whatsapp | telegram | email | website | custom
  label         TEXT NOT NULL,
  value         TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  event   TEXT NOT NULL,
  key_id  INTEGER,
  device_id TEXT,
  admin_id INTEGER,
  ip      TEXT,
  details TEXT
);
`);

// ── in-place migrations for databases created by v1 ─────────────
(function migrate() {
  const cols = new Set(
    db.prepare('PRAGMA table_info(keys)').all().map(c => c.name),
  );
  if (!cols.has('price')) {
    db.exec('ALTER TABLE keys ADD COLUMN price REAL NOT NULL DEFAULT 0');
  }
  // v2 (sela v33 round-41 #5): نافذة الخطة تخص المفتاح نفسه —
  // تُرسّخ عند أول تفعيل EVER لأي جهاز ولا تُعاد أبداً (منع الغش
  // بحذف التطبيق وإعادة التفعيل بنفس المفتاح). كل ربط جديد (أي
  // جهاز، حتى بعد مسح الجهاز وإعادة التثبيت بمعرّف جديد) يرث نفس
  // النافذة.
  if (!cols.has('first_activated_at')) {
    db.exec('ALTER TABLE keys ADD COLUMN first_activated_at INTEGER');
  }
  if (!cols.has('plan_expires_at')) {
    db.exec('ALTER TABLE keys ADD COLUMN plan_expires_at INTEGER');
  }
  // Backfill: المفاتيح المفعّلة سابقاً ترث أول تفعيل لها كمرساة،
  // وأبعد انتهاء ربط نشط كنهاية نافذة (لا يقصّر اشتراكاً حياً).
  db.exec(`
    UPDATE keys
    SET first_activated_at = (
          SELECT MIN(a.activated_at) FROM activations a WHERE a.key_id = keys.id
        ),
        plan_expires_at = (
          SELECT MAX(a.expires_at) FROM activations a
          WHERE a.key_id = keys.id AND a.unbound_at IS NULL
        )
    WHERE first_activated_at IS NULL
      AND EXISTS (SELECT 1 FROM activations a WHERE a.key_id = keys.id)
  `);
  const auditCols = new Set(
    db.prepare('PRAGMA table_info(audit)').all().map(c => c.name),
  );
  if (!auditCols.has('admin_id')) {
    db.exec('ALTER TABLE audit ADD COLUMN admin_id INTEGER');
  }
})();

// ── default settings (first boot only — never overwrite) ────────
const DEFAULT_SETTINGS = {
  contact_phone: process.env.CONTACT_PHONE || '',
  contact_whatsapp: process.env.CONTACT_WHATSAPP || '',
  contact_telegram: process.env.CONTACT_TELEGRAM || '',
  contact_email: process.env.CONTACT_EMAIL || '',
  contact_note: process.env.CONTACT_NOTE || 'لشراء أو تجديد الاشتراك تواصل معنا عبر أحد قنوات التواصل',
  currency: '₪',
  price_trial: '0',
  price_monthly: '50',
  price_quarterly: '120',
  price_yearly: '400',
  // ── landing page content (v3 — managed from the panel) ──
  landing_hero_badge: 'التطبيق الأول لإدارة المتاجر والديون',
  landing_hero_title: 'سيلا — دفتر متجرك الذكي في جيبك',
  landing_hero_subtitle:
    'نقاط بيع كاملة بالكاميرا الذكية، دفتر ديون منظّم، مخزون وتقارير دقيقة، وطباعة فورية — كل متجرك في تطبيق واحد يعمل بدون إنترنت.',
  landing_cta_text: 'حمّل التطبيق الآن مجاناً',
  landing_show_pricing: '1',
  site_footer_note: 'سيلا — نظام إدارة المتاجر والاشتراكات',
  site_seo_description:
    'تطبيق سيلا لإدارة المتاجر: نقاط بيع، دفتر ديون، مخزون، تقارير وطباعة — يعمل بدون إنترنت ويناسب كل أنواع المتاجر.',
  landing_features: JSON.stringify([
    {icon: 'scan', title: 'بيع بالكاميرا الذكية', text: 'وجّه الكاميرا لأي منتج وتعرّف عليه فوراً وبيعه بلمسة واحدة — أسرع طريق لإتمام البيع.'},
    {icon: 'book', title: 'دفتر ديون إلكتروني', text: 'سجّل ديون الزبائن مع سداد موثّق وتنبيهات تلقائية — لا دفتر ورقي ولا نسيان بعد اليوم.'},
    {icon: 'store', title: 'يناسب كل المتاجر', text: 'أنماط جاهزة للملابس والصيدليات والمطاعم والمقاهي والبقالة والفواكه — لكل متجر تجربته.'},
    {icon: 'boxes', title: 'مخزون وتنبيهات', text: 'تتبّع الكميات والمخزون بدقة مع تنبيهات النفاد التلقائية وخصم تلقائي مع كل عملية بيع.'},
    {icon: 'chart', title: 'تقارير تديرها بنفسك', text: 'أرباح ومبيعات وأداء الساعات وأفضل المنتجات — تقارير واضحة تساعدك تقرر بثقة.'},
    {icon: 'printer', title: 'طباعة فورية', text: 'فاتورة حرارية للزبون مع دعم الطابعات البلوتوث — اطبع فور إتمام البيع بضغطة زر.'},
  ]),
};
{
  const insertDefault = db.prepare(
    'INSERT OR IGNORE INTO settings (k, v) VALUES (?, ?)',
  );
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    insertDefault.run(k, v);
  }
}

// ── seed download-link rows (fixed 4 platforms) ──────────────────
db.exec(`
  INSERT OR IGNORE INTO download_links (platform, url, label, enabled, sort_order, updated_at) VALUES
    ('google_play', '', 'من جوجل بلاي', 0, 1, strftime('%s','now') * 1000),
    ('direct_apk',  '', 'تحميل مباشر APK', 0, 2, strftime('%s','now') * 1000),
    ('desktop',     '', 'نسخة سطح المكتب', 0, 3, strftime('%s','now') * 1000),
    ('apple_store', '', 'من آب ستور', 0, 4, strftime('%s','now') * 1000);
`);

// ── seed contact options from legacy settings (first boot only) ──
(function seedContactOptions() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM contact_options').get().n;
  if (n > 0) return;
  const s = k => getSettingEarly(k);
  const seeds = [];
  if (s('contact_phone')) seeds.push({type: 'phone', label: 'اتصال هاتفي', value: s('contact_phone')});
  if (s('contact_whatsapp')) seeds.push({type: 'whatsapp', label: 'واتساب', value: s('contact_whatsapp')});
  if (s('contact_telegram')) seeds.push({type: 'telegram', label: 'تيليجرام', value: s('contact_telegram')});
  if (s('contact_email')) seeds.push({type: 'email', label: 'البريد الإلكتروني', value: s('contact_email')});
  const ins = db.prepare(
    'INSERT INTO contact_options (type, label, value, enabled, sort_order, created_at) VALUES (?, ?, ?, 1, ?, ?)',
  );
  const now = Date.now();
  seeds.forEach((o, i) => ins.run(o.type, o.label, o.value, i + 1, now));
})();

// tiny local helper used before `stmt` is defined below
function getSettingEarly(k) {
  const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(k);
  return row ? row.v : '';
}

// ── cached statements ────────────────────────────────────────────

const stmt = {
  // settings
  getSetting: db.prepare('SELECT v FROM settings WHERE k = ?'),
  upsertSetting: db.prepare(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ),

  // audit
  insertAudit: db.prepare(
    'INSERT INTO audit (ts, event, key_id, device_id, admin_id, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ),
  recentAudit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),

  // keys
  keyByHash: db.prepare('SELECT * FROM keys WHERE key_hash = ?'),
  keyById: db.prepare('SELECT * FROM keys WHERE id = ?'),
  insertKey: db.prepare(
    `INSERT INTO keys (key_plain, key_hash, plan_days, max_devices, price, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
  listKeys: db.prepare(
    `SELECT k.id, k.key_plain, k.plan_days, k.max_devices, k.price, k.note,
            k.created_at, k.revoked_at, k.first_activated_at, k.plan_expires_at,
            (SELECT COUNT(*) FROM activations a
              WHERE a.key_id = k.id AND a.unbound_at IS NULL) AS active_devices,
            (SELECT MAX(a.expires_at) FROM activations a
              WHERE a.key_id = k.id AND a.unbound_at IS NULL) AS latest_expiry,
            (SELECT MAX(a.last_seen) FROM activations a
              WHERE a.key_id = k.id) AS last_seen,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
              WHERE p.key_id = k.id) AS paid_sum
     FROM keys k
     ORDER BY k.id DESC
     LIMIT 1000`,
  ),
  searchKeys: db.prepare(
    `SELECT k.id, k.key_plain, k.plan_days, k.max_devices, k.price, k.note,
            k.created_at, k.revoked_at, k.first_activated_at, k.plan_expires_at,
            (SELECT COUNT(*) FROM activations a
              WHERE a.key_id = k.id AND a.unbound_at IS NULL) AS active_devices,
            (SELECT MAX(a.expires_at) FROM activations a
              WHERE a.key_id = k.id AND a.unbound_at IS NULL) AS latest_expiry,
            (SELECT MAX(a.last_seen) FROM activations a
              WHERE a.key_id = k.id) AS last_seen,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
              WHERE p.key_id = k.id) AS paid_sum
     FROM keys k
     WHERE k.key_plain LIKE ? OR k.note LIKE ?
     ORDER BY k.id DESC
     LIMIT 200`,
  ),

  // activations / bindings
  listBindings: db.prepare(
    `SELECT id, device_id, device_label, activated_at, expires_at, last_seen, unbound_at
     FROM activations WHERE key_id = ? ORDER BY activated_at DESC`,
  ),
  listAllBindings: db.prepare(
    `SELECT a.*, k.key_plain, k.note AS key_note, k.plan_days
     FROM activations a JOIN keys k ON k.id = a.key_id
     ORDER BY a.activated_at DESC LIMIT 1000`,
  ),
  bindingByKeyDevice: db.prepare(
    'SELECT * FROM activations WHERE key_id = ? AND device_id = ? AND unbound_at IS NULL',
  ),
  countActiveBindings: db.prepare(
    'SELECT COUNT(*) AS n FROM activations WHERE key_id = ? AND unbound_at IS NULL',
  ),
  insertBinding: db.prepare(
    `INSERT INTO activations
       (key_id, device_id, device_label, activated_at, expires_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  touchBinding: db.prepare(
    'UPDATE activations SET last_seen = ?, device_label = ? WHERE id = ?',
  ),
  heartbeatBinding: db.prepare(
    'UPDATE activations SET last_seen = ?, last_device_time = ? WHERE id = ?',
  ),
  unbindByKeyDevice: db.prepare(
    'UPDATE activations SET unbound_at = ? WHERE key_id = ? AND device_id = ? AND unbound_at IS NULL',
  ),
  extendActiveBindings: db.prepare(
    `UPDATE activations
     SET expires_at = expires_at + ?
     WHERE key_id = ? AND unbound_at IS NULL AND expires_at > ?`,
  ),
  revokeKey: db.prepare(
    'UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  ),
  restoreKey: db.prepare('UPDATE keys SET revoked_at = NULL WHERE id = ?'),
  // v2 (sela v33 round-41 #5): نافذة خطة المفتاح — مرساتها أول تفعيل
  // EVER، وتمديدها بيد الإدارة فقط.
  anchorKeyPlan: db.prepare(
    `UPDATE keys
     SET first_activated_at = ?, plan_expires_at = ?
     WHERE id = ? AND first_activated_at IS NULL`
  ),
  extendKeyPlan: db.prepare(
    `UPDATE keys
     SET plan_expires_at = MAX(COALESCE(plan_expires_at, ?), ?) + ?
     WHERE id = ?`
  ),

  // payments
  insertPayment: db.prepare(
    'INSERT INTO payments (key_id, amount, method, note, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  listPayments: db.prepare(
    `SELECT p.*, k.key_plain, k.note AS key_note, u.name AS admin_name
     FROM payments p
     LEFT JOIN keys k ON k.id = p.key_id
     LEFT JOIN admin_users u ON u.id = p.admin_id
     ORDER BY p.id DESC LIMIT ?`,
  ),
  paymentsForKey: db.prepare(
    `SELECT p.*, u.name AS admin_name FROM payments p
     LEFT JOIN admin_users u ON u.id = p.admin_id
     WHERE p.key_id = ? ORDER BY p.id DESC`,
  ),
  paymentById: db.prepare('SELECT * FROM payments WHERE id = ?'),
  deletePayment: db.prepare('DELETE FROM payments WHERE id = ?'),
  revenueTotal: db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM payments',
  ),
  revenueSince: db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE created_at >= ?',
  ),
  revenueByMonth: db.prepare(
    `SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch', 'localtime') AS ym,
            SUM(amount) AS total, COUNT(*) AS n
     FROM payments
     WHERE created_at >= ?
     GROUP BY ym ORDER BY ym ASC`,
  ),
  paymentsSince: db.prepare(
    'SELECT amount, created_at, key_id FROM payments WHERE created_at >= ?',
  ),

  // admin users & sessions
  adminByEmail: db.prepare('SELECT * FROM admin_users WHERE email = ?'),
  adminById: db.prepare('SELECT * FROM admin_users WHERE id = ?'),
  listAdmins: db.prepare(
    'SELECT id, email, name, role, disabled, created_at, last_login_at, last_login_ip FROM admin_users ORDER BY id',
  ),
  countAdmins: db.prepare('SELECT COUNT(*) AS n FROM admin_users'),
  countOwners: db.prepare(
    "SELECT COUNT(*) AS n FROM admin_users WHERE role = 'owner' AND disabled = 0",
  ),
  insertAdmin: db.prepare(
    `INSERT INTO admin_users (email, name, password_hash, role, disabled, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ),
  updateAdmin: db.prepare(
    `UPDATE admin_users SET name = COALESCE(?, name), role = COALESCE(?, role),
      disabled = COALESCE(?, disabled), password_hash = COALESCE(?, password_hash)
     WHERE id = ?`,
  ),
  touchAdminLogin: db.prepare(
    'UPDATE admin_users SET last_login_at = ?, last_login_ip = ? WHERE id = ?',
  ),
  insertSession: db.prepare(
    'INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  sessionByToken: db.prepare(
    `SELECT s.*, u.email, u.name, u.role, u.disabled
     FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
  ),
  deleteSession: db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?'),
  deleteSessionsForUser: db.prepare(
    'DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?',
  ),
  refreshSession: db.prepare(
    'UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?',
  ),
  purgeExpiredSessions: db.prepare(
    'DELETE FROM admin_sessions WHERE expires_at < ?',
  ),

  // stats
  statsTotalKeys: db.prepare('SELECT COUNT(*) n FROM keys'),
  statsActiveKeys: db.prepare(
    `SELECT COUNT(DISTINCT k.id) n FROM keys k
     JOIN activations a ON a.key_id = k.id
     WHERE k.revoked_at IS NULL AND a.unbound_at IS NULL AND a.expires_at > ?`,
  ),
  statsActiveDevices: db.prepare(
    'SELECT COUNT(*) n FROM activations WHERE unbound_at IS NULL AND expires_at > ?',
  ),
  statsRevokedKeys: db.prepare(
    'SELECT COUNT(*) n FROM keys WHERE revoked_at IS NOT NULL',
  ),
  statsExpiringSoon: db.prepare(
    `SELECT COUNT(*) n FROM activations
     WHERE unbound_at IS NULL AND expires_at > ? AND expires_at < ?`,
  ),
  statsUnusedKeys: db.prepare(
    `SELECT COUNT(*) n FROM keys k
     WHERE k.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM activations a WHERE a.key_id = k.id)`,
  ),
  statsUnpaidKeys: db.prepare(
    `SELECT COUNT(*) n FROM keys k
     WHERE k.price > 0
       AND (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.key_id = k.id) < k.price`,
  ),
  planDistribution: db.prepare(
    `SELECT k.plan_days, COUNT(*) AS n, COALESCE(SUM(k.price), 0) AS value
     FROM keys k
     JOIN activations a ON a.key_id = k.id
     WHERE a.unbound_at IS NULL AND a.expires_at > ?
     GROUP BY k.plan_days ORDER BY k.plan_days`,
  ),
  activationsByDay: db.prepare(
    `SELECT strftime('%Y-%m-%d', activated_at / 1000, 'unixepoch', 'localtime') AS d,
            COUNT(*) AS n
     FROM activations WHERE activated_at >= ? GROUP BY d`,
  ),
  expiringList: db.prepare(
    `SELECT k.key_plain, k.note, k.plan_days, a.device_label, a.expires_at
     FROM activations a JOIN keys k ON k.id = a.key_id
     WHERE a.unbound_at IS NULL AND a.expires_at > ? AND a.expires_at < ?
     ORDER BY a.expires_at ASC LIMIT 30`,
  ),
  deviceSeenSince: db.prepare(
    'SELECT COUNT(*) n FROM activations WHERE unbound_at IS NULL AND last_seen >= ?',
  ),
  mrrRows: db.prepare(
    `SELECT k.price, k.plan_days FROM keys k
     JOIN activations a ON a.key_id = k.id
     WHERE a.unbound_at IS NULL AND a.expires_at > ?`,
  ),

  // ── media (landing screenshots) ─────────────────────────────────
  insertMedia: db.prepare(
    `INSERT INTO media (filename, title, mime, size, width, height, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  listMedia: db.prepare('SELECT * FROM media ORDER BY sort_order ASC, id ASC'),
  mediaById: db.prepare('SELECT * FROM media WHERE id = ?'),
  mediaByFilename: db.prepare('SELECT * FROM media WHERE filename = ?'),
  maxMediaSort: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM media'),
  countMedia: db.prepare('SELECT COUNT(*) AS n FROM media'),
  mediaBySort: db.prepare('SELECT * FROM media WHERE sort_order = ?'),
  setMediaSort: db.prepare('UPDATE media SET sort_order = ? WHERE id = ?'),
  shiftMediaSort: db.prepare('UPDATE media SET sort_order = sort_order + ? WHERE id = ?'),
  deleteMedia: db.prepare('DELETE FROM media WHERE id = ?'),
  updateMediaTitle: db.prepare('UPDATE media SET title = ? WHERE id = ?'),

  // ── download links (4 fixed platforms) ──────────────────────────
  listDownloadLinks: db.prepare('SELECT * FROM download_links ORDER BY sort_order ASC'),
  downloadLinkByPlatform: db.prepare('SELECT * FROM download_links WHERE platform = ?'),
  downloadLinkById: db.prepare('SELECT * FROM download_links WHERE id = ?'),
  upsertDownloadLink: db.prepare(
    `INSERT INTO download_links (platform, url, label, enabled, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform) DO UPDATE SET
       url = excluded.url, label = excluded.label,
       enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ),
  setDownloadLinkEnabled: db.prepare(
    'UPDATE download_links SET enabled = ?, updated_at = ? WHERE platform = ?',
  ),

  // ── contact options (website contact page) ──────────────────────
  listContactOptions: db.prepare(
    'SELECT * FROM contact_options ORDER BY sort_order ASC, id ASC',
  ),
  listEnabledContactOptions: db.prepare(
    'SELECT * FROM contact_options WHERE enabled = 1 ORDER BY sort_order ASC, id ASC',
  ),
  contactOptionById: db.prepare('SELECT * FROM contact_options WHERE id = ?'),
  insertContactOption: db.prepare(
    `INSERT INTO contact_options (type, label, value, enabled, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  updateContactOption: db.prepare(
    `UPDATE contact_options SET type = ?, label = ?, value = ?, enabled = ? WHERE id = ?`,
  ),
  deleteContactOption: db.prepare('DELETE FROM contact_options WHERE id = ?'),
  maxContactSort: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM contact_options'),
  contactOptionBySort: db.prepare('SELECT * FROM contact_options WHERE sort_order = ?'),
  setContactSort: db.prepare('UPDATE contact_options SET sort_order = ? WHERE id = ?'),
  countContactOptions: db.prepare('SELECT COUNT(*) AS n FROM contact_options'),
  clearContactOptions: db.prepare('DELETE FROM contact_options'),
};

// Purge expired sessions hourly (plus once at boot).
function purgeSessions() {
  stmt.purgeExpiredSessions.run(Date.now());
}
purgeSessions();
setInterval(purgeSessions, 3600 * 1000).unref();

// ── helpers ──────────────────────────────────────────────────────

function getSetting(k, fallback) {
  const row = stmt.getSetting.get(k);
  return row ? row.v : fallback;
}

function setSetting(k, v) {
  stmt.upsertSetting.run(k, String(v));
}

function audit(event, {keyId = null, deviceId = null, adminId = null, ip = null, details = null} = {}) {
  stmt.insertAudit.run(
    Date.now(),
    event,
    keyId,
    deviceId,
    adminId,
    ip,
    details ? JSON.stringify(details) : null,
  );
}

module.exports = {db, stmt, getSetting, setSetting, audit, DATA_DIR};
