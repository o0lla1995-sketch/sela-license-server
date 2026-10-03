/**
 * crypto.js — Ed25519 license signing + activation-key generation.
 * ─────────────────────────────────────────────────────────────────
 * The PRIVATE key lives in the LICENSE_SIGNING_PRIVATE_KEY env var
 * (PKCS8 DER hex). Licenses are signed server-side only; the app
 * verifies them with the baked-in PUBLIC key, so a merchant cannot
 * forge a license even with full access to the phone's storage.
 *
 * If the env var is missing the server generates a fresh pair on
 * first boot and persists it under DATA_DIR — but licenses signed
 * with that pair will NOT verify on the released app builds, so
 * production deployments MUST set the env var.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {DATA_DIR} = require('./db');

const DEFAULT_PRIVATE_HEX =
  '302e020100300506032b6570042204208960d794fa492558c0364af79f0d51c88abc4b20b24cc854f60221116924bd93';

function loadPrivateKey() {
  const envHex = (process.env.LICENSE_SIGNING_PRIVATE_KEY || '').trim();
  const candidates = [envHex];
  if (envHex.length === 0) {
    // Persisted auto-generated key (dev convenience).
    const persistedPath = path.join(DATA_DIR, 'license_private_key.hex');
    if (fs.existsSync(persistedPath)) {
      candidates.push(fs.readFileSync(persistedPath, 'utf8').trim());
    }
  }
  for (const hex of candidates) {
    if (!hex) continue;
    try {
      const key = crypto.createPrivateKey({
        key: Buffer.from(hex, 'hex'),
        format: 'der',
        type: 'pkcs8',
      });
      if (key.asymmetricKeyType === 'ed25519') return key;
    } catch (_) {
      // Try next candidate.
    }
  }
  // Auto-generate (dev only — see header comment).
  const {privateKey} = crypto.generateKeyPairSync('ed25519');
  const hex = privateKey
    .export({type: 'pkcs8', format: 'der'})
    .toString('hex');
  fs.writeFileSync(path.join(DATA_DIR, 'license_private_key.hex'), hex);
  console.warn(
    '[sela-license] WARNING: LICENSE_SIGNING_PRIVATE_KEY is not set. ' +
      'Generated a new key pair — licenses it signs will NOT verify on ' +
      'released sela app builds. Set the env var from .env.example.',
  );
  return privateKey;
}

const privateKey = loadPrivateKey();
const publicKey = crypto.createPublicKey(privateKey);

/** Raw 32-byte public key hex (what the app embeds). */
const PUBLIC_KEY_RAW_HEX = publicKey
  .export({type: 'spki', format: 'der'})
  .toString('hex')
  .slice(-64);

/** Signs a payload string → { license, signature } base64 pair. */
function signLicensePayload(payloadObject) {
  // Canonical serialization: fixed key order, no spaces.
  const json = canonicalJson(payloadObject);
  const sig = crypto.sign(null, Buffer.from(json, 'utf8'), privateKey);
  return {
    license: Buffer.from(json, 'utf8').toString('base64'),
    signature: sig.toString('base64'),
  };
}

function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

/** Verifies a base64 payload+signature pair (used for heartbeat). */
function verifyLicensePair(licenseB64, signatureB64) {
  try {
    const payload = Buffer.from(licenseB64, 'base64');
    const sig = Buffer.from(signatureB64, 'base64');
    const ok = crypto.verify(null, payload, publicKey, sig);
    if (!ok) return null;
    return JSON.parse(payload.toString('utf8'));
  } catch (_) {
    return null;
  }
}

// ── Activation key generation ────────────────────────────────────
// SELA-XXXXX-XXXXX-XXX — Crockford base32 (no 0/O/1/I/L/U).

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomKeyPart(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function generateActivationKey() {
  return `SELA-${randomKeyPart(5)}-${randomKeyPart(5)}-${randomKeyPart(3)}`;
}

function hashKey(plainKey) {
  return crypto.createHash('sha256').update(plainKey).digest('hex');
}

module.exports = {
  signLicensePayload,
  verifyLicensePair,
  generateActivationKey,
  hashKey,
  PUBLIC_KEY_RAW_HEX,
};
