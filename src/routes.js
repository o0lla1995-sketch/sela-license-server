/**
 * routes.js — public license API used by the sela Android app.
 * ─────────────────────────────────────────────────────────────────
 *  POST /api/v1/activate  — bind a key to this device, get a signed license
 *  POST /api/v1/heartbeat — periodic verification (revocation/expiry/extension)
 *  POST /api/v1/unbind    — free this device's slot
 *  GET  /api/v1/time      — trusted server time
 *  GET  /api/v1/pubkey    — the signing public key (hex)
 *  GET  /api/v1/config    — contact info + plans
 *  GET  /api/v1/health    — liveness probe
 *
 * All statements are the cached ones from db.js.
 */
'use strict';

const express = require('express');
const {stmt, getSetting, audit} = require('./db');
const {
  signLicensePayload,
  verifyLicensePair,
  hashKey,
  PUBLIC_KEY_RAW_HEX,
} = require('./crypto');

const DAY_MS = 24 * 3600 * 1000;

function contactPayload() {
  return {
    phone: getSetting('contact_phone', process.env.CONTACT_PHONE || ''),
    whatsapp: getSetting('contact_whatsapp', process.env.CONTACT_WHATSAPP || ''),
    telegram: getSetting('contact_telegram', process.env.CONTACT_TELEGRAM || ''),
    email: getSetting('contact_email', process.env.CONTACT_EMAIL || ''),
    note: getSetting('contact_note', process.env.CONTACT_NOTE || ''),
  };
}

function buildRouter() {
  const router = express.Router();

  function respondError(res, httpStatus, code) {
    res.status(httpStatus).json({ok: false, error: code});
  }

  // ── health ─────────────────────────────────────────────────────

  router.get('/health', (_req, res) => {
    res.json({ok: true, service: 'sela-license', serverTime: Date.now()});
  });

  // ── trusted time + pubkey + config ─────────────────────────────

  router.get('/time', (_req, res) => {
    res.json({ok: true, serverTime: Date.now()});
  });

  router.get('/pubkey', (_req, res) => {
    res.json({ok: true, publicKey: PUBLIC_KEY_RAW_HEX});
  });

  router.get('/config', (_req, res) => {
    const currency = getSetting('currency', '₪');
    res.json({
      ok: true,
      contact: contactPayload(),
      currency,
      plans: [
        {id: 'trial', days: 7, label: 'تجريبي', price: Number(getSetting('price_trial', '0'))},
        {id: 'monthly', days: 30, label: 'شهري', price: Number(getSetting('price_monthly', '50'))},
        {id: 'quarterly', days: 90, label: 'ربع سنوي', price: Number(getSetting('price_quarterly', '120'))},
        {id: 'yearly', days: 365, label: 'سنوي', price: Number(getSetting('price_yearly', '400'))},
      ],
    });
  });

  // ── activate ───────────────────────────────────────────────────

  router.post('/activate', (req, res) => {
    const ip = req.ip;
    const {key, deviceId, deviceLabel, appVersion} = req.body || {};

    if (
      typeof key !== 'string' ||
      !/^SELA-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{3}$/.test(key) ||
      typeof deviceId !== 'string' ||
      deviceId.length < 4 ||
      deviceId.length > 128
    ) {
      return respondError(res, 404, 'INVALID_KEY');
    }

    const keyRow = stmt.keyByHash.get(hashKey(key));
    if (!keyRow) {
      audit('activate_invalid_key', {ip, deviceId});
      return respondError(res, 404, 'INVALID_KEY');
    }
    if (keyRow.revoked_at) {
      audit('activate_revoked_key', {keyId: keyRow.id, deviceId, ip});
      return respondError(res, 403, 'KEY_REVOKED');
    }

    const now = Date.now();
    let binding = stmt.bindingByKeyDevice.get(keyRow.id, deviceId);

    if (!binding) {
      const count = stmt.countActiveBindings.get(keyRow.id).n;
      if (count >= keyRow.max_devices) {
        audit('activate_device_limit', {keyId: keyRow.id, deviceId, ip});
        return respondError(res, 403, 'DEVICE_LIMIT');
      }
      const expiresAt = now + keyRow.plan_days * DAY_MS;
      stmt.insertBinding.run(
        keyRow.id,
        deviceId,
        String(deviceLabel || '').slice(0, 120),
        now,
        expiresAt,
        now,
      );
      binding = stmt.bindingByKeyDevice.get(keyRow.id, deviceId);
      audit('activate_new_device', {
        keyId: keyRow.id,
        deviceId,
        ip,
        details: {expiresAt, appVersion},
      });
    } else {
      // Idempotent re-activation on the same device — keep the
      // ORIGINAL expiry (prevents "re-activate to reset the clock").
      stmt.touchBinding.run(
        now,
        String(deviceLabel || '').slice(0, 120),
        binding.id,
      );
      audit('activate_reactivation', {keyId: keyRow.id, deviceId, ip});
    }

    if (binding.expires_at <= now) {
      audit('activate_expired', {keyId: keyRow.id, deviceId, ip});
      return respondError(res, 403, 'KEY_EXPIRED');
    }

    const plan = keyRow.plan_days >= 300 ? 'yearly' : 'monthly';
    const payload = {
      v: 1,
      keyId: keyRow.id,
      plan,
      deviceId,
      activatedAt: binding.activated_at,
      expiresAt: binding.expires_at,
    };
    const {license, signature} = signLicensePayload(payload);
    res.json({
      ok: true,
      license,
      signature,
      serverTime: now,
      expiresInDays: Math.ceil((binding.expires_at - now) / DAY_MS),
      contact: contactPayload(),
    });
  });

  // ── heartbeat ──────────────────────────────────────────────────

  router.post('/heartbeat', (req, res) => {
    const ip = req.ip;
    const {license, signature, deviceId, deviceTime} = req.body || {};

    if (
      typeof license !== 'string' ||
      typeof signature !== 'string' ||
      typeof deviceId !== 'string'
    ) {
      return respondError(res, 400, 'INVALID_LICENSE');
    }

    const payload = verifyLicensePair(license, signature);
    if (!payload || payload.deviceId !== deviceId) {
      audit('heartbeat_bad_signature', {deviceId, ip});
      return respondError(res, 403, 'INVALID_LICENSE');
    }

    const now = Date.now();
    const binding = stmt.bindingByKeyDevice.get(payload.keyId, deviceId);

    if (!binding) {
      audit('heartbeat_unknown_device', {keyId: payload.keyId, deviceId, ip});
      return res.json({
        ok: true,
        status: 'unknown_device',
        serverTime: now,
        expiresAt: payload.expiresAt,
        contact: contactPayload(),
      });
    }

    stmt.heartbeatBinding.run(
      now,
      typeof deviceTime === 'number' ? deviceTime : null,
      binding.id,
    );

    const keyRow = stmt.keyById.get(payload.keyId);
    if (keyRow && keyRow.revoked_at) {
      audit('heartbeat_revoked', {keyId: payload.keyId, deviceId, ip});
      return res.json({
        ok: true,
        status: 'revoked',
        serverTime: now,
        expiresAt: binding.expires_at,
        contact: contactPayload(),
      });
    }

    if (binding.expires_at <= now) {
      audit('heartbeat_expired', {keyId: payload.keyId, deviceId, ip});
      return res.json({
        ok: true,
        status: 'expired',
        serverTime: now,
        expiresAt: binding.expires_at,
        contact: contactPayload(),
      });
    }

    // Clock-tamper audit: device time far behind the server after a
    // previous sighting → someone may be rolling the clock back.
    if (
      typeof deviceTime === 'number' &&
      binding.last_device_time &&
      deviceTime < binding.last_device_time - 24 * 3600 * 1000
    ) {
      audit('heartbeat_clock_rollback_suspected', {
        keyId: payload.keyId,
        deviceId,
        ip,
        details: {deviceTime, lastDeviceTime: binding.last_device_time},
      });
    }

    // Renewed license if the binding expiry changed since the signed
    // payload was issued (management extended the subscription).
    if (binding.expires_at !== payload.expiresAt) {
      const renewed = {
        v: 1,
        keyId: payload.keyId,
        plan: payload.plan,
        deviceId,
        activatedAt: binding.activated_at,
        expiresAt: binding.expires_at,
      };
      const signed = signLicensePayload(renewed);
      return res.json({
        ok: true,
        status: 'active',
        serverTime: now,
        expiresAt: binding.expires_at,
        contact: contactPayload(),
        ...signed,
      });
    }

    res.json({
      ok: true,
      status: 'active',
      serverTime: now,
      expiresAt: binding.expires_at,
      contact: contactPayload(),
    });
  });

  // ── unbind ─────────────────────────────────────────────────────

  router.post('/unbind', (req, res) => {
    const ip = req.ip;
    const {license, signature, deviceId} = req.body || {};
    const payload =
      typeof license === 'string' && typeof signature === 'string'
        ? verifyLicensePair(license, signature)
        : null;
    if (!payload || payload.deviceId !== deviceId) {
      return respondError(res, 403, 'INVALID_LICENSE');
    }
    const result = stmt.unbindByKeyDevice.run(
      Date.now(),
      payload.keyId,
      deviceId,
    );
    audit('unbind', {
      keyId: payload.keyId,
      deviceId,
      ip,
      details: {freed: result.changes},
    });
    res.json({ok: true, freed: result.changes > 0});
  });

  return router;
}

module.exports = {buildRouter, contactPayload};
