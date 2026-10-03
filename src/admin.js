/**
 * admin.js — owner-only API behind ADMIN_TOKEN (Bearer).
 * ─────────────────────────────────────────────────────────────────
 *  POST   /api/admin/keys              create 1..N keys {planDays, maxDevices, note, count}
 *  GET    /api/admin/keys              list keys + bindings (status filter)
 *  GET    /api/admin/keys/:id          key detail + device bindings
 *  POST   /api/admin/keys/:id/extend   {days} extend active bindings
 *  POST   /api/admin/keys/:id/revoke   stop the key everywhere
 *  POST   /api/admin/keys/:id/restore  undo a revoke
 *  POST   /api/admin/keys/:id/unbind   {deviceId} free one device slot
 *  GET    /api/admin/stats             dashboard counters
 *  GET    /api/admin/audit             last audit events
 *  GET    /api/admin/config            contact info
 *  PUT    /api/admin/config            update contact info
 */
'use strict';

const express = require('express');
const {stmt, getSetting, setSetting, audit} = require('./db');
const {generateActivationKey, hashKey} = require('./crypto');
const {contactPayload} = require('./routes');

function buildAdminRouter(requireAdmin) {
  const router = express.Router();
  router.use(requireAdmin);

  const DAY_MS = 24 * 3600 * 1000;

  // ── create keys ────────────────────────────────────────────────

  router.post('/keys', (req, res) => {
    const {planDays, maxDevices, note, count} = req.body || {};
    const days = Number(planDays);
    const devices = Math.max(1, Math.min(10, Number(maxDevices) || 1));
    const n = Math.max(1, Math.min(50, Number(count) || 1));

    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return res.status(400).json({ok: false, error: 'BAD_PLAN_DAYS'});
    }

    const created = [];
    const run = db_transaction(() => {
      for (let i = 0; i < n; i++) {
        const key = generateActivationKey();
        const info = stmt.insertKey.run(
          key,
          hashKey(key),
          days,
          devices,
          String(note || '').slice(0, 200),
          Date.now(),
        );
        created.push({
          id: Number(info.lastInsertRowid),
          key,
          planDays: days,
          maxDevices: devices,
        });
      }
    });
    run();
    audit('admin_create_keys', {details: {count: n, days, devices, note}});
    res.json({ok: true, keys: created});
  });

  function db_transaction(fn) {
    // Runs inside a single SQLite transaction.
    const {db} = require('./db');
    return db.transaction(fn);
  }

  // ── list keys ──────────────────────────────────────────────────

  router.get('/keys', (req, res) => {
    const status = String(req.query.status || 'all');
    const now = Date.now();

    const rows = stmt.listKeys.all();
    const enriched = rows.map(r => ({
      ...r,
      status: r.revoked_at
        ? 'revoked'
        : r.latest_expiry && r.latest_expiry > now
        ? 'active'
        : r.latest_expiry
        ? 'expired'
        : 'unused',
    }));

    const filtered =
      status === 'all' ? enriched : enriched.filter(k => k.status === status);
    res.json({ok: true, keys: filtered, serverTime: now});
  });

  // ── key bindings detail ────────────────────────────────────────

  router.get('/keys/:id', (req, res) => {
    const id = Number(req.params.id);
    const key = stmt.keyById.get(id);
    if (!key) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const bindings = stmt.listBindings.all(id);
    res.json({ok: true, key, bindings});
  });

  // ── extend ─────────────────────────────────────────────────────

  router.post('/keys/:id/extend', (req, res) => {
    const id = Number(req.params.id);
    const days = Number((req.body || {}).days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return res.status(400).json({ok: false, error: 'BAD_DAYS'});
    }
    const key = stmt.keyById.get(id);
    if (!key) return res.status(404).json({ok: false, error: 'NOT_FOUND'});

    const now = Date.now();
    const result = stmt.extendActiveBindings.run(days * DAY_MS, id, now);
    audit('admin_extend', {keyId: id, details: {days, affected: result.changes}});
    res.json({ok: true, affected: result.changes});
  });

  // ── revoke / restore ───────────────────────────────────────────

  router.post('/keys/:id/revoke', (req, res) => {
    const id = Number(req.params.id);
    const result = stmt.revokeKey.run(Date.now(), id);
    audit('admin_revoke', {keyId: id, details: {changed: result.changes}});
    res.json({ok: true, changed: result.changes > 0});
  });

  router.post('/keys/:id/restore', (req, res) => {
    const id = Number(req.params.id);
    stmt.restoreKey.run(id);
    audit('admin_restore', {keyId: id});
    res.json({ok: true});
  });

  // ── free a device slot ─────────────────────────────────────────

  router.post('/keys/:id/unbind', (req, res) => {
    const id = Number(req.params.id);
    const deviceId = String((req.body || {}).deviceId || '');
    if (!deviceId) {
      return res.status(400).json({ok: false, error: 'BAD_DEVICE'});
    }
    const result = stmt.unbindByKeyDevice.run(Date.now(), id, deviceId);
    audit('admin_unbind', {keyId: id, deviceId});
    res.json({ok: true, freed: result.changes > 0});
  });

  // ── stats ──────────────────────────────────────────────────────

  router.get('/stats', (_req, res) => {
    const now = Date.now();
    res.json({
      ok: true,
      total: stmt.statsTotalKeys.get().n,
      active: stmt.statsActiveKeys.get(now).n,
      devices: stmt.statsActiveDevices.get(now).n,
      revoked: stmt.statsRevokedKeys.get().n,
      expiringSoon: stmt.statsExpiringSoon.get(now, now + 7 * DAY_MS).n,
      serverTime: now,
    });
  });

  // ── audit trail ────────────────────────────────────────────────

  router.get('/audit', (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 100);
    res.json({ok: true, events: stmt.recentAudit.all(limit)});
  });

  // ── contact config ─────────────────────────────────────────────

  router.get('/config', (_req, res) => {
    res.json({ok: true, contact: contactPayload()});
  });

  router.put('/config', (req, res) => {
    const {phone, whatsapp, email, note} = req.body || {};
    if (typeof phone === 'string' && phone.trim()) {
      setSetting('contact_phone', phone.trim());
    }
    if (typeof whatsapp === 'string' && whatsapp.trim()) {
      setSetting('contact_whatsapp', whatsapp.trim());
    }
    if (typeof email === 'string' && email.trim()) {
      setSetting('contact_email', email.trim());
    }
    if (typeof note === 'string' && note.trim()) {
      setSetting('contact_note', note.trim());
    }
    audit('admin_update_config');
    res.json({ok: true, contact: contactPayload()});
  });

  return router;
}

module.exports = {buildAdminRouter};
