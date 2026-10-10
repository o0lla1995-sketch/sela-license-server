/**
 * test-local.js — end-to-end smoke test for the license server v2.
 * Boots the server on a temp port + temp data dir, then exercises:
 *  auth (login/me/password/admins) · keys (create/list/detail/extend/
 *  revoke/pay) · payments · stats/analytics · contact config ·
 *  public API (activate/heartbeat/unbind).
 *
 * Run: node test-local.js
 */
'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-test-'));

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  ADMIN_EMAIL: 'owner@sela.test',
  ADMIN_PASSWORD: 'owner-pass-123',
  ADMIN_TOKEN: 'root-master-token',
  ADMIN_PATH_SECRET: 'test-secret-panel-1',
  LICENSE_SIGNING_PRIVATE_KEY:
    '302e020100300506032b6570042204208960d794fa492558c0364af79f0d51c88abc4b20b24cc854f60221116924bd93',
  CONTACT_PHONE: '+972 59 111 2222',
  CONTACT_WHATSAPP: '+972 59 111 2222',
  CONTACT_TELEGRAM: '@sela_support',
  TZ: 'Asia/Jerusalem',
};

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

async function req(method, p, {token, body} = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(token ? {Authorization: 'Bearer ' + token} : {}),
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return {status: r.status, data};
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'src', 'server.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write('[srv] ' + d));

  // Wait for the server to come up.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const r = await fetch(BASE + '/api/v1/health');
      up = r.ok;
    } catch (_) {
      await new Promise(r2 => setTimeout(r2, 250));
    }
  }
  if (!up) { console.error('server did not start'); server.kill(); process.exit(1); }

  console.log('— public API —');
  const health = await req('GET', '/api/v1/health');
  ok('health', health.data.ok === true);
  const cfg = await req('GET', '/api/v1/config');
  ok('config has telegram', cfg.data.contact.telegram === '@sela_support');
  ok('config plans have prices', cfg.data.plans.every(p => typeof p.price === 'number'));
  const pk = await req('GET', '/api/v1/pubkey');
  ok('pubkey matches app key',
    pk.data.publicKey === '6ee513c1b7f0b057d970c6c2f4b33e5d026bc4c798b5a0b8bb72818d3197d103');

  console.log('— auth —');
  const badLogin = await req('POST', '/api/admin/auth/login',
    {body: {email: 'owner@sela.test', password: 'wrong'}});
  ok('wrong password rejected', badLogin.status === 401);
  const login = await req('POST', '/api/admin/auth/login',
    {body: {email: 'Owner@Sela.Test', password: 'owner-pass-123'}}); // case-insensitive email
  ok('login ok', login.status === 200 && !!login.data.token);
  const T = login.data.token;
  ok('login returns owner role', login.data.user.role === 'owner');
  const me = await req('GET', '/api/admin/auth/me', {token: T});
  ok('me ok', me.data.user.email === 'owner@sela.test');
  const noAuth = await req('GET', '/api/admin/stats');
  ok('stats without token → 401', noAuth.status === 401);
  const rootStats = await req('GET', '/api/admin/stats', {token: 'root-master-token'});
  ok('root token works', rootStats.status === 200);

  console.log('— keys + payments —');
  const created = await req('POST', '/api/admin/keys', {
    token: T,
    body: {planDays: 30, maxDevices: 2, note: 'محل أبو محمد — الخليل', count: 2},
  });
  ok('create 2 keys', created.data.keys.length === 2);
  ok('default price from settings (50)', created.data.keys[0].price === 50);
  const KEY = created.data.keys[0].key;

  const list = await req('GET', '/api/admin/keys?status=all', {token: T});
  ok('keys listed with payStatus', list.data.keys[0].payStatus === 'unpaid');

  // activate device 1
  const act1 = await req('POST', '/api/v1/activate', {
    body: {key: KEY, deviceId: 'dev-aaa-111', deviceLabel: 'Samsung A54', appVersion: '2.1.0'},
  });
  ok('activate ok + signed', act1.data.ok && !!act1.data.license && !!act1.data.signature);
  ok('contact in activate response', act1.data.contact.telegram === '@sela_support');
  ok('expiresInDays = 30', act1.data.expiresInDays === 30);

  // verify signature matches the app's public key
  const pub = crypto.createPublicKey({
    key: Buffer.from(
      '302a300506032b6570032100' +
      '6ee513c1b7f0b057d970c6c2f4b33e5d026bc4c798b5a0b8bb72818d3197d103',
      'hex'),
    format: 'der', type: 'spki',
  });
  const sigOk = crypto.verify(
    null,
    Buffer.from(act1.data.license, 'base64'),
    pub,
    Buffer.from(act1.data.signature, 'base64'));
  ok('license signature verifies with app key', sigOk);

  const reAct = await req('POST', '/api/v1/activate', {
    body: {key: KEY, deviceId: 'dev-aaa-111'},
  });
  ok('re-activation keeps original expiry',
    reAct.data.expiresAt === act1.data.expiresAt);

  const limit = await req('POST', '/api/v1/activate', {
    body: {key: KEY, deviceId: 'dev-bbb-222'},
  });
  const limit2 = await req('POST', '/api/v1/activate', {
    body: {key: KEY, deviceId: 'dev-ccc-333'},
  });
  ok('device limit enforced (2 max)', limit2.status === 403 && limit2.data.error === 'DEVICE_LIMIT');

  // heartbeat
  const hb = await req('POST', '/api/v1/heartbeat', {
    body: {license: act1.data.license, signature: act1.data.signature,
           deviceId: 'dev-aaa-111', deviceTime: Date.now()},
  });
  ok('heartbeat active', hb.data.status === 'active');

  // mark paid
  const keyId = created.data.keys[0].id;
  const pay = await req('POST', `/api/admin/keys/${keyId}/pay`, {
    token: T, body: {method: 'cash'},
  });
  ok('pay defaults to remaining (50)', pay.data.amount === 50);
  const detail = await req('GET', `/api/admin/keys/${keyId}`, {token: T});
  ok('key now paid', detail.data.payStatus === 'paid');

  // extend with renewal payment
  const ext = await req('POST', `/api/admin/keys/${keyId}/extend`, {
    token: T, body: {days: 30, amount: 50, method: 'cash', note: 'تجديد شهري'},
  });
  ok('extend affected 2 devices', ext.data.affected === 2);
  ok('renewal payment recorded', !!ext.data.paymentId);

  // heartbeat should hand out a renewed license (expiry changed)
  const hb2 = await req('POST', '/api/v1/heartbeat', {
    body: {license: act1.data.license, signature: act1.data.signature,
           deviceId: 'dev-aaa-111', deviceTime: Date.now()},
  });
  ok('heartbeat renews signed license', hb2.data.status === 'active' && !!hb2.data.license);

  console.log('— stats & analytics —');
  const stats = await req('GET', '/api/admin/stats', {token: T});
  ok('stats revenue total = 100', stats.data.revenue.total === 100);
  ok('stats thisMonth = 100', stats.data.revenue.thisMonth === 100);
  ok('stats active = 1', stats.data.active === 1);
  ok('stats devices = 2', stats.data.devices === 2);
  ok('stats MRR = 100 (2 devices × 50/30×30)', stats.data.revenue.mrr === 100);
  const an = await req('GET', '/api/admin/analytics?days=30', {token: T});
  ok('analytics planDistribution has monthly', an.data.planDistribution.some(p => p.label === 'شهري'));
  ok('analytics activationSeries is array', Array.isArray(an.data.activationSeries));
  ok('analytics recentPayments length 2', an.data.recentPayments.length === 2);

  console.log('— admin users —');
  const created2 = await req('POST', '/api/admin/admins', {
    token: T, body: {email: 'staff@sela.test', name: 'موظف', password: 'staff-pass-123', role: 'staff'},
  });
  ok('staff created', created2.status === 200);
  const staffLogin = await req('POST', '/api/admin/auth/login',
    {body: {email: 'staff@sela.test', password: 'staff-pass-123'}});
  const ST = staffLogin.data.token;
  ok('staff can login', !!ST);
  const staffForbidden = await req('GET', '/api/admin/admins', {token: ST});
  ok('staff blocked from admins page', staffForbidden.status === 403);
  const staffKeys = await req('GET', '/api/admin/keys', {token: ST});
  ok('staff can manage keys', staffKeys.status === 200);

  console.log('— contacts & config —');
  const upd = await req('PUT', '/api/admin/config', {
    token: T,
    body: {phone: '+972 59 333 4444', telegram: '@sela_help', whatsapp: '+972 59 333 4444'},
  });
  ok('config update', upd.status === 200 && upd.data.contact.telegram === '@sela_help');
  const cfg2 = await req('GET', '/api/v1/config');
  ok('public config reflects update', cfg2.data.contact.phone === '+972 59 333 4444');

  console.log('— revoke / unbind —');
  const revoke = await req('POST', `/api/admin/keys/${keyId}/revoke`, {token: T});
  ok('revoke ok', revoke.data.changed === true);
  const hb3 = await req('POST', '/api/v1/heartbeat', {
    body: {license: hb2.data.license || act1.data.license,
           signature: hb2.data.signature || act1.data.signature,
           deviceId: 'dev-aaa-111'},
  });
  ok('heartbeat reports revoked', hb3.data.status === 'revoked');
  const restore = await req('POST', `/api/admin/keys/${keyId}/restore`, {token: T});
  ok('restore ok', restore.data.ok === true);
  const unbind = await req('POST', `/api/admin/keys/${keyId}/unbind`, {
    token: T, body: {deviceId: 'dev-bbb-222'},
  });
  ok('unbind device', unbind.data.freed === true);

  console.log('— payments ledger —');
  const pays = await req('GET', '/api/admin/payments', {token: T});
  ok('payments listed (2: mark-paid + renewal)', pays.data.payments.length === 2);
  const manual = await req('POST', '/api/admin/payments', {
    token: T, body: {amount: 25, method: 'bank', note: 'دفعة عامة'},
  });
  ok('manual payment (no key)', manual.status === 200);
  const del = await req('POST', `/api/admin/payments/${manual.data.id}/delete`, {token: T});
  ok('delete payment', del.data.ok === true);

  console.log('— change password —');
  const pw = await req('POST', '/api/admin/auth/password', {
    token: T, body: {current: 'owner-pass-123', next: 'new-owner-pass-456'},
  });
  ok('password changed', pw.data.ok === true);
  const reLogin = await req('POST', '/api/admin/auth/login',
    {body: {email: 'owner@sela.test', password: 'new-owner-pass-456'}});
  ok('login with new password', reLogin.status === 200);

  console.log('— audit —');
  const auditRows = await req('GET', '/api/admin/audit?limit=200', {token: T});
  const events = auditRows.data.events.map(e => e.event);
  ok('audit has login_success', events.includes('login_success'));
  ok('audit has admin_create_keys', events.includes('admin_create_keys'));
  ok('audit has activate_new_device', events.includes('activate_new_device'));

  console.log('— public site + secret panel files —');
  // Public marketing site at root:
  for (const f of ['', 'contact', 'site.css', 'icon-512.png']) {
    const r = await fetch(`${BASE}/${f}`);
    ok('served site ' + (f || '/'), r.status === 200);
  }
  // Panel only at the secret path (v3):
  const secret = env.ADMIN_PATH_SECRET;
  const pr = await fetch(`${BASE}/${secret}/`);
  ok('panel at secret path', pr.status === 200);
  const prAsset = await fetch(`${BASE}/${secret}/app.js`);
  ok('panel app.js at secret path', prAsset.status === 200);
  // Old/public panel paths must be gone:
  for (const f of ['app.js', 'styles.css', 'admin']) {
    const r = await fetch(`${BASE}/${f}`);
    ok(`hidden ${f} (404)`, r.status === 404);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  try { fs.rmSync(DATA_DIR, {recursive: true, force: true}); } catch (_) {}
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
