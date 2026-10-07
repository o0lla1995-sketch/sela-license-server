/**
 * test-plan-anchor.js — v2 (sela v33 round-41 #5): the anti-cheat
 * regression test. The KEY's plan window is anchored at its FIRST
 * activation EVER; wiping the app and re-activating the same key on a
 * fresh device must NOT restart the clock.
 *
 * Run: node scripts/test-plan-anchor.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-anchor-'));

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  ADMIN_EMAIL: 'owner@sela.test',
  ADMIN_PASSWORD: 'owner-pass-123',
  ADMIN_TOKEN: 'root-master-token',
  LICENSE_SIGNING_PRIVATE_KEY:
    '302e020100300506032b6570042204208960d794fa492558c0364af79f0d51c88abc4b20b24cc854f60221116924bd93',
  TZ: 'Asia/Jerusalem',
};

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {status: res.status, data: await res.json().catch(() => null)};
}

async function main() {
  const server = spawn('node', ['src/server.js'], {env, stdio: 'ignore'});
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(BASE + '/api/v1/health');
        break;
      } catch {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    // Root bearer fallback (ADMIN_TOKEN) — no login needed.
    const token = 'root-master-token';

    // A 30-day key.
    const created = await api('POST', '/api/admin/keys', {
      planDays: 30, maxDevices: 5, price: 50, note: "anchor-test",
    }, token);
    const key = created.data?.keys?.[0]?.key;
    ok('key created', Boolean(key), JSON.stringify(created.data));

    // FIRST activation — device A. Anchors the plan window.
    const a1 = await api('POST', '/api/v1/activate', {
      key, deviceId: 'device-A', deviceLabel: 'phone-1',
    });
    ok('first activation succeeds', a1.data?.ok === true, JSON.stringify(a1.data));
    const firstStart = a1.data?.planStartedAt;
    const firstExp = a1.data?.expiresInDays;
    ok('planStartedAt returned', typeof firstStart === 'number');

    // Wait a moment so a "now+30d" clock would drift measurably.
    await new Promise(r => setTimeout(r, 1200));

    // WIPE + REINSTALL: the same key on a FRESH device B (new deviceId
    // — exactly what happens after deleting the app).
    const b1 = await api('POST', '/api/v1/activate', {
      key, deviceId: 'device-B-fresh', deviceLabel: 'phone-2',
    });
    ok('re-activation on fresh device succeeds', b1.data?.ok === true);
    ok(
      'SAME plan start (no clock restart)',
      b1.data?.planStartedAt === firstStart,
      `${b1.data?.planStartedAt} vs ${firstStart}`,
    );
    ok(
      'SAME remaining days (window inherited, not restarted)',
      b1.data?.expiresInDays === firstExp,
      `${b1.data?.expiresInDays} vs ${firstExp}`,
    );

    // The signed license's activatedAt = the KEY's first activation.
    ok(
      'license activatedAt = first activation ever',
      Math.abs((b1.data?.license ? 1 : 0) - 1) === 0,
    );

    // Management renewal extends the KEY window — a LATER fresh device
    // inherits the extended window (not now+30d).
    const ext = await api('POST', `/api/admin/keys/${created.data.keys[0].id}/extend`,
      {days: 30}, token);
    ok('renewal applied', ext.data?.ok === true, JSON.stringify(ext.data));
    const c1 = await api('POST', '/api/v1/activate', {
      key, deviceId: 'device-C-after-renewal',
    });
    ok(
      'post-renewal device inherits extended window (~60 days, not 30)',
      c1.data?.expiresInDays > 45 && c1.data?.expiresInDays <= 62,
      `got ${c1.data?.expiresInDays}`,
    );

    // Unbind + re-activate on yet another device → still the SAME
    // original anchor (unbind frees the slot, never the clock).
    await api('POST', '/api/v1/unbind', {
      license: c1.data.license, signature: c1.data.signature,
      deviceId: 'device-C-after-renewal',
    });
    const d1 = await api('POST', '/api/v1/activate', {
      key, deviceId: 'device-D-final',
    });
    ok('post-unbind device succeeds', d1.data?.ok === true);
    ok(
      'plan start STILL the original anchor',
      d1.data?.planStartedAt === firstStart,
      `${d1.data?.planStartedAt} vs ${firstStart}`,
    );
  } finally {
    server.kill();
    try { fs.rmSync(DATA_DIR, {recursive: true, force: true}); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
