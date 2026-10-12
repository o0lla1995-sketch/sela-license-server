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

    /* ── 3b) صور المنتجات (v4.2) ────────────────────────────── */
    // بناء WebP اصطيناعي صالح بصرياً للبصمة السحرية (RIFF....WEBP)
    const crypto = require('crypto');
    function fakeWebp(seed) {
      const buf = Buffer.alloc(120);
      buf.write('RIFF', 0, 'ascii');
      buf.writeUInt32LE(buf.length - 8, 4);
      buf.write('WEBPVP8 ', 8, 'ascii');
      crypto.createHash('sha256').update(String(seed)).digest(); // استهلاك فقط
      for (let i = 16; i < buf.length; i++) {
        buf[i] = (i * 7 + seed.charCodeAt(0)) % 251;
      }
      return buf;
    }
    const img1 = fakeWebp('A');
    const img2 = fakeWebp('B');
    const hash1 = crypto.createHash('sha256').update(img1).digest('hex');
    const hash2 = crypto.createHash('sha256').update(img2).digest('hex');
    // هاش معلن لا يطابق المحتوى → رفض
    const badImgSync = await req('POST', '/api/v1/store/images/sync', {
      body: {
        ...auth,
        images: [{ref: '101', items: [{hash: hash1, slot: 0}]}],
        uploads: [{hash: hash1, ext: 'webp', data: fakeWebp('Z').toString('base64')}],
      },
    });
    ok('image upload with mismatched hash rejected', badImgSync.status === 400 &&
      badImgSync.data.error === 'BAD_IMAGE_DATA');
    const imgSync = await req('POST', '/api/v1/store/images/sync', {
      body: {
        ...auth,
        images: [
          {ref: '101', items: [{hash: hash1, slot: 0}, {hash: hash2, slot: 1}]},
          {ref: '103', items: [{hash: hash2, slot: 0}]},
        ],
        uploads: [
          {hash: hash1, ext: 'webp', data: img1.toString('base64'), width: 800, height: 600},
          {hash: hash2, ext: 'webp', data: img2.toString('base64'), width: 640, height: 480},
        ],
      },
    });
    ok('images sync stored + linked', imgSync.status === 200 &&
      imgSync.data.stored === 2 && imgSync.data.linked === 2);
    // إعادة الإرسال نفسه: dedupe كامل (0 رفع جديد) وidempotent
    const imgSync2 = await req('POST', '/api/v1/store/images/sync', {
      body: {
        ...auth,
        images: [
          {ref: '101', items: [{hash: hash1, slot: 0}, {hash: hash2, slot: 1}]},
          {ref: '103', items: [{hash: hash2, slot: 0}]},
        ],
        uploads: [
          {hash: hash1, ext: 'webp', data: img1.toString('base64')},
        ],
      },
    });
    ok('images re-sync dedupes', imgSync2.status === 200 && imgSync2.data.stored === 0);
    // صورة 101 استُبدلت بصورة واحدة → القديمة (hash2 من 103 تبقى) تُكنس من 101
    const imgSync3 = await req('POST', '/api/v1/store/images/sync', {
      body: {...auth, images: [{ref: '101', items: [{hash: hash1, slot: 0}]}]},
    });
    ok('images replace per product', imgSync3.status === 200);
    prods = await req('GET', '/api/market/stores/1/products');
    const rice = prods.data.products.find(p => p.product_ref === '101');
    const tomato = prods.data.products.find(p => p.product_ref === '103');
    ok('products carry image URLs', Array.isArray(rice.images) && rice.images.length === 1 &&
      rice.images[0].includes(`/api/market/img/1/${hash1}.webp`) &&
      tomato.images.length === 1 && tomato.images[0].includes(`${hash2}.webp`));
    const crossImg = await req('GET', '/api/market/products?q=' + encodeURIComponent('أرز'));
    ok('cross products carry images too', crossImg.data.products[0].images.length === 1);
    // جلب الصورة فعلياً: 200 + نوع المحتوى + كاش دائم
    const imgFetch = await fetch(BASE + rice.images[0]);
    ok('image served with immutable cache',
      imgFetch.status === 200 &&
      imgFetch.headers.get('content-type') === 'image/webp' &&
      (imgFetch.headers.get('cache-control') || '').includes('immutable'));
    const imgBuf = Buffer.from(await imgFetch.arrayBuffer());
    ok('image bytes round-trip', imgBuf.equals(img1));
    const img404 = await fetch(BASE + `/api/market/img/1/${'0'.repeat(64)}.webp`);
    ok('unknown image 404', img404.status === 404);

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

    // v4.1: البحث العابر للمتاجر + فلتر التصنيف
    const crossQ = await req('GET', '/api/market/products?q=' + encodeURIComponent('أرز'));
    ok('cross-store search finds only أرز', crossQ.data.products.length === 1 &&
      crossQ.data.products[0].name === 'أرز أبو كاس 5كغ');
    const crossCat = await req('GET', '/api/market/products?category=' + encodeURIComponent('خضار'));
    ok('cross-store category filter', crossCat.data.products.length === 1 &&
      crossCat.data.products.every(p => p.category === 'خضار'));
    const crossQCat = await req('GET', '/api/market/products?q=' + encodeURIComponent('أرز') +
      '&category=' + encodeURIComponent('خضار'));
    ok('cross search + category combined (no match)', crossQCat.data.products.length === 0);

    /* ── 5) مستخدم المتجر (v4.2: كلمة مرور إلزامية) ────────── */
    const weakPw = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'أحمد الخطيب', phone: '0598765432', password: '123'}});
    ok('weak password rejected', weakPw.status === 400 && weakPw.data.error === 'BAD_PASSWORD');
    const digitsPw = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'أحمد الخطيب', phone: '0598765432', password: '12345678'}});
    ok('digits-only password rejected', digitsPw.status === 400);
    const ureg = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'أحمد الخطيب', phone: '0598765432', password: 'sela-2024-pass'}});
    ok('user register with password', ureg.status === 200 && ureg.data.token);
    const mtok = ureg.data.token;
    const ureg2 = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'آخر', phone: '0599999999', password: 'other-1234-pass'}});
    ok('duplicate id rejected', ureg2.status === 409);
    const ulogBad = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', password: 'wrong-pass-9'}});
    ok('wrong password rejected', ulogBad.status === 403 && ulogBad.data.error === 'BAD_CREDENTIALS');
    const ulogPhone = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', phone: '0598765432'}});
    ok('phone login rejected for protected account', ulogPhone.status === 400 &&
      ulogPhone.data.error === 'PASSWORD_REQUIRED');
    const ulog = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', password: 'sela-2024-pass'}});
    ok('user login with password', ulog.status === 200 && ulog.data.token);
    // تغيير كلمة المرور: الحالية الخاطئة تُرفض ثم الصحيحة تنجح
    const pwWrongCur = await req('POST', '/api/market/auth/set-password',
      {marketToken: mtok, body: {password: 'new-pass-5678', currentPassword: 'nope-1234'}});
    ok('set-password with wrong current rejected', pwWrongCur.status === 403);
    const pwSet = await req('POST', '/api/market/auth/set-password',
      {marketToken: mtok, body: {password: 'new-pass-5678', currentPassword: 'sela-2024-pass'}});
    ok('set-password change ok', pwSet.status === 200);
    const ulog2 = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', password: 'new-pass-5678'}});
    ok('login with changed password', ulog2.status === 200);
    // استعادة: جوال خاطئ يُرفض، الصحيح يعيّن كلمة جديدة ويبطل الجلسات
    const resetBad = await req('POST', '/api/market/auth/reset',
      {body: {idNumber: '401234567', phone: '0599000000', newPassword: 'reset-pass-90'}});
    ok('reset with wrong phone rejected', resetBad.status === 403);
    const reset = await req('POST', '/api/market/auth/reset',
      {body: {idNumber: '401234567', phone: '0598765432', newPassword: 'reset-pass-90'}});
    ok('reset ok and returns fresh token', reset.status === 200 && reset.data.token);
    const oldTokDead = await req('GET', '/api/market/orders', {marketToken: mtok});
    ok('old sessions revoked after reset', oldTokDead.status === 401);
    const mtok2 = reset.data.token;
    const ulog3 = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', password: 'reset-pass-90'}});
    ok('login after reset', ulog3.status === 200);

    /* ── 6) الطلب ──────────────────────────────────────────── */
    const badRegion = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {storeId: 1, items: [{productId: 1, quantity: 2}], regionName: 'بلاد العجائب'},
    });
    ok('bad region rejected with region list', badRegion.status === 400 &&
      Array.isArray(badRegion.data.regions));

    const order = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
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

    const myOrders = await req('GET', '/api/market/orders', {marketToken: mtok2});
    ok('user sees own order statuses', myOrders.data.orders.length === 1 &&
      myOrders.data.orders[0].status === 'delivered' &&
      myOrders.data.orders[0].store.name === 'سوبر ماركت النور ٢');

    /* ── 9) إلغاء المستخدم ─────────────────────────────────── */
    const order2 = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {storeId: 1, items: [{productId: 2, quantity: 1}], regionName: 'المركز'},
    });
    const on2 = order2.data.order.order_number;
    const cancel = await req('POST', `/api/market/orders/${order2.data.order.id}/cancel`,
      {marketToken: mtok2});
    ok('user cancels before send', cancel.status === 200 && cancel.data.order.status === 'cancelled');
    const cancelAgain = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {storeId: 1, items: [{productId: 2, quantity: 1}], regionName: 'المركز'},
    });
    const on3 = cancelAgain.data.order.order_number;
    await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: on3, action: 'accept'}});
    await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: on3, action: 'send', invoiceRef: 'INV-O-20261012-0002'}});
    const lateCancel = await req('POST', `/api/market/orders/${cancelAgain.data.order.id}/cancel`,
      {marketToken: mtok2});
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
    const delAcc = await req('POST', '/api/market/auth/delete', {marketToken: mtok2});
    ok('account deleted', delAcc.status === 200 && delAcc.data.ok);
    const deadSession = await req('GET', '/api/market/orders', {marketToken: mtok2});
    ok('old token dead after deletion', deadSession.status === 401);
    const deadLogin = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', password: 'reset-pass-90'}});
    ok('deleted account cannot log in', deadLogin.status === 403);
    const reReg = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'عودة أحمد', phone: '0598765432', password: 'fresh-321-pass'}});
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
