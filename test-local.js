/**
 * Local end-to-end test of the sela license server.
 * Boots the server on a random port, then exercises:
 *  health → admin create key → activate → verify signature with the
 *  APP's public key + tweetnacl → heartbeat → extend → heartbeat
 *  (renewal) → unbind → device-limit behavior → revoked behavior.
 */
'use strict';

const http = require('http');
const nacl = require('/home/z/my-project/SmartVisionPos/node_modules/tweetnacl');
const crypto = require('crypto');

const APP_PUBLIC_KEY_HEX =
  '6ee513c1b7f0b057d970c6c2f4b33e5d026bc4c798b5a0b8bb72818d3197d103';

process.env.PORT = '4599';
process.env.DATA_DIR = '/tmp/sela-license-test-' + Date.now();
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.LICENSE_SIGNING_PRIVATE_KEY =
  '302e020100300506032b6570042204208960d794fa492558c0364af79f0d51c88abc4b20b24cc854f60221116924bd93';

let server;
let base;
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 4599,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? {'Content-Length': Buffer.byteLength(data)} : {}),
          ...(token ? {Authorization: 'Bearer ' + token} : {}),
        },
      },
      res => {
        let buf = '';
        res.on('data', c => (buf += c));
        res.on('end', () => {
          try {
            resolve({status: res.statusCode, json: JSON.parse(buf)});
          } catch (_) {
            resolve({status: res.statusCode, json: null});
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function tweetnaclVerify(payloadB64, sigB64) {
  // Reproduces what the app does with tweetnacl.
  const payload = Buffer.from(payloadB64, 'base64');
  const sig = Buffer.from(sigB64, 'base64');
  const pub = Buffer.from(APP_PUBLIC_KEY_HEX, 'hex');
  return nacl.sign.detached.verify(
    new Uint8Array(payload),
    new Uint8Array(sig),
    new Uint8Array(pub),
  );
}

async function main() {
  server = require('./src/server');

  // give express a moment
  await new Promise(r => setTimeout(r, 600));
  base = 'http://127.0.0.1:4599';

  console.log('\n── health & meta');
  let r = await request('GET', '/api/v1/health');
  check('health ok', r.status === 200 && r.json.ok === true);
  r = await request('GET', '/api/v1/pubkey');
  check(
    'pubkey matches the app-baked key',
    r.json.publicKey === APP_PUBLIC_KEY_HEX,
  );
  r = await request('GET', '/api/v1/config');
  check('config has contact', !!r.json.contact);

  console.log('\n── admin auth');
  r = await request('GET', '/api/admin/stats');
  check('admin blocked without token', r.status === 401);
  r = await request('GET', '/api/admin/stats', null, 'wrong');
  check('admin blocked with wrong token', r.status === 401);

  console.log('\n── key creation');
  r = await request(
    'POST',
    '/api/admin/keys',
    {planDays: 30, maxDevices: 2, note: 'test', count: 2},
    'test-admin-token',
  );
  check('created 2 keys', r.status === 200 && r.json.keys.length === 2);
  const key1 = r.json.keys[0].key;
  const key2 = r.json.keys[1].key;
  check('key format', /^SELA-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{3}$/.test(key1), key1);
  check('keys unique', key1 !== key2);

  console.log('\n── activation');
  r = await request('POST', '/api/v1/activate', {
    key: key1,
    deviceId: 'device-A',
    deviceLabel: 'sela 4.0.0',
  });
  check('device A activated', r.status === 200 && r.json.ok === true);
  check(
    'signature verifies with the APP public key (tweetnacl)',
    tweetnaclVerify(r.json.license, r.json.signature),
  );
  const licenseA = r.json.license;
  const sigA = r.json.signature;
  const payloadA = JSON.parse(Buffer.from(licenseA, 'base64').toString());
  check('license expires in ~30 days', payloadA.expiresAt - payloadA.activatedAt >= 29 * 864e5);

  r = await request('POST', '/api/v1/activate', {key: 'SELA-AAAAA-AAAAA-AAA', deviceId: 'x12345'});
  check('bad key rejected 404', r.status === 404 && r.json.error === 'INVALID_KEY');

  r = await request('POST', '/api/v1/activate', {
    key: key1,
    deviceId: 'device-B',
  });
  check('device B activated (limit 2)', r.status === 200);
  r = await request('POST', '/api/v1/activate', {
    key: key1,
    deviceId: 'device-C',
  });
  check('device C rejected (DEVICE_LIMIT)', r.status === 403 && r.json.error === 'DEVICE_LIMIT');

  r = await request('POST', '/api/v1/activate', {key: key1, deviceId: 'device-A'});
  check('re-activation idempotent, same expiry', r.status === 200 && r.json.license === licenseA);

  console.log('\n── heartbeat');
  r = await request('POST', '/api/v1/heartbeat', {
    license: licenseA,
    signature: sigA,
    deviceId: 'device-A',
    deviceTime: Date.now(),
  });
  check('heartbeat active', r.status === 200 && r.json.status === 'active');

  r = await request('POST', '/api/v1/heartbeat', {
    license: licenseA,
    signature: Buffer.from('forged').toString('base64'),
    deviceId: 'device-A',
  });
  check('forged signature rejected', r.status === 403 && r.json.error === 'INVALID_LICENSE');

  console.log('\n── extension (renewal on next heartbeat)');
  r = await request('POST', '/api/admin/keys/1/extend', {days: 30}, 'test-admin-token');
  check('extend affected 2 devices', r.json.affected === 2);
  r = await request('POST', '/api/v1/heartbeat', {
    license: licenseA,
    signature: sigA,
    deviceId: 'device-A',
  });
  check('heartbeat returns RENEWED license', r.json.status === 'active' && r.json.license && r.json.license !== licenseA);
  check('renewed signature verifies in-app', tweetnaclVerify(r.json.license, r.json.signature));
  const renewedPayload = JSON.parse(Buffer.from(r.json.license, 'base64').toString());
  check('renewed expiry extended', renewedPayload.expiresAt > payloadA.expiresAt);

  console.log('\n── unbind + revoke');
  r = await request('POST', '/api/v1/unbind', {
    license: licenseA,
    signature: sigA,
    deviceId: 'device-A',
  });
  check('unbind ok', r.json.ok === true && r.json.freed === true);
  r = await request('POST', '/api/v1/heartbeat', {
    license: licenseA,
    signature: sigA,
    deviceId: 'device-A',
  });
  check('unbound device → unknown_device', r.json.status === 'unknown_device');
  r = await request('POST', '/api/v1/activate', {key: key1, deviceId: 'device-C'});
  check('freed slot lets device C in', r.status === 200);

  r = await request('POST', '/api/admin/keys/2/revoke', null, 'test-admin-token');
  check('revoke key2', r.json.ok === true);
  r = await request('POST', '/api/v1/activate', {key: key2, deviceId: 'device-D'});
  check('revoked key rejected', r.status === 403 && r.json.error === 'KEY_REVOKED');

  console.log('\n── audit + stats');
  r = await request('GET', '/api/admin/stats', null, 'test-admin-token');
  check('stats total=2 revoked=1', r.json.total === 2 && r.json.revoked === 1);
  r = await request('GET', '/api/admin/audit?limit=10', null, 'test-admin-token');
  check('audit has events', r.json.events.length >= 8);

  console.log(`\n══ RESULT: ${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(error => {
  console.error('TEST CRASH:', error);
  if (server) server.close();
  process.exit(1);
});
