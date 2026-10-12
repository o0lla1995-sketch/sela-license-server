/**
 * test-market.js — v4 منصة البيع أونلاين: اختبار تكاملي كامل end-to-end.
 * ─────────────────────────────────────────────────────────────────
 * يسلسلة الحياة الحقيقية كاملة فوق خادم مرفوع على منفذ ومجلد مؤقتين:
 *
 *  1) إنشاء مفتاح + تفعيل جهاز (POS) → رخصة موقعة
 *  2) تسجيل متجر التاجر + مناطق التوصيل
 *  3) مزامنة كتالوج المنتجات (idempotent + إخفاء الغائب)
 *  4) الواجهات العامة: متاجر/منتجات/تصنيفات (مع عزل غير المنشور)
 *  5) تسجيل مستخدم (طلب مكرر بالهوية يُرفض) + تسجيل دخول
 *  6) طلب: منطقة غير صالحة تُرفض، أسعار تُحسب من الخادم، توصيل يضاف
 *  7) POS: استطلاع الطلبات → قبول → إرسال (INV-O) → تسليم
 *  8) انتقالات حالة غير صالحة تُرفض + idempotency
 *  9) إلغاء المستخدم قبل الإرسال + محاولة بعد الإرسال تُرفض
 * 10) إرجاع جزئي/كلي بعد التسليم
 * 11) عزل المتاجر: متجر ثانٍ لا يرى طلبات الأول ولا منتجاته
 * 12) انتهاء الاشتراك → SUBSCRIPTION_ENDED + الحارس يخفي المنتجات
 * 13) لوحة الإدارة: إحصاءات + نشر/إخفاء يدوي
 *
 * Run: node test-market.js
 */
'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-market-'));

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
    /* ── 1) مفتاح + تفعيل ──────────────────────────────────── */
    const admin = await req('POST', '/api/admin/auth/login',
      {body: {email: 'owner@sela.test', password: 'owner-pass-123'}});
    ok('admin login', admin.status === 200 && admin.data.ok);

    const created = await req('POST', '/api/admin/keys', {
      token: 'root-master-token',
      body: {planDays: 30, maxDevices: 2, count: 1, note: 'متجر الاختبار'},
    });
    ok('create key', created.status === 200 && created.data.keys.length === 1);
    const key = created.data.keys[0].key;

    const dev = 'test-device-1111';
    const act = await req('POST', '/api/v1/activate',
      {body: {key, deviceId: dev, deviceLabel: 'pos', appVersion: '48.0.0'}});
    ok('activate', act.status === 200 && act.data.ok && act.data.license);
    const auth = {license: act.data.license, signature: act.data.signature, deviceId: dev};

    /* ── 2) تسجيل المتجر ───────────────────────────────────── */
    const reg = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth,
        store: {name: 'سوبر ماركت النور', category: 'بقالة', region: 'رام الله',
          phone: '0591234567', whatsapp: '0591234567', description: 'كل احتياجات بيتك'},
        deliveryRegions: [
          {name: 'المركز', feeMinor: 1000},
          {name: 'المخيم', feeMinor: 1500},
        ],
        published: true,
      },
    });
    ok('store register', reg.status === 200 && reg.data.ok && /^ST-/.test(reg.data.store.storeNumber));
    ok('store published', reg.data.store.published === true);

    // تحديث الملف: الاسم يتغير والنشر يبقى
    const reg2 = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth,
        store: {name: 'سوبر ماركت النور ٢', phone: '0591234567'},
        deliveryRegions: [{name: 'المركز', feeMinor: 1200}],
      },
    });
    ok('store re-register updates', reg2.status === 200 && reg2.data.store.published === true);

    /* ── 3) مزامنة المنتجات ────────────────────────────────── */
    const sync1 = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: '101', name: 'أرز أبو كاس 5كغ', category: 'بقالة', priceMinor: 3200, stock: 14},
          {ref: '102', name: 'زيت دوار الشمس 1.5ل', category: 'بقالة', priceMinor: 1800, stock: 9},
          {ref: '103', name: 'طماطم', category: 'خضار', priceMinor: 400, stock: 30, soldByWeight: true, unitLabel: 'كيلو'},
        ],
      },
    });
    ok('products sync', sync1.status === 200 && sync1.data.saved === 3);

    // مزامنة ثانية بدون «طماطم»: تبقى الصف لكن غير متاحة، وإعادتها تعيدها
    const sync2 = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: '101', name: 'أرز أبو كاس 5كغ', category: 'بقالة', priceMinor: 3350, stock: 12},
          {ref: '102', name: 'زيت دوار الشمس 1.5ل', category: 'بقالة', priceMinor: 1800, stock: 9},
        ],
      },
    });
    ok('products re-sync', sync2.status === 200 && sync2.data.saved === 2);
    let prods = await req('GET', '/api/market/stores/1/products');
    ok('missing product hidden (not deleted)',
      prods.data.products.length === 2 && !prods.data.products.some(p => p.name === 'طماطم'));
    const sync3 = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: '101', name: 'أرز أبو كاس 5كغ', category: 'بقالة', priceMinor: 3350, stock: 12},
          {ref: '102', name: 'زيت دوار الشمس 1.5ل', category: 'بقالة', priceMinor: 1800, stock: 9},
          {ref: '103', name: 'طماطم', category: 'خضار', priceMinor: 400, stock: 30, soldByWeight: true, unitLabel: 'كيلو'},
        ],
      },
    });
    prods = await req('GET', '/api/market/stores/1/products');
    ok('product returns when re-synced', prods.data.products.length === 3);

    /* ── 4) الواجهات العامة ────────────────────────────────── */
    const stores = await req('GET', '/api/market/stores');
    ok('market stores list', stores.data.ok && stores.data.stores.length === 1);
    const storeDetail = await req('GET', '/api/market/stores/1');
    ok('store detail + regions', storeDetail.data.ok &&
      storeDetail.data.deliveryRegions.some(r => r.name === 'المركز' && r.fee_minor === 1200));
    const cats = await req('GET', '/api/market/categories');
    ok('categories aggregated', cats.data.ok && cats.data.categories.length >= 2);
    const cross = await req('GET', '/api/market/products');
    ok('cross-store products', cross.data.ok && cross.data.products.length === 3 &&
      cross.data.products[0].store_name === 'سوبر ماركت النور ٢');
    const search = await req('GET', '/api/market/stores/1/products?q=' + encodeURIComponent('أرز'));
    ok('product search', search.data.products.length === 1);

    /* ── 5) مستخدم المتجر ──────────────────────────────────── */
    const ureg = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'أحمد الخطيب', phone: '0598765432'}});
    ok('user register', ureg.status === 200 && ureg.data.token);
    const mtok = ureg.data.token;
    const ureg2 = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'آخر', phone: '0599999999'}});
    ok('duplicate id rejected', ureg2.status === 409);
    const ulog = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', phone: '0598765432'}});
    ok('user login', ulog.status === 200 && ulog.data.token);

    /* ── 6) الطلب ──────────────────────────────────────────── */
    const badRegion = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {storeId: 1, items: [{productId: 1, quantity: 2}], regionName: 'بلاد العجائب'},
    });
    ok('bad region rejected with region list', badRegion.status === 400 &&
      Array.isArray(badRegion.data.regions));

    const order = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [
          {productId: 1, quantity: 2},   // أرز 33.50 × 2
          {productId: 3, quantity: 1.5}, // طماطم 4.00 × 1.5
        ],
        regionName: 'المركز',
        address: 'شارع الرئيسي، بناية 4',
        note: 'الاتصال قبل الوصول',
      },
    });
    // 2×3350 + 1.5×400 + 1200 = 6700+600+1200 = 8500
    ok('order placed (server-side pricing)',
      order.status === 200 && order.data.order.items_total_minor === 7300 &&
      order.data.order.delivery_fee_minor === 1200 &&
      order.data.order.total_minor === 8500 &&
      order.data.order.status === 'new');
    const orderNumber = order.data.order.order_number;

    /* ── 7) POS: استطلاع + قبول + إرسال + تسليم ──────────── */
    const poll = await req('POST', '/api/v1/store/orders/poll',
      {body: {...auth, since: 0}});
    ok('poll sees the order', poll.data.ok && poll.data.orders.length === 1 &&
      poll.data.orders[0].customer.phone === '0598765432' &&
      poll.data.orders[0].items.length === 2);

    const acc = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'accept'}});
    ok('accept', acc.status === 200 && acc.data.order.status === 'accepted');
    const accAgain = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'accept'}});
    ok('accept is idempotent', accAgain.status === 200 && accAgain.data.order.status === 'accepted');

    const badSend = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'deliver'}});
    ok('deliver before send rejected', badSend.status === 409);

    const send = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'send', invoiceRef: 'INV-O-20261012-0001'}});
    ok('send with invoice', send.status === 200 && send.data.order.status === 'sent' &&
      send.data.order.invoice_ref === 'INV-O-20261012-0001');

    const del = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'deliver'}});
    ok('deliver', del.status === 200 && del.data.order.status === 'delivered');

    const myOrders = await req('GET', '/api/market/orders', {marketToken: mtok});
    ok('user sees own order statuses', myOrders.data.orders.length === 1 &&
      myOrders.data.orders[0].status === 'delivered' &&
      myOrders.data.orders[0].store.name === 'سوبر ماركت النور ٢');

    /* ── 9) إلغاء المستخدم ─────────────────────────────────── */
    const order2 = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {storeId: 1, items: [{productId: 2, quantity: 1}], regionName: 'المركز'},
    });
    const on2 = order2.data.order.order_number;
    const cancel = await req('POST', `/api/market/orders/${order2.data.order.id}/cancel`,
      {marketToken: mtok});
    ok('user cancels before send', cancel.status === 200 && cancel.data.order.status === 'cancelled');
    const cancelAgain = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {storeId: 1, items: [{productId: 2, quantity: 1}], regionName: 'المركز'},
    });
    const on3 = cancelAgain.data.order.order_number;
    await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: on3, action: 'accept'}});
    await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: on3, action: 'send', invoiceRef: 'INV-O-20261012-0002'}});
    const lateCancel = await req('POST', `/api/market/orders/${cancelAgain.data.order.id}/cancel`,
      {marketToken: mtok});
    ok('user cancel after send rejected', lateCancel.status === 409);

    /* ── 10) الإرجاع بعد التسليم ───────────────────────────── */
    const ret1 = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'return', returnedMinor: 3200}});
    ok('partial return keeps delivered', ret1.status === 200 &&
      ret1.data.order.status === 'delivered' && ret1.data.order.returned_minor === 3200);
    const ret2 = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'return', returnedMinor: 4100}});
    ok('full return flips status', ret2.status === 200 &&
      ret2.data.order.status === 'returned' && ret2.data.order.returned_minor === 7300);
    const retBad = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'return', returnedMinor: 1}});
    ok('return over items total rejected', retBad.status === 400);

    /* ── 11) عزل المتاجر ───────────────────────────────────── */
    const created2 = await req('POST', '/api/admin/keys', {
      token: 'root-master-token', body: {planDays: 30, count: 1, note: 'متجر ثانٍ'},
    });
    const key2 = created2.data.keys[0].key;
    const act2 = await req('POST', '/api/v1/activate',
      {body: {key: key2, deviceId: 'device-2222', deviceLabel: 'pos2', appVersion: '48.0.0'}});
    const auth2 = {license: act2.data.license, signature: act2.data.signature, deviceId: 'device-2222'};
    const poll2 = await req('POST', '/api/v1/store/orders/poll',
      {body: {...auth2, since: 0}});
    ok('second store sees zero orders (isolation)',
      poll2.status === 404 && poll2.data.error === 'STORE_NOT_REGISTERED');
    const actOther = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth2, orderNumber, action: 'accept'}});
    ok('cross-store action blocked', actOther.status === 404);

    /* ── 12) انتهاء الاشتراك ───────────────────────────────── */
    // تقليل نافذة الخطة إلى الماضي مباشرة في القاعدة ثم نبض الحارس
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA_DIR, 'sela-license.db'));
    db.prepare('UPDATE keys SET plan_expires_at = ? WHERE key_plain = ?')
      .run(Date.now() - 1000, key);
    db.close();
    const expiredCall = await req('POST', '/api/v1/store/products/sync', {
      body: {...auth, products: [{ref: '101', name: 'أرز', priceMinor: 3200, stock: 5}]},
    });
    ok('expired subscription → SUBSCRIPTION_ENDED', expiredCall.status === 403 &&
      expiredCall.data.error === 'SUBSCRIPTION_ENDED');
    const stores2 = await req('GET', '/api/market/stores');
    ok('sweeper hid the store', stores2.data.stores.length === 0);
    const prods2 = await req('GET', '/api/market/stores/1/products');
    ok('store detail hidden for expired', prods2.status === 404);

    /* ── 13) لوحة الإدارة ──────────────────────────────────── */
    const mstats = await req('GET', '/api/admin/market/stats', {token: 'root-master-token'});
    ok('admin market stats', mstats.data.ok && mstats.data.stores === 1 &&
      mstats.data.users === 1 && mstats.data.orders === 3);
    const mstores = await req('GET', '/api/admin/market/stores', {token: 'root-master-token'});
    ok('admin stores list flags subscription',
      mstores.data.stores.length === 1 && mstores.data.stores[0].subscriptionActive === false);
    const morders = await req('GET', '/api/admin/market/orders?status=returned',
      {token: 'root-master-token'});
    ok('admin orders filter', morders.data.ok && morders.data.orders.length === 1 &&
      morders.data.orders[0].user_phone === '0598765432');

    // تفعيل جديد يعيد النشر عبر register
    db.open ? null : null;
    const Database2 = require('better-sqlite3');
    const db2 = new Database2(path.join(DATA_DIR, 'sela-license.db'));
    db2.prepare('UPDATE keys SET plan_expires_at = ?, revoked_at = NULL WHERE key_plain = ?')
      .run(Date.now() + 30 * 24 * 3600 * 1000, key);
    db2.close();
    const republish = await req('POST', '/api/v1/store/register', {
      body: {...auth, store: {name: 'سوبر ماركت النور ٢', phone: '0591234567'},
        deliveryRegions: [{name: 'المركز', feeMinor: 1200}]},
    });
    ok('renewed subscription republishes', republish.status === 200 &&
      republish.data.store.published === true);
    const stores3 = await req('GET', '/api/market/stores');
    ok('store visible again', stores3.data.stores.length === 1);

    /* ── 14) حذف الحساب (سياسة جوجل بلاي) ─────────────────── */
    const delNoAuth = await req('POST', '/api/market/auth/delete', {});
    ok('delete without token rejected', delNoAuth.status === 401);
    const delAcc = await req('POST', '/api/market/auth/delete', {marketToken: mtok});
    ok('account deleted', delAcc.status === 200 && delAcc.data.ok);
    const deadSession = await req('GET', '/api/market/orders', {marketToken: mtok});
    ok('old token dead after deletion', deadSession.status === 401);
    const deadLogin = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', phone: '0598765432'}});
    ok('deleted account cannot log in', deadLogin.status === 403);
    const reReg = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'عودة أحمد', phone: '0598765432'}});
    ok('same id number freed for re-registration',
      reReg.status === 200 && reReg.data.token);
    const reOrders = await req('GET', '/api/market/orders', {marketToken: reReg.data.token});
    ok('re-registered account starts clean', reOrders.data.orders.length === 0);

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
