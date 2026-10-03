/**
 * server.js — sela license server entry point.
 * ─────────────────────────────────────────────────────────────────
 * Zero-config on Coolify: set PORT, DATA_DIR and (optionally)
 * ADMIN_EMAIL / ADMIN_PASSWORD for the first panel account, plus
 * LICENSE_SIGNING_PRIVATE_KEY (see .env.example), deploy, done.
 */
'use strict';

const express = require('express');
const path = require('path');
const {buildRouter} = require('./routes');
const {buildAdminRouter} = require('./admin');
const {
  buildAuthRouter,
  buildAdminUsersRouter,
  buildRequireAdmin,
  seedOwnerFromEnv,
} = require('./auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Coolify reverse proxy → real client IPs.

// ── tiny env loader (avoids an extra dependency) ─────────────────
// Loads .env next to package.json when present (local dev only).
try {
  const fs = require('fs');
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

app.use(express.json({limit: '64kb'}));

// Security headers for the panel.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ── per-IP rate limiting (sliding window, in-memory) ─────────────
const RATE_LIMIT = 90; // requests
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

// ── routes ───────────────────────────────────────────────────────

app.use('/api/v1', buildRouter());

const requireAdmin = buildRequireAdmin(ADMIN_TOKEN);
app.use('/api/admin/auth', buildAuthRouter(requireAdmin)); // /login is open inside
app.use('/api/admin', requireAdmin, buildAdminRouter());
app.use('/api/admin', requireAdmin, buildAdminUsersRouter());

// Admin web panel (Arabic RTL SPA).
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }),
);

app.use('/api', (_req, res) => {
  res.status(404).json({ok: false, error: 'NOT_FOUND'});
});

// Error guard — never crash the process on a bad request.
app.use((error, _req, res, _next) => {
  console.error('[sela-license] request error:', error);
  res.status(500).json({ok: false, error: 'SERVER_ERROR'});
});

const listener = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[sela-license] listening on :${PORT}`);
});
if (!ADMIN_TOKEN) {
  console.log(
    '[sela-license] ADMIN_TOKEN not set — root-token auth disabled ' +
      '(panel uses email/password accounts).',
  );
}

module.exports = listener;
