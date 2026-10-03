/**
 * seed-demo.js — spins up the license server locally with rich demo data
 * for visual QA of the admin panel.
 *   Admin: owner@sela.test / owner123456  (panel at http://localhost:3998)
 */
'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(__dirname, '..', '.demo-data');
fs.rmSync(DATA_DIR, {recursive: true, force: true});

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  ADMIN_EMAIL: 'owner@sela.test',
  ADMIN_PASSWORD: 'owner123456',
  LICENSE_SIGNING_PRIVATE_KEY:
    '302e020100300506032b6570042204208960d794fa492558c0364af79f0d51c88abc4b20b24cc854f60221116924bd93',
  TZ: 'Asia/Jerusalem',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, p, {token, body} = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(token ? {Authorization: 'Bearer ' + token} : {}),
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env, stdio: ['ignore', 'ignore', 'inherit'],
  });

  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/v1/health'); break; } catch (_) { await sleep(250); }
  }

  const login = await req('POST', '/api/admin/auth/login',
    {body: {email: 'owner@sela.test', password: 'owner123456'}});
  const T = login.token;

  await req('PUT', '/api/admin/config', {
    token: T,
    body: {
      phone: '+972 59 123 4567',
      whatsapp: '+972 59 123 4567',
      telegram: '@sela_support',
      email: 'support@sela.app',
      note: 'لشراء أو تجديد الاشتراك تواصل معنا عبر أحد قنوات التواصل',
    },
  });

  const shops = [
    ['محل أبو محمد — الخليل', 30, 50, 'paid'],
    ['سوبرماركت النور — رام الله', 365, 400, 'paid'],
    ['بقالة الأصدقاء — نابلس', 90, 120, 'partial'],
    ['مخبز السلام — غزة', 30, 50, 'unpaid'],
    ['صيدلية الشفاء — جنين', 365, 400, 'paid'],
    ['محل الخضار الطازج — طولكرم', 30, 50, 'paid'],
    ['تجربة — بدون تفعيل', 7, 0, 'free'],
    ['مطعم الأصيل — بيت لحم', 90, 120, 'paid'],
  ];

  let n = 0;
  for (const [note, days, price, payMode] of shops) {
    const created = await req('POST', '/api/admin/keys', {
      token: T,
      body: {planDays: days, maxDevices: 1 + (n % 2), price, note, count: 1},
    });
    const k = created.keys[0];
    if (!note.includes('بدون تفعيل')) {
      const act = await req('POST', '/api/v1/activate', {
        body: {key: k.key, deviceId: 'demo-device-' + n, deviceLabel: 'Samsung Galaxy A' + (50 + n), appVersion: '2.1.0'},
      });
      // heartbeat for half of them (recent activity)
      if (act.ok && n % 2 === 0) {
        await req('POST', '/api/v1/heartbeat', {
          body: {license: act.license, signature: act.signature, deviceId: 'demo-device-' + n, deviceTime: Date.now()},
        });
      }
    }
    if (payMode === 'paid') {
      await req('POST', `/api/admin/keys/${k.id}/pay`, {token: T, body: {method: n % 3 === 0 ? 'bank' : 'cash'}});
    } else if (payMode === 'partial') {
      await req('POST', '/api/admin/payments', {
        token: T, body: {keyId: k.id, amount: Math.round(price * 0.5), method: 'cash', note: 'دفعة أولى'},
      });
    }
    n++;
  }

  console.log('Demo server ready → http://localhost:' + PORT);
  console.log('login: owner@sela.test / owner123456');
  setInterval(() => {}, 60000);
}

main().catch(e => { console.error(e); process.exit(1); });
