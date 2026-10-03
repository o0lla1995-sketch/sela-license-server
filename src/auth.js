/**
 * auth.js — panel authentication (email + password) and admin accounts.
 * ─────────────────────────────────────────────────────────────────
 *  POST /api/admin/auth/login     {email, password} → {token, user}
 *  POST /api/admin/auth/logout    invalidate current session
 *  GET  /api/admin/auth/me        current user
 *  POST /api/admin/auth/password  {current, next} change own password
 *  GET  /api/admin/admins         list accounts                (owner)
 *  POST /api/admin/admins         create account               (owner)
 *  POST /api/admin/admins/:id     update account / reset pass  (owner)
 *  POST /api/admin/admins/:id/delete                           (owner)
 *
 * Sessions are random 256-bit tokens; only their SHA-256 is stored.
 * ADMIN_TOKEN (if set) still works as a root bearer fallback so the
 * panel/API never locks the owner out.
 */
'use strict';

const express = require('express');
const {stmt, audit} = require('./db');
const {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  sha256Hex,
} = require('./crypto');

const SESSION_TTL_MS = 14 * 24 * 3600 * 1000; // 14 days
const SESSION_REFRESH_THRESHOLD_MS = 7 * 24 * 3600 * 1000;

// ── per-IP login throttling (in-memory sliding window) ───────────
const LOGIN_LIMIT = 10; // attempts
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // per 15 minutes
const loginHits = new Map();

setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [ip, arr] of loginHits) {
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (arr.length === 0) loginHits.delete(ip);
  }
}, 60 * 1000).unref();

function loginThrottled(ip) {
  const arr = loginHits.get(ip) || [];
  const now = Date.now();
  while (arr.length && arr[0] < now - LOGIN_WINDOW_MS) arr.shift();
  return arr.length >= LOGIN_LIMIT;
}
function recordLoginHit(ip) {
  let arr = loginHits.get(ip);
  if (!arr) {
    arr = [];
    loginHits.set(ip, arr);
  }
  arr.push(Date.now());
}

// ── session middleware ───────────────────────────────────────────

function buildRequireAdmin(ADMIN_TOKEN) {
  return function requireAdmin(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    // Root token fallback (master key from env).
    if (ADMIN_TOKEN && token && token.length === ADMIN_TOKEN.length &&
        token === ADMIN_TOKEN) {
      req.adminUser = {id: 0, email: 'root', name: 'Root Token', role: 'owner', tokenAuth: true};
      return next();
    }

    if (!token) {
      return res.status(401).json({ok: false, error: 'UNAUTHORIZED'});
    }

    const row = stmt.sessionByToken.get(sha256Hex(token));
    if (!row || row.expires_at <= Date.now() || row.disabled) {
      return res.status(401).json({ok: false, error: 'SESSION_EXPIRED'});
    }

    // Sliding refresh — extend when less than half the TTL remains.
    const newExpiry = Date.now() + SESSION_TTL_MS;
    if (row.expires_at < Date.now() + SESSION_REFRESH_THRESHOLD_MS) {
      stmt.refreshSession.run(newExpiry, row.token_hash);
    }

    req.adminUser = {
      id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      tokenAuth: false,
    };
    req.sessionTokenHash = row.token_hash;
    next();
  };
}

function requireOwner(req, res, next) {
  if (!req.adminUser || req.adminUser.role !== 'owner') {
    return res.status(403).json({ok: false, error: 'FORBIDDEN'});
  }
  next();
}

// ── first-boot owner seeding ─────────────────────────────────────

function seedOwnerFromEnv() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (stmt.countAdmins.get().n > 0) return;
  if (!email || !password) {
    console.warn(
      '[sela-license] No admin accounts and ADMIN_EMAIL/ADMIN_PASSWORD not set — ' +
      'panel login is unavailable. Set them in the environment.',
    );
    return;
  }
  stmt.insertAdmin.run(
    email,
    'المالك',
    hashPassword(password),
    'owner',
    Date.now(),
  );
  console.log(`[sela-license] Seeded owner account: ${email}`);
}

// ── router ───────────────────────────────────────────────────────

function buildAuthRouter(requireAdmin) {
  const router = express.Router();

  // ── login is open; everything below requires a session ──────
  router.post('/login', (req, res) => {
    const ip = req.ip;
    if (loginThrottled(ip)) {
      audit('login_throttled', {ip});
      return res.status(429).json({ok: false, error: 'TOO_MANY_ATTEMPTS'});
    }

    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const password = String((req.body || {}).password || '');
    recordLoginHit(ip);

    const user = email ? stmt.adminByEmail.get(email) : null;
    if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
      audit('login_failed', {ip, details: {email}});
      return res.status(401).json({ok: false, error: 'BAD_CREDENTIALS'});
    }

    const token = generateSessionToken();
    const now = Date.now();
    stmt.insertSession.run(
      sha256Hex(token),
      user.id,
      now,
      now + SESSION_TTL_MS,
      ip,
      String(req.headers['user-agent'] || '').slice(0, 200),
    );
    stmt.touchAdminLogin.run(now, ip, user.id);
    audit('login_success', {adminId: user.id, ip});

    res.json({
      ok: true,
      token,
      user: {id: user.id, email: user.email, name: user.name, role: user.role},
    });
  });

  // Everything below this line requires a valid session/token.
  router.use(requireAdmin);

  router.post('/logout', (req, res) => {
    if (req.sessionTokenHash) {
      stmt.deleteSession.run(req.sessionTokenHash);
      audit('logout', {adminId: req.adminUser.id, ip: req.ip});
    }
    res.json({ok: true});
  });

  router.get('/me', (req, res) => {
    const u = req.adminUser;
    res.json({ok: true, user: {id: u.id, email: u.email, name: u.name, role: u.role, tokenAuth: !!u.tokenAuth}});
  });

  router.post('/password', (req, res) => {
    const {current, next} = req.body || {};
    if (typeof next !== 'string' || next.length < 6) {
      return res.status(400).json({ok: false, error: 'WEAK_PASSWORD'});
    }
    if (req.adminUser.tokenAuth) {
      // Root-token auth: allow setting a password for the FIRST admin
      // account only when no password-based account exists yet.
      return res.status(400).json({ok: false, error: 'TOKEN_AUTH_NO_PASSWORD'});
    }
    const user = stmt.adminById.get(req.adminUser.id);
    if (!user || !verifyPassword(String(current || ''), user.password_hash)) {
      audit('password_change_failed', {adminId: req.adminUser.id, ip: req.ip});
      return res.status(401).json({ok: false, error: 'BAD_CREDENTIALS'});
    }
    stmt.updateAdmin.run(null, null, null, hashPassword(next), user.id);
    // Revoke all other sessions.
    stmt.deleteSessionsForUser.run(user.id, req.sessionTokenHash || '');
    audit('password_changed', {adminId: user.id, ip: req.ip});
    res.json({ok: true});
  });

  return router;
}

function buildAdminUsersRouter() {
  const router = express.Router();
  router.use(requireOwner);

  router.get('/admins', (_req, res) => {
    res.json({ok: true, admins: stmt.listAdmins.all()});
  });

  router.post('/admins', (req, res) => {
    const {email, name, password, role} = req.body || {};
    const normEmail = String(email || '').trim().toLowerCase();
    const normRole = role === 'owner' ? 'owner' : 'staff';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail)) {
      return res.status(400).json({ok: false, error: 'BAD_EMAIL'});
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ok: false, error: 'WEAK_PASSWORD'});
    }
    if (stmt.adminByEmail.get(normEmail)) {
      return res.status(409).json({ok: false, error: 'EMAIL_EXISTS'});
    }
    const info = stmt.insertAdmin.run(
      normEmail,
      String(name || normEmail).slice(0, 80),
      hashPassword(password),
      normRole,
      Date.now(),
    );
    audit('admin_created', {adminId: req.adminUser.id, ip: req.ip, details: {newId: Number(info.lastInsertRowid), email: normEmail, role: normRole}});
    res.json({ok: true, id: Number(info.lastInsertRowid)});
  });

  router.post('/admins/:id', (req, res) => {
    const id = Number(req.params.id);
    const user = stmt.adminById.get(id);
    if (!user) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const {name, role, disabled, password} = req.body || {};

    const newRole = role === 'owner' || role === 'staff' ? role : null;
    let newDisabled =
      disabled === true ? 1 : disabled === false ? 0 : null;

    // Guard: never disable/demote the last enabled owner.
    if (id === req.adminUser.id && (newDisabled === 1 || (newRole && newRole !== 'owner'))) {
      return res.status(400).json({ok: false, error: 'CANNOT_MODIFY_SELF_ROLE'});
    }
    if ((newDisabled === 1 || (newRole === 'staff' && user.role === 'owner')) &&
        user.role === 'owner' && stmt.countOwners.get().n <= 1) {
      return res.status(400).json({ok: false, error: 'LAST_OWNER'});
    }

    stmt.updateAdmin.run(
      typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : null,
      newRole,
      newDisabled,
      typeof password === 'string' && password.length >= 6 ? hashPassword(password) : null,
      id,
    );
    if (newDisabled === 1) {
      // Kill the disabled user's sessions.
      const {db} = require('./db');
      db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
    }
    audit('admin_updated', {adminId: req.adminUser.id, ip: req.ip, details: {targetId: id, role: newRole, disabled: newDisabled, passwordReset: typeof password === 'string' && password.length >= 6}});
    res.json({ok: true});
  });

  router.post('/admins/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const user = stmt.adminById.get(id);
    if (!user) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    if (id === req.adminUser.id) {
      return res.status(400).json({ok: false, error: 'CANNOT_DELETE_SELF'});
    }
    if (user.role === 'owner' && stmt.countOwners.get().n <= 1) {
      return res.status(400).json({ok: false, error: 'LAST_OWNER'});
    }
    const {db} = require('./db');
    db.transaction(() => {
      db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
    })();
    audit('admin_deleted', {adminId: req.adminUser.id, ip: req.ip, details: {targetId: id, email: user.email}});
    res.json({ok: true});
  });

  return router;
}

module.exports = {
  buildAuthRouter,
  buildAdminUsersRouter,
  buildRequireAdmin,
  seedOwnerFromEnv,
};
