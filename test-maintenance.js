/**
 * test-maintenance.js — v5.3 التنظيف الدوري الاحترافي: اختبار تكاملي.
 * ─────────────────────────────────────────────────────────────────
 * يتحقق من سلوك maintenanceSweep الحقيقي عبر مؤقت الخادم نفسه
 * (يُطلق بعد ٣٠ ثانية من الإقلاع) — لا استدعاء مباشر:
 *
 *  1) مفتاح + تفعيل + تسجيل متجر منشور + تسجيل مستخدم متجر.
 *  2) مزامنة ٤ منتجات (أ/ب/ج/د) + رفع صورة حقيقية لمنتج أ
 *     + صورة يتيمة مرفوعة بلا ربط + ملف غريب على القرص.
 *  3) تجهيز الحالات عبر قاعدة البيانات مباشرة (نفس ملف WAL):
 *     ب: متاحة=0 وحدثها قبل ١٥ يوماً → تُحذف.
 *     ج: متاحة=0 وحدثها قبل ٥ أيام (ضمن المهلة) → تبقى.
 *     د: متاحة=0 قديمة + مخفية إدارياً → تبقى (قرار الإدارة لا يُمس).
 *     رمز استعادة منتهي قبل ساعتين → يُحذف. سجل تدقيق عمره ١٠٠
 *     يوم → يُحذف.
 *  4) انتظار دورة التنظيف (~٣٦ ثانية) ثم قراءة التقرير من
 *     /api/admin/market/stats والتحقق من كل رقم وكل ملف على القرص.
 *  5) صورة منتج أ (المتاح) وملفها سليمان، و/ignore يعمل 200.
 *
 * Run: node test-maintenance.js
 */
'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-maint-'));

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
  TZ: 'Asia/Jerusalem',
  RATE_LIMIT: '9999',
};

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

async function req(method, p, {token, body, marketToken} = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(token ? {Authorization: 'Bearer ' + token} : {}),
      ...(marketToken ? {'x-market-token': marketToken} : {}),
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return {status: r.status, data};
}

/** ويب بي صالحة بنيوياً (رأس RIFF/WEBP يمر فحص decodeUpload). */
function fakeWebp(size = 96) {
  const buf = Buffer.alloc(size);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(size - 8, 4);
  buf.write('WEBP', 8, 'ascii');
  for (let i = 16; i < size; i += 1) { buf[i] = (i * 7) & 0xff; }
  return buf;
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'src', 'server.js')], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errLines = [];
  server.stderr.on('data', d => errLines.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server boot timeout')), 15000);
    const onData = d => {
      if (String(d).includes('listening on')) { clearTimeout(t); resolve(); }
    };
    server.stdout.on('data', onData);
    server.on('exit', code => {
      clearTimeout(t);
      reject(new Error('server exited early code=' + code + '\n' + errLines.join('')));
    });
  });
  console.log('server booted (data dir: ' + DATA_DIR + ')\n');

  try {
    /* ── 1) مفتاح + تفعيل + متجر ─────────────────────────── */
    await req('POST', '/api/admin/auth/login',
      {body: {email: 'owner@sela.test', password: 'owner-pass-123'}});
    const created = await req('POST', '/api/admin/keys', {
      token: 'root-master-token',
      body: {planDays: 60, maxDevices: 2, count: 1, note: 'اختبار التنظيف'},
    });
    const key = created.data.keys[0].key;
    const dev = 'maint-device-1';
    const act = await req('POST', '/api/v1/activate',
      {body: {key, deviceId: dev, deviceLabel: 'pos', appVersion: '55.0.0'}});
    const auth = {license: act.data.license, signature: act.data.signature, deviceId: dev};

    const reg = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth,
        store: {name: 'متجر التنظيف', category: 'بقالة', region: 'غزة',
          phone: '0591234567', whatsapp: ''},
        deliveryRegions: [{name: 'الشمال', feeMinor: 800}],
        published: true,
      },
    });
    ok('store registered', reg.status === 200 && reg.data.ok);
    const storeId = reg.data.store.id;
    const storeRow = reg.data.store;
    ok('store published', storeRow.published === true);

    const user = await req('POST', '/api/market/auth/register', {
      body: {idNumber: '987654321', name: 'مستخدم التنظيف', phone: '0591112222', password: 'pass-12345'},
    });
    ok('market user registered', user.status === 200 && user.data.ok);
    const login = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '987654321', password: 'pass-12345'}});
    ok('market login', login.status === 200 && login.data.ok);

    /* ── 2) كتالوج ٤ منتجات + صور ────────────────────────── */
    const sync1 = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: 'A', name: 'منتج أ', priceMinor: 1000, stock: 10},
          {ref: 'B', name: 'منتج ب', priceMinor: 2000, stock: 5},
          {ref: 'C', name: 'منتج ج', priceMinor: 3000, stock: 7},
          {ref: 'D', name: 'منتج د', priceMinor: 4000, stock: 3},
        ],
      },
    });
    ok('products synced', sync1.status === 200 && sync1.data.saved === 4);

    const webp = fakeWebp();
    const hash = crypto.createHash('sha256').update(webp).digest('hex');
    const orphanBuf = fakeWebp(120);
    const orphanHash = crypto.createHash('sha256').update(orphanBuf).digest('hex');
    const imgSync = await req('POST', '/api/v1/store/images/sync', {
      body: {
        ...auth,
        uploads: [
          // صورة منتج أ (تُربط في نفس النداء)
          {hash, ext: 'webp', data: webp.toString('base64'), width: 800, height: 600},
          // صورة يتيمة: تُخزَّن بلا ربط بأي منتج → كنس فوري في نفس النداء
          {hash: orphanHash, ext: 'webp', data: orphanBuf.toString('base64'), width: 800, height: 600},
        ],
        images: [
          {ref: 'A', items: [{hash, slot: 0}]},
        ],
      },
    });
    ok('image linked to A', imgSync.status === 200 && imgSync.data.linked === 1);
    ok('orphan upload swept within the same call (v4.2 behavior)',
      imgSync.data.stored === 2 && imgSync.data.cleaned === 1,
      JSON.stringify(imgSync.data));
    // النتيجة: صورة أ فقط باقية
    const storeDir = path.join(DATA_DIR, 'market-images', String(storeId));
    const imgFileA = path.join(storeDir, `${hash}.webp`);
    ok('image file for A on disk', fs.existsSync(imgFileA));

    // ملف غريب على القرص بلا صف (بقايا/ترقية)
    fs.writeFileSync(path.join(storeDir, 'junk-leftover.tmp'), 'garbage');

    /* ── 3) تجهيز الحالات عبر القاعدة مباشرة ─────────────── */
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA_DIR, 'sela-license.db'));
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    // ب: مهجورة ١٥ يوماً → تُحذف. ج: ٥ أيام → تبقى. د: إخفاء إداري → تبقى.
    db.prepare(`UPDATE store_products SET available = 0, updated_at = ? WHERE product_ref = 'B'`)
      .run(now - 15 * DAY);
    db.prepare(`UPDATE store_products SET available = 0, updated_at = ? WHERE product_ref = 'C'`)
      .run(now - 5 * DAY);
    db.prepare(`UPDATE store_products SET available = 0, updated_at = ? WHERE product_ref = 'D'`)
      .run(now - 20 * DAY);
    const dRow = db.prepare(`SELECT id FROM store_products WHERE product_ref = 'D'`).get();
    db.prepare('INSERT INTO admin_hidden_products (product_id, admin_id, hidden_at) VALUES (?, 1, ?)')
      .run(dRow.id, now - 20 * DAY);
    // رمز استعادة منتهي (أكثر من ساعة) + سجل تدقيق عمره ١٠٠ يوم
    const uRow = db.prepare(`SELECT id FROM market_users WHERE id_number = '987654321'`).get();
    db.prepare(`INSERT INTO market_reset_codes (user_id, code_hash, attempts, created_at, expires_at)
                VALUES (?, 'x', 0, ?, ?)`).run(uRow.id, now - 2 * 3600 * 1000, now - 3600 * 1000);
    db.prepare(`INSERT INTO audit (ts, event, details) VALUES (?, 'old_event', 'x')`)
      .run(now - 100 * DAY);
    db.close();
    console.log('  … حالات الجهز جاهزة؛ انتظار دورة التنظيف (~36 ث)…');

    /* ── 4) انتظار الدورة الحقيقية + التقرير ──────────────── */
    await new Promise(r => setTimeout(r, 37000));
    const stats = await req('GET', '/api/admin/market/stats', {token: 'root-master-token'});
    ok('stats reachable', stats.status === 200 && stats.data.ok);
    const m = stats.data.maintenance;
    ok('maintenance report present', m != null);
    if (m != null) {
      ok('report has no errors', (m.errors || []).length === 0, JSON.stringify(m.errors));
      ok('product B deleted (15d abandoned)', m.productsDeleted === 1,
        'productsDeleted=' + m.productsDeleted);
      ok('WAL checkpointed', m.walCheckpoint === true);
      ok('expired reset code purged', m.resetCodesPurged === 1,
        'resetCodesPurged=' + m.resetCodesPurged);
      ok('old audit purged', m.auditPurged === 1, 'auditPurged=' + m.auditPurged);
      ok('stray disk file deleted', m.strayFilesDeleted === 1,
        'strayFilesDeleted=' + m.strayFilesDeleted);
    }
    // الحالة النهائية في القاعدة: ب محذوف، ج ود باقيان، أ متاحة بصورتها.
    const Database2 = new Database(path.join(DATA_DIR, 'sela-license.db'));
    const refs = Database2.prepare(`SELECT product_ref, available FROM store_products`).all();
    const byRef = Object.fromEntries(refs.map(r => [r.product_ref, r.available]));
    ok('A alive & available', byRef['A'] === 1);
    ok('B gone (deleted)', byRef['B'] === undefined);
    ok('C alive (within 14d grace)', byRef['C'] === 0);
    ok('D alive (admin decision kept)', byRef['D'] === 0);
    const imageRows = Database2.prepare(`SELECT COUNT(*) n FROM store_images`).get();
    ok('only A image row remains', imageRows.n === 1, 'rows=' + imageRows.n);
    Database2.close();
    ok('A image file intact', fs.existsSync(imgFileA));
    ok('junk file gone', !fs.existsSync(path.join(storeDir, 'junk-leftover.tmp')));

    // صورة أ تُقدَّم 200 من متجر منشور مع ترويسة كاش دائمة.
    const imgRes = await fetch(BASE + `/api/market/img/${storeId}/${hash}.webp`);
    ok('public image 200', imgRes.status === 200);
    ok('immutable cache header',
      (imgRes.headers.get('cache-control') || '').includes('immutable'));
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    server.kill('SIGKILL');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
