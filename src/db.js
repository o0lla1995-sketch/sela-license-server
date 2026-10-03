/**
 * db.js — SQLite storage (better-sqlite3, file under DATA_DIR).
 * ─────────────────────────────────────────────────────────────────
 * ALL prepared statements are created ONCE at module load — per-request
 * db.prepare() would leak Statement objects whose native finalizers can
 * crash under GC on newer Node versions, and it's slower anyway.
 *
 * Tables:
 *  keys         — activation keys the owner creates/sells
 *  activations  — device ↔ key bindings with their expiry
 *  settings     — key/value (contact info etc.)
 *  audit        — every security-relevant event
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

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  event   TEXT NOT NULL,
  key_id  INTEGER,
  device_id TEXT,
  ip      TEXT,
  details TEXT
);
`);

// ── cached statements ────────────────────────────────────────────

const stmt = {
  getSetting: db.prepare('SELECT v FROM settings WHERE k = ?'),
  upsertSetting: db.prepare(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ),
  insertAudit: db.prepare(
    'INSERT INTO audit (ts, event, key_id, device_id, ip, details) VALUES (?, ?, ?, ?, ?, ?)',
  ),

  keyByHash: db.prepare('SELECT * FROM keys WHERE key_hash = ?'),
  keyById: db.prepare('SELECT * FROM keys WHERE id = ?'),
  insertKey: db.prepare(
    `INSERT INTO keys (key_plain, key_hash, plan_days, max_devices, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ),
  listKeys: db.prepare(
    `SELECT k.id, k.key_plain, k.plan_days, k.max_devices, k.note,
            k.created_at, k.revoked_at,
            (SELECT COUNT(*) FROM activations a
              WHERE a.key_id = k.id AND a.unbound_at IS NULL) AS active_devices,
            (SELECT MAX(a.expires_at) FROM activations a
              WHERE a.key_id = k.id AND a.unbound_at IS NULL) AS latest_expiry,
            (SELECT MAX(a.last_seen) FROM activations a
              WHERE a.key_id = k.id) AS last_seen
     FROM keys k
     ORDER BY k.id DESC
     LIMIT 500`,
  ),
  listBindings: db.prepare(
    `SELECT id, device_id, device_label, activated_at, expires_at, last_seen, unbound_at
     FROM activations WHERE key_id = ? ORDER BY activated_at DESC`,
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
  recentAudit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),
};

// ── helpers ──────────────────────────────────────────────────────

function getSetting(k, fallback) {
  const row = stmt.getSetting.get(k);
  return row ? row.v : fallback;
}

function setSetting(k, v) {
  stmt.upsertSetting.run(k, String(v));
}

function audit(event, {keyId = null, deviceId = null, ip = null, details = null} = {}) {
  stmt.insertAudit.run(
    Date.now(),
    event,
    keyId,
    deviceId,
    ip,
    details ? JSON.stringify(details) : null,
  );
}

module.exports = {db, stmt, getSetting, setSetting, audit, DATA_DIR};
