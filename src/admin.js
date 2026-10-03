/**
 * admin.js — owner panel API (session or root-token auth).
 * ─────────────────────────────────────────────────────────────────
 *  Keys:
 *   POST /api/admin/keys              create 1..N keys {planDays, maxDevices, price, note, count}
 *   GET  /api/admin/keys              list (status filter + search)
 *   GET  /api/admin/keys/:id          key detail + bindings + payments
 *   POST /api/admin/keys/:id/extend   {days, amount?, method?, note?}
 *   POST /api/admin/keys/:id/revoke   stop the key everywhere
 *   POST /api/admin/keys/:id/restore  undo a revoke
 *   POST /api/admin/keys/:id/unbind   {deviceId} free one device slot
 *   POST /api/admin/keys/:id/pay      {amount?, method, note} mark (partially) paid
 *  Payments ledger:
 *   GET  /api/admin/payments          recent payments
 *   POST /api/admin/payments          {keyId?, amount, method, note}
 *   POST /api/admin/payments/:id/delete
 *  Stats:
 *   GET  /api/admin/stats             dashboard counters + revenue KPIs
 *   GET  /api/admin/analytics         chart series (revenue, activations…)
 *  Misc:
 *   GET  /api/admin/audit             audit trail
 *   GET  /api/admin/config            contact + pricing settings
 *   PUT  /api/admin/config            update them
 */
'use strict';

const express = require('express');
const {db, stmt, getSetting, setSetting, audit} = require('./db');
const {generateActivationKey, hashKey} = require('./crypto');
const {contactPayload} = require('./routes');

const DAY_MS = 24 * 3600 * 1000;

function planPriceFromSettings(days) {
  if (days <= 7) return Number(getSetting('price_trial', '0')) || 0;
  if (days <= 30) return Number(getSetting('price_monthly', '50')) || 0;
  if (days <= 90) return Number(getSetting('price_quarterly', '120')) || 0;
  return Number(getSetting('price_yearly', '400')) || 0;
}

function planLabel(days) {
  if (days >= 300) return 'سنوي';
  if (days >= 90) return 'ربع سنوي';
  if (days >= 30) return 'شهري';
  if (days <= 7) return 'تجريبي';
  return days + ' يوم';
}

function keyPaymentStatus(key) {
  if (key.price <= 0) return 'free';
  if (key.paid_sum >= key.price - 0.001) return 'paid';
  if (key.paid_sum > 0) return 'partial';
  return 'unpaid';
}

function buildAdminRouter() {
  const router = express.Router();

  // ── create keys ────────────────────────────────────────────────

  router.post('/keys', (req, res) => {
    const {planDays, maxDevices, note, count, price} = req.body || {};
    const days = Number(planDays);
    const devices = Math.max(1, Math.min(10, Number(maxDevices) || 1));
    const n = Math.max(1, Math.min(50, Number(count) || 1));

    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return res.status(400).json({ok: false, error: 'BAD_PLAN_DAYS'});
    }
    const keyPrice =
      price === null || price === undefined || price === ''
        ? planPriceFromSettings(days)
        : Math.max(0, Math.min(1000000, Number(price) || 0));

    const created = [];
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const key = generateActivationKey();
        const info = stmt.insertKey.run(
          key,
          hashKey(key),
          days,
          devices,
          keyPrice,
          String(note || '').slice(0, 200),
          Date.now(),
        );
        created.push({
          id: Number(info.lastInsertRowid),
          key,
          planDays: days,
          maxDevices: devices,
          price: keyPrice,
        });
      }
    })();
    audit('admin_create_keys', {
      adminId: req.adminUser.id,
      ip: req.ip,
      details: {count: n, days, devices, price: keyPrice, note},
    });
    res.json({ok: true, keys: created});
  });

  // ── list keys ──────────────────────────────────────────────────

  router.get('/keys', (req, res) => {
    const status = String(req.query.status || 'all');
    const q = String(req.query.q || '').trim();
    const now = Date.now();

    const rows = q
      ? stmt.searchKeys.all(`%${q}%`, `%${q}%`)
      : stmt.listKeys.all();
    const enriched = rows.map(r => ({
      ...r,
      status: r.revoked_at
        ? 'revoked'
        : r.latest_expiry && r.latest_expiry > now
        ? 'active'
        : r.latest_expiry
        ? 'expired'
        : 'unused',
      payStatus: keyPaymentStatus(r),
      planLabel: planLabel(r.plan_days),
    }));

    let filtered =
      status === 'all' ? enriched : enriched.filter(k => k.status === status);
    if (status === 'unpaid') filtered = enriched.filter(k => k.payStatus === 'unpaid' || k.payStatus === 'partial');
    res.json({ok: true, keys: filtered, serverTime: now});
  });

  // ── key detail: bindings + payments ────────────────────────────

  router.get('/keys/:id', (req, res) => {
    const id = Number(req.params.id);
    const key = stmt.keyById.get(id);
    if (!key) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const bindings = stmt.listBindings.all(id);
    const payments = stmt.paymentsForKey.all(id);
    const paidSum = payments.reduce((s, p) => s + p.amount, 0);
    res.json({
      ok: true,
      key: {...key, planLabel: planLabel(key.plan_days)},
      bindings,
      payments,
      paidSum,
      payStatus: keyPaymentStatus({...key, paid_sum: paidSum}),
    });
  });

  // ── extend (renewal) — optionally records the renewal payment ──

  router.post('/keys/:id/extend', (req, res) => {
    const id = Number(req.params.id);
    const {days, amount, method, note} = req.body || {};
    const nDays = Number(days);
    if (!Number.isInteger(nDays) || nDays < 1 || nDays > 3650) {
      return res.status(400).json({ok: false, error: 'BAD_DAYS'});
    }
    const key = stmt.keyById.get(id);
    if (!key) return res.status(404).json({ok: false, error: 'NOT_FOUND'});

    const now = Date.now();
    let affected = 0;
    let paymentId = null;

    db.transaction(() => {
      const result = stmt.extendActiveBindings.run(nDays * DAY_MS, id, now);
      affected = result.changes;
      if (affected > 0 && amount !== undefined && amount !== null && Number(amount) > 0) {
        const info = stmt.insertPayment.run(
          id,
          Math.max(0, Math.min(1000000, Number(amount))),
          String(method || 'cash').slice(0, 20),
          String(note || 'تجديد ' + nDays + ' يوم').slice(0, 200),
          req.adminUser.id,
          now,
        );
        paymentId = Number(info.lastInsertRowid);
      }
    })();

    audit('admin_extend', {
      keyId: id,
      adminId: req.adminUser.id,
      ip: req.ip,
      details: {days: nDays, affected, amount: Number(amount) || 0},
    });
    res.json({ok: true, affected, paymentId});
  });

  // ── revoke / restore ───────────────────────────────────────────

  router.post('/keys/:id/revoke', (req, res) => {
    const id = Number(req.params.id);
    const result = stmt.revokeKey.run(Date.now(), id);
    audit('admin_revoke', {keyId: id, adminId: req.adminUser.id, ip: req.ip, details: {changed: result.changes}});
    res.json({ok: true, changed: result.changes > 0});
  });

  router.post('/keys/:id/restore', (req, res) => {
    const id = Number(req.params.id);
    stmt.restoreKey.run(id);
    audit('admin_restore', {keyId: id, adminId: req.adminUser.id, ip: req.ip});
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
    audit('admin_unbind', {keyId: id, deviceId, adminId: req.adminUser.id, ip: req.ip});
    res.json({ok: true, freed: result.changes > 0});
  });

  // ── mark key paid (defaults to the remaining balance) ──────────

  router.post('/keys/:id/pay', (req, res) => {
    const id = Number(req.params.id);
    const key = stmt.keyById.get(id);
    if (!key) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const {amount, method, note} = req.body || {};

    const paidSum = stmt.paymentsForKey
      .all(id)
      .reduce((s, p) => s + p.amount, 0);
    const remaining = Math.max(0, key.price - paidSum);
    const payAmount =
      amount === undefined || amount === null || amount === ''
        ? remaining
        : Math.max(0, Math.min(1000000, Number(amount) || 0));

    if (payAmount <= 0) {
      return res.status(400).json({ok: false, error: 'NOTHING_TO_PAY'});
    }

    const info = stmt.insertPayment.run(
      id,
      payAmount,
      String(method || 'cash').slice(0, 20),
      String(note || 'دفعة مفتاح ' + key.key_plain).slice(0, 200),
      req.adminUser.id,
      Date.now(),
    );
    audit('admin_payment', {
      keyId: id,
      adminId: req.adminUser.id,
      ip: req.ip,
      details: {amount: payAmount, method},
    });
    res.json({ok: true, paymentId: Number(info.lastInsertRowid), amount: payAmount});
  });

  // ── payments ledger ────────────────────────────────────────────

  router.get('/payments', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const rows = stmt.listPayments.all(limit);
    res.json({ok: true, payments: rows});
  });

  router.post('/payments', (req, res) => {
    const {keyId, amount, method, note} = req.body || {};
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1000000) {
      return res.status(400).json({ok: false, error: 'BAD_AMOUNT'});
    }
    let validKey = null;
    if (keyId !== undefined && keyId !== null && keyId !== '') {
      validKey = stmt.keyById.get(Number(keyId));
      if (!validKey) return res.status(404).json({ok: false, error: 'KEY_NOT_FOUND'});
    }
    const info = stmt.insertPayment.run(
      validKey ? validKey.id : null,
      amt,
      String(method || 'cash').slice(0, 20),
      String(note || '').slice(0, 200),
      req.adminUser.id,
      Date.now(),
    );
    audit('admin_payment', {
      keyId: validKey ? validKey.id : null,
      adminId: req.adminUser.id,
      ip: req.ip,
      details: {amount: amt, method, manual: true},
    });
    res.json({ok: true, id: Number(info.lastInsertRowid)});
  });

  router.post('/payments/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const row = stmt.paymentById.get(id);
    if (!row) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    stmt.deletePayment.run(id);
    audit('admin_payment_deleted', {
      keyId: row.key_id,
      adminId: req.adminUser.id,
      ip: req.ip,
      details: {amount: row.amount},
    });
    res.json({ok: true});
  });

  // ── dashboard stats + revenue KPIs ─────────────────────────────

  router.get('/stats', (_req, res) => {
    const now = Date.now();
    const monthStart = new Date(
      new Date(now).getFullYear(),
      new Date(now).getMonth(), 1,
    ).getTime();

    // MRR estimate: every active binding contributes price/plan_days*30.
    let mrr = 0;
    for (const row of stmt.mrrRows.all(now)) {
      if (row.plan_days > 0 && row.price > 0) {
        mrr += (row.price / row.plan_days) * 30;
      }
    }

    res.json({
      ok: true,
      total: stmt.statsTotalKeys.get().n,
      active: stmt.statsActiveKeys.get(now).n,
      devices: stmt.statsActiveDevices.get(now).n,
      revoked: stmt.statsRevokedKeys.get().n,
      unused: stmt.statsUnusedKeys.get().n,
      unpaid: stmt.statsUnpaidKeys.get().n,
      expiringSoon: stmt.statsExpiringSoon.get(now, now + 7 * DAY_MS).n,
      revenue: {
        total: stmt.revenueTotal.get().total,
        thisMonth: stmt.revenueSince.get(monthStart).total,
        last30d: stmt.revenueSince.get(now - 30 * DAY_MS).total,
        mrr: Math.round(mrr * 10) / 10,
      },
      serverTime: now,
    });
  });

  // ── analytics series for charts ────────────────────────────────

  router.get('/analytics', (req, res) => {
    const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
    const now = Date.now();
    const from = now - days * DAY_MS;

    const revenueByMonth = stmt.revenueByMonth.all(now - 365 * DAY_MS);
    const activations = stmt.activationsByDay.all(from);

    // Build a continuous day series (fill gaps with 0).
    const byDay = new Map(activations.map(r => [r.d, r.n]));
    const activationSeries = [];
    const d = new Date(from);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() <= now) {
      const key = d.toISOString().slice(0, 10);
      activationSeries.push({
        d: key,
        n: byDay.get(key) || 0,
      });
      d.setDate(d.getDate() + 1);
    }

    // Plan distribution across active bindings.
    const planDist = stmt.planDistribution.all(now).map(r => ({
      planDays: r.plan_days,
      label: planLabel(r.plan_days),
      count: r.n,
      value: r.value,
    }));

    res.json({
      ok: true,
      activationSeries,
      revenueByMonth,
      planDistribution: planDist,
      deviceActivity: {
        seen24h: stmt.deviceSeenSince.get(now - DAY_MS).n,
        seen7d: stmt.deviceSeenSince.get(now - 7 * DAY_MS).n,
        seen30d: stmt.deviceSeenSince.get(now - 30 * DAY_MS).n,
      },
      expiringSoon: stmt.expiringList.all(now, now + 14 * DAY_MS),
      recentPayments: stmt.listPayments.all(10),
    });
  });

  // ── audit trail ────────────────────────────────────────────────

  router.get('/audit', (req, res) => {
    const limit = Math.min(300, Number(req.query.limit) || 100);
    const event = String(req.query.event || '');
    let rows = stmt.recentAudit.all(limit);
    if (event) rows = rows.filter(r => r.event === event);
    res.json({ok: true, events: rows});
  });

  // ── contact + pricing config ───────────────────────────────────

  router.get('/config', (_req, res) => {
    res.json({
      ok: true,
      contact: contactPayload(),
      currency: getSetting('currency', '₪'),
      pricing: {
        trial: Number(getSetting('price_trial', '0')),
        monthly: Number(getSetting('price_monthly', '50')),
        quarterly: Number(getSetting('price_quarterly', '120')),
        yearly: Number(getSetting('price_yearly', '400')),
      },
    });
  });

  router.put('/config', (req, res) => {
    const {phone, whatsapp, telegram, email, note, currency, pricing} =
      req.body || {};

    if (typeof phone === 'string') setSetting('contact_phone', phone.trim());
    if (typeof whatsapp === 'string') setSetting('contact_whatsapp', whatsapp.trim());
    if (typeof telegram === 'string') setSetting('contact_telegram', telegram.trim());
    if (typeof email === 'string') setSetting('contact_email', email.trim());
    if (typeof note === 'string') setSetting('contact_note', note.trim());
    if (typeof currency === 'string' && currency.trim()) {
      setSetting('currency', currency.trim().slice(0, 6));
    }
    if (pricing && typeof pricing === 'object') {
      for (const k of ['trial', 'monthly', 'quarterly', 'yearly']) {
        if (pricing[k] !== undefined && Number.isFinite(Number(pricing[k]))) {
          setSetting('price_' + k, String(Math.max(0, Number(pricing[k]))));
        }
      }
    }
    audit('admin_update_config', {adminId: req.adminUser.id, ip: req.ip});
    res.json({ok: true, contact: contactPayload()});
  });

  return router;
}

module.exports = {buildAdminRouter, planPriceFromSettings, planLabel};
