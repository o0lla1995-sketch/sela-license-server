/**
 * server.js — sela license server entry point (v3).
 * ─────────────────────────────────────────────────────────────────
 * Zero-config on Coolify: set PORT, DATA_DIR and (optionally)
 * ADMIN_EMAIL / ADMIN_PASSWORD for the first panel account, plus
 * LICENSE_SIGNING_PRIVATE_KEY (see .env.example), deploy, done.
 *
 * v3 layout:
 *   /                     → public marketing landing page (site/)
 *   /contact              → public contact page
 *   /media/:file          → uploaded screenshots (public)
 *   /api/v1/*             → license API used by the Android app
 *   /api/public/site      → public landing/contact data (no auth)
 *   /api/admin/*          → panel APIs (session/token auth)
 *   /{ADMIN_PATH_SECRET}  → the admin panel itself (SECRET path —
 *                           404 everywhere else, no discovery)
 *
 * ADMIN_PATH_SECRET resolution order:
 *   1) env ADMIN_PATH_SECRET ([A-Za-z0-9_-]{6,64})
 *   2) DB settings key `admin_path_secret` (survives restarts)
 *   3) generated once at first boot, stored in DB + logged
 */
'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const {buildRouter} = require('./routes');
const {buildAdminRouter} = require('./admin');
const {
  buildAuthRouter,
  buildAdminUsersRouter,
  buildRequireAdmin,
  seedOwnerFromEnv,
} = require('./auth');
const {buildSiteAdminRouter, sitePublicPayload, serveMedia} = require('./site');
const {getSetting, setSetting} = require('./db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Coolify reverse proxy → real client IPs.

// ── tiny env loader (avoids an extra dependency) ─────────────────
// Loads .env next to package.json when present (local dev only).
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
} catch (_) {
  // .env is optional.
}

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Seed the first owner account (email + password) if none exists.
seedOwnerFromEnv();

// ── resolve the secret admin path ─────────────────────────────────
const PATH_RE = /^[a-zA-Z0-9_-]{6,64}$/;
function resolveAdminPath() {
  const fromEnv = String(process.env.ADMIN_PATH_SECRET || '').trim();
  if (PATH_RE.test(fromEnv)) return fromEnv;

  const stored = getSetting('admin_path_secret', '');
  if (PATH_RE.test(stored)) return stored;

  const generated = 'sela-' + crypto.randomBytes(6).toString('hex');
  setSetting('admin_path_secret', generated);
  console.log(
    '[sela-license] ADMIN_PATH_SECRET not set — generated a secret panel path ' +
      '(set ADMIN_PATH_SECRET in the environment to choose your own).',
  );
  return generated;
}
const ADMIN_PATH = resolveAdminPath();

// ── body parsers: big limit only for screenshot uploads ───────────
const jsonBig = express.json({limit: '14mb'});
const jsonSmall = express.json({limit: '64kb'});
app.use('/api/admin/media', jsonBig); // base64 screenshots land here
app.use('/api', jsonSmall);

// Security headers for the panel.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ── per-IP rate limiting (sliding window, in-memory) ─────────────
const RATE_LIMIT = 120; // requests
const RATE_WINDOW_MS = 60 * 1000; // per minute
const hits = new Map();

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, arr] of hits) {
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (arr.length === 0) hits.delete(ip);
  }
}, 30 * 1000).unref();

app.use('/api', (req, res, next) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let arr = hits.get(ip);
  if (!arr) {
    arr = [];
    hits.set(ip, arr);
  }
  while (arr.length && arr[0] < now - RATE_WINDOW_MS) arr.shift();
  if (arr.length >= RATE_LIMIT) {
    return res.status(429).json({ok: false, error: 'RATE_LIMITED'});
  }
  arr.push(now);
  next();
});

// ── static dirs ───────────────────────────────────────────────────
const SITE_DIR = path.join(__dirname, 'site');   // public marketing site
const PANEL_DIR = path.join(__dirname, 'panel'); // admin SPA (secret path)

const noStoreHtml = (res, filePath) => {
  if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store');
  }
};

// ── 1) license API used by the Android app ────────────────────────
app.use('/api/v1', buildRouter());

// ── 2) public site data (landing + contact) ───────────────────────
app.get('/api/public/site', (_req, res) => {
  res.json(sitePublicPayload());
});

// ── 3) admin APIs (auth) ──────────────────────────────────────────
const requireAdmin = buildRequireAdmin(ADMIN_TOKEN);
app.use('/api/admin/auth', buildAuthRouter(requireAdmin)); // /login is open inside
app.use('/api/admin', requireAdmin, buildAdminRouter());
app.use('/api/admin', requireAdmin, buildAdminUsersRouter());
app.use('/api/admin', requireAdmin, buildSiteAdminRouter());

// ── 4) uploaded screenshots (public) ──────────────────────────────
app.get('/media/:filename', serveMedia);

// ── 5) the SECRET admin panel — nothing else may expose it ────────
app.use(
  '/' + ADMIN_PATH,
  (req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  },
  express.static(PANEL_DIR, {setHeaders: noStoreHtml}),
);

// ── 6) public marketing pages ─────────────────────────────────────
app.get('/contact', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(SITE_DIR, 'contact.html'));
});
app.use(express.static(SITE_DIR, {setHeaders: noStoreHtml}));

// ── 7) /api 404 (JSON) ────────────────────────────────────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ok: false, error: 'NOT_FOUND'});
});

// ── 8) everything else → plain 404 (nothing is revealed) ──────────
app.use((_req, res) => {
  res.status(404).send(
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>404 — غير موجود</title><style>' +
      'body{font-family:system-ui,sans-serif;background:#141418;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;min-height:100vh;' +
      'margin:0;text-align:center}div{padding:32px}' +
      'h1{font-size:64px;margin:0 0 8px;color:#F97316}' +
      'p{color:#9ca3af;margin:0}</style></head><body><div>' +
      '<h1>404</h1><p>الصفحة غير موجودة</p></div></body></html>',
  );
});

// Error guard — never crash the process on a bad request.
app.use((error, _req, res, _next) => {
  console.error('[sela-license] request error:', error);
  res.status(500).json({ok: false, error: 'SERVER_ERROR'});
});

const listener = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[sela-license] listening on :${PORT}`);
  console.log(`[sela-license] admin panel path: /${ADMIN_PATH}  ← keep this secret`);
});
if (!ADMIN_TOKEN) {
  console.log(
    '[sela-license] ADMIN_TOKEN not set — root-token auth disabled ' +
      '(panel uses email/password accounts).',
  );
}

module.exports = listener;
