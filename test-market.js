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
          // v4.3: منتج بخيارات (مقاسات + لون)
          {ref: '104', name: 'تيشيرت قطن', category: 'ملابس', priceMinor: 5900, stock: 25,
            options: [
              {name: 'المقاس', values: ['S', 'M', 'L', 'XL']},
              {name: 'اللون', values: ['أسود', 'أبيض', 'كحلي']},
            ]},
          // خيارات فاسدة (قيم فارغة/بدون اسم) → تُهمل وتُخزّن null
          {ref: '105', name: 'كاب أمير', category: 'ملابس', priceMinor: 2500, stock: 10,
            options: [{name: '   ', values: ['واحد']}, {name: 'الحجم', values: ['  ', '']}]},
        ],
      },
    });
    prods = await req('GET', '/api/market/stores/1/products');
    ok('product returns when re-synced', prods.data.products.length === 5);
    const tshirt = prods.data.products.find(p => p.name === 'تيشيرت قطن');
    ok('product options stored + returned',
      tshirt != null && Array.isArray(tshirt.options) && tshirt.options.length === 2 &&
      tshirt.options[0].name === 'المقاس' && tshirt.options[0].values.length === 4 &&
      tshirt.options[1].values[2] === 'كحلي');
    const cap = prods.data.products.find(p => p.name === 'كاب أمير');
    ok('invalid options normalized away', cap != null && cap.options == null);

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
    ok('cross-store products', cross.data.ok && cross.data.products.length === 5 &&
      cross.data.products[0].store_name === 'سوبر ماركت النور ٢');
    ok('cross-store products carry options',
      cross.data.products.some(p => p.name === 'تيشيرت قطن' &&
        p.options != null && p.options.length === 2));
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
    // v5.0: الاستعادة الذاتية القديمة (هوية+هاتف ⇒ تغيير فوري) أُزيلت
    // — كانت ثغرة تتيح سرقة أي حساب بمعرفة رقمي هويته وجواله.
    // المسارات الجديدة: config عام + رمز SMS خاضع للإدارة + إعادة
    // تعيين من الإدارة (المسار الرسمي للاستعادة).
    const cfg1 = await req('GET', '/api/market/config');
    ok('market config: forgot hidden by default',
      cfg1.status === 200 && cfg1.data.ok === true &&
      cfg1.data.forgotPassword === false);
    const forgotOff = await req('POST', '/api/market/auth/forgot/request',
      {body: {idNumber: '401234567', phone: '0598765432'}});
    ok('forgot request rejected while disabled',
      forgotOff.status === 403 && forgotOff.data.error === 'FORGOT_DISABLED');
    const oldResetGone = await req('POST', '/api/market/auth/reset',
      {body: {idNumber: '401234567', phone: '0598765432', newPassword: 'stolen-pass-1'}});
    ok('legacy /auth/reset removed (404)', oldResetGone.status === 404);
    // إعادة التعيين الإدارية: توليد كلمة مؤقتة + إبطال كل الجلسات
    const usersList = await req('GET', '/api/admin/market/users', {token: 'root-master-token'});
    const targetUser = (usersList.data.users || []).find(u => u.id_number === '401234567');
    ok('admin market users list', usersList.status === 200 && targetUser != null);
    const adminReset = await req('POST',
      '/api/admin/market/users/' + targetUser.id + '/reset-password',
      {token: 'root-master-token', body: {}});
    ok('admin reset-password generates temp password',
      adminReset.status === 200 && typeof adminReset.data.password === 'string' &&
      adminReset.data.password.length >= 8);
    const oldTokDead = await req('GET', '/api/market/orders', {marketToken: mtok});
    ok('old sessions revoked after admin reset', oldTokDead.status === 401);
    const ulog3 = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '401234567', password: adminReset.data.password}});
    ok('login after admin reset', ulog3.status === 200);
    const mtok2 = ulog3.data.token;

    /* ── 6) الطلب ──────────────────────────────────────────── */
    // معرّفات المنتجات تُقرأ ديناميكياً — upsert ON CONFLICT يستهلك
    // أرقام AUTOINCREMENT حتى على تعارض المفتاح، فلا يُعتمد على ثباتها.
    const allProds = (await req('GET', '/api/market/stores/1/products')).data.products;
    const riceId = allProds.find(p => p.product_ref === '101').id;
    const tomatoId = allProds.find(p => p.product_ref === '103').id;
    const tshirtId = allProds.find(p => p.product_ref === "104").id;
    const oilId = allProds.find(p => p.product_ref === "102").id;

    const badRegion = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {storeId: 1, items: [{productId: riceId, quantity: 2}], regionName: 'بلاد العجائب'},
    });
    ok('bad region rejected with region list', badRegion.status === 400 &&
      Array.isArray(badRegion.data.regions));

    const order = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {
        storeId: 1,
        items: [
          {productId: riceId, quantity: 2},   // أرز 33.50 × 2
          {productId: tomatoId, quantity: 1.5}, // طماطم 4.00 × 1.5
          // v4.3: منتج بخيارات مع لقطة الخيار المختار
          {productId: tshirtId, quantity: 1, variant: 'المقاس: L · اللون: كحلي'},
        ],
        regionName: 'المركز',
        address: 'شارع الرئيسي، بناية 4',
        note: 'الاتصال قبل الوصول',
        // v5.2: مفتاح الإيديمبوتنسية — إعادة الإرسال (شبكة قتلت الرد)
        // يجب أن تعيد نفس الطلب لا نسخة مكررة.
        clientRequestId: 'test-client-req-0001',
      },
    });
    // 2×3350 + 1.5×400 + 1×5900 + 1200 = 6700+600+5900+1200 = 14400
    ok('order placed (server-side pricing)',
      order.status === 200 && order.data.order.items_total_minor === 13200 &&
      order.data.order.delivery_fee_minor === 1200 &&
      order.data.order.total_minor === 14400 &&
      order.data.order.status === 'new');
    ok('order item carries variant snapshot',
      order.data.order.items.some(it =>
        it.variant === 'المقاس: L · اللون: كحلي' && it.product_name === 'تيشيرت قطن'));
    const orderNumber = order.data.order.order_number;

    /* v5.2: إعادة إرسال بنفس المفتاح تعيد نفس الطلب (إيديمبوتنسية) */
    const replay = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {
        storeId: 1,
        items: [{productId: riceId, quantity: 2}],
        regionName: 'المركز',
        address: 'شارع الرئيسي، بناية 4',
        clientRequestId: 'test-client-req-0001',
      },
    });
    ok('order replay with same clientRequestId returns original',
      replay.status === 200 && replay.data.order.order_number === orderNumber);
    const ordersAfterReplay = await req('GET', '/api/market/orders', {marketToken: mtok2});
    ok('order replay created no duplicate',
      ordersAfterReplay.data.orders.filter(o => o.order_number === orderNumber).length === 1);

    /* v5.2: ضغط gzip — رد كبير مع Accept-Encoding: gzip يصل مضغوطاً.
     * (undici يفك الضغط تلقائياً فيخفي الترويسة — نفحص بموديول http
     * الخام لرؤية الترويسات كما هي على السلك.) */
    const gzipProbe = await new Promise((resolve) => {
      const http = require('http');
      const r = http.request(
        {host: '127.0.0.1', port: PORT, path: '/api/market/products?per=12',
         headers: {'Accept-Encoding': 'gzip'}},
        (resp) => {
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () =>
            resolve({encoding: resp.headers['content-encoding'],
                      bytes: Buffer.concat(chunks).length}));
        });
      r.on('error', () => resolve({encoding: null, bytes: 0}));
      r.end();
    });
    ok('big api responses are gzipped', gzipProbe.encoding === 'gzip');

    /* ── 7) POS: استطلاع + قبول + إرسال + تسليم ──────────── */
    const poll = await req('POST', '/api/v1/store/orders/poll',
      {body: {...auth, since: 0}});
    ok('poll sees the order', poll.data.ok && poll.data.orders.length === 1 &&
      poll.data.orders[0].customer.phone === '0598765432' &&
      poll.data.orders[0].items.length === 3 &&
      poll.data.orders[0].items.some(it => it.variant === 'المقاس: L · اللون: كحلي'));

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

    /* ── 8.5) v4.4: تقييم الطلب بعد التسليم ────────────────── */
    const ratedOrderId = order.data.order.id;
    const badStars = await req('POST', `/api/market/orders/${ratedOrderId}/rate`,
      {marketToken: mtok2, body: {stars: 9}});
    ok('rating stars out of range rejected', badStars.status === 400);
    const noAuthRate = await req('POST', `/api/market/orders/${ratedOrderId}/rate`,
      {body: {stars: 5}});
    ok('rating without token rejected', noAuthRate.status === 401);
    const rate = await req('POST', `/api/market/orders/${ratedOrderId}/rate`,
      {marketToken: mtok2, body: {stars: 5, comment: 'توصيل سريع وتعامل ممتاز'}});
    ok('delivered order rated', rate.status === 200 && rate.data.rating.stars === 5 &&
      rate.data.storeRating.rating === 5 && rate.data.storeRating.ratingCount === 1);
    const rateAgain = await req('POST', `/api/market/orders/${ratedOrderId}/rate`,
      {marketToken: mtok2, body: {stars: 3}});
    ok('double rating rejected', rateAgain.status === 409);
    // طلب جديد (لم يُسلّم) — تقييمه مرفوض
    const newOrderForRate = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {storeId: 1, items: [{productId: oilId, quantity: 1}], regionName: 'المركز'},
    });
    const rateUnrated = await req('POST',
      `/api/market/orders/${newOrderForRate.data.order.id}/rate`,
      {marketToken: mtok2, body: {stars: 4}});
    ok('rating non-delivered order rejected', rateUnrated.status === 409);

    /* التقييم يظهر على المتجر للجميع */
    const storesAfterRating = await req('GET', '/api/market/stores');
    const ratedStore = storesAfterRating.data.stores.find(s => s.id === 1);
    ok('store rating visible in stores list',
      ratedStore.rating === 5 && ratedStore.ratingCount === 1);
    const detailAfterRating = await req('GET', '/api/market/stores/1');
    ok('store rating visible in store detail',
      detailAfterRating.data.store.rating === 5 &&
      detailAfterRating.data.store.ratingCount === 1);
    const reviews = await req('GET', '/api/market/stores/1/ratings');
    ok('store reviews listed with anonymized name',
      reviews.data.rating === 5 && reviews.data.reviews.length === 1 &&
      reviews.data.reviews[0].comment === 'توصيل سريع وتعامل ممتاز' &&
      reviews.data.reviews[0].userName.split(' ').length <= 2 &&
      !reviews.data.reviews[0].userName.includes('0598765432') &&
      !reviews.data.reviews[0].userName.includes('الخطيب'));

    /* الطلب المقيّم يظهر بتقييمه في طلباتي */
    const myOrdersRated = await req('GET', '/api/market/orders', {marketToken: mtok2});
    const ratedOrder = myOrdersRated.data.orders.find(o => o.id === ratedOrderId);
    ok('order shows its rating', ratedOrder.rating != null &&
      ratedOrder.rating.stars === 5);

    /* ── 8.6) v4.4: مناطق التوصيل + فلتر المنطقة ───────────── */
    const regionsList = await req('GET', '/api/market/regions');
    ok('delivery regions listed',
      regionsList.status === 200 && regionsList.data.regions.includes('المركز'));
    const storesInRegion = await req('GET',
      `/api/market/stores?region=${encodeURIComponent('المركز')}`);
    ok('stores filtered by region with fee',
      storesInRegion.status === 200 && storesInRegion.data.stores.length === 1 &&
      storesInRegion.data.stores[0].id === 1 &&
      typeof storesInRegion.data.stores[0].deliveryFeeMinor === 'number');
    const storesInEmpty = await req('GET',
      `/api/market/stores?region=${encodeURIComponent('منطقة-غير-موجودة')}`);
    ok('unknown region returns empty list',
      storesInEmpty.status === 200 && storesInEmpty.data.stores.length === 0);

    /* ── 8.7) v4.4: دفتر عناوين المستخدم ───────────────────── */
    const addrNoAuth = await req('GET', '/api/market/addresses');
    ok('addresses without token rejected', addrNoAuth.status === 401);
    const addrBad = await req('POST', '/api/market/addresses',
      {marketToken: mtok2, body: {label: 'المنزل', city: 'غزة'}});
    ok('address without region rejected', addrBad.status === 400);
    const addr1 = await req('POST', '/api/market/addresses', {
      marketToken: mtok2,
      body: {label: 'المنزل', region: 'المركز', city: 'غزة', street: 'النصر',
        building: '12', floor: '3', apartment: '5', phone: '0599123456',
        notes: 'الاتصال قبل الوصول'},
    });
    ok('first address saved as default', addr1.status === 200 &&
      addr1.data.address.is_default === 1 && addr1.data.address.region === 'المركز');
    const addr2 = await req('POST', '/api/market/addresses', {
      marketToken: mtok2,
      body: {label: 'العمل', region: 'المركز', city: 'غزة', street: 'الجلاء', building: '4'},
    });
    ok('second address saved non-default', addr2.status === 200 &&
      addr2.data.address.is_default === 0);
    const addrList = await req('GET', '/api/market/addresses', {marketToken: mtok2});
    ok('addresses listed default first',
      addrList.data.addresses.length === 2 &&
      addrList.data.addresses[0].id === addr1.data.address.id);
    const setDefault = await req('POST',
      `/api/market/addresses/${addr2.data.address.id}/default`, {marketToken: mtok2});
    ok('default address switched', setDefault.status === 200 &&
      setDefault.data.address.is_default === 1);
    const addrUpdate = await req('POST', '/api/market/addresses', {
      marketToken: mtok2,
      body: {id: addr1.data.address.id, label: 'بيت الأهل', region: 'المركز',
        city: 'غزة', street: 'النصر', building: '99'},
    });
    ok('address updated in place', addrUpdate.status === 200 &&
      addrUpdate.data.address.id === addr1.data.address.id &&
      addrUpdate.data.address.label === 'بيت الأهل' &&
      addrUpdate.data.address.building === '99');
    const delAddr = await req('POST',
      `/api/market/addresses/${addr1.data.address.id}/delete`, {marketToken: mtok2});
    const addrList2 = await req('GET', '/api/market/addresses', {marketToken: mtok2});
    ok('address deleted, remaining keeps default',
      delAddr.status === 200 && addrList2.data.addresses.length === 1 &&
      addrList2.data.addresses[0].is_default === 1);
    // مستخدم آخر لا يستطيع حذف عنوان غيره (404 لا يكشف الوجود)
    const otherUser = await req('POST', '/api/market/auth/register', {
      body: {idNumber: '402987654', name: 'سارة نمر', phone: '0591112233',
        password: 'other-user-77pass'},
    });
    const addrOther = await req('POST',
      `/api/market/addresses/${addr2.data.address.id}/delete`,
      {marketToken: otherUser.data.token});
    ok('cannot delete another user address', addrOther.status === 404);

    /* ── 9) إلغاء المستخدم ─────────────────────────────────── */
    const order2 = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {storeId: 1, items: [{productId: oilId, quantity: 1}], regionName: 'المركز'},
    });
    const on2 = order2.data.order.order_number;
    const cancel = await req('POST', `/api/market/orders/${order2.data.order.id}/cancel`,
      {marketToken: mtok2});
    ok('user cancels before send', cancel.status === 200 && cancel.data.order.status === 'cancelled');
    const cancelAgain = await req('POST', '/api/market/orders', {
      marketToken: mtok2,
      body: {storeId: 1, items: [{productId: oilId, quantity: 1}], regionName: 'المركز'},
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
      {body: {...auth, orderNumber, action: 'return', returnedMinor: 10000}});
    ok('full return flips status', ret2.status === 200 &&
      ret2.data.order.status === 'returned' && ret2.data.order.returned_minor === 13200);
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
      mstats.data.users === 2 && mstats.data.orders === 4);
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
      {body: {idNumber: '401234567', password: adminReset.data.password}});
    ok('deleted account cannot log in', deadLogin.status === 403);
    const reReg = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '401234567', name: 'عودة أحمد', phone: '0598765432', password: 'fresh-321-pass'}});
    ok('same id number freed for re-registration',
      reReg.status === 200 && reReg.data.token);
    const reOrders = await req('GET', '/api/market/orders', {marketToken: reReg.data.token});
    ok('re-registered account starts clean', reOrders.data.orders.length === 0);

    /* ── 18) v4.5: الخصومات + الشعار + الصفحات الصغيرة + JSON المدمج ── */
    // مزامنة جديدة: خصم 20% على 101 و10% على 103 (102 بلا خصم)
    const syncV45 = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: '101', name: 'أرز أبو كاس 5كغ', category: 'بقالة', priceMinor: 3350, stock: 12, discountPct: 20},
          {ref: '102', name: 'زيت دوار الشمس 1.5ل', category: 'بقالة', priceMinor: 1800, stock: 9},
          {ref: '103', name: 'طماطم', category: 'خضار', priceMinor: 400, stock: 30, soldByWeight: true, unitLabel: 'كيلو', discountPct: 10},
        ],
      },
    });
    ok('v4.5 discount sync', syncV45.status === 200 && syncV45.data.saved === 3);

    // offers=1: المخفضة فقط مرتبة بالخصم الأكبر أولاً
    const offersList = await req('GET', '/api/market/stores/1/products?offers=1');
    ok('offers filter returns discounted only, biggest first',
      offersList.status === 200 && offersList.data.products.length === 2 &&
      offersList.data.products[0].discount_pct === 20 &&
      offersList.data.products[0].final_minor === 2680 &&
      offersList.data.products[1].discount_pct === 10);

    // per=1 (كان الحد الأدنى 10 قبل v4.5)
    const tinyPage = await req('GET', '/api/market/stores/1/products?per=1&page=2');
    ok('per=1 tiny pages allowed', tinyPage.status === 200 &&
      tinyPage.data.products.length === 1 && tinyPage.data.page === 2);

    // JSON مدمج: لا حقول فارغة في الرد الخام
    const compactRaw = await fetch(BASE + '/api/market/stores/1/products?per=10', {
      headers: {'Accept-Encoding': 'identity'},
    }).then(r => r.text());
    ok('compact json omits null/empty fields',
      !compactRaw.includes('"category":null') &&
      !compactRaw.includes('"images":[]') &&
      !compactRaw.includes('"sold_by_weight":0') &&
      compactRaw.includes('"discount_pct":20'));

    // طلب بمنتج مخفض: وفر الخصم يُحسب على الخادم ويُسجل على الطلب
    const buyer = await req('POST', '/api/market/auth/register', {
      body: {idNumber: '501' + String(Math.floor(100000 + Math.random() * 899999)),
        name: 'مشتري الخصومات', phone: '0599000001', password: 'buyer-12345'},
    });
    ok('discount buyer registered', buyer.status === 200 && buyer.data.token);
    const riceDisc = offersList.data.products.find(p2 => p2.product_ref === '101');
    const discOrder = await req('POST', '/api/market/orders', {
      marketToken: buyer.data.token,
      body: {
        storeId: 1,
        items: [{productId: riceDisc.id, quantity: 2}],
        regionName: 'المركز',
        address: 'شارع الخصومات 1',
      },
    });
    ok('discounted order: unit price after 20% off',
      discOrder.status === 200 &&
      discOrder.data.order.items[0].unit_price_minor === 2680 &&
      discOrder.data.order.items[0].line_total_minor === 5360);
    ok('discounted order: items_discount_minor recorded',
      discOrder.data.order.items_discount_minor === 1340 &&
      discOrder.data.order.items_total_minor === 5360);

    // شعار المتجر عبر register (رفع بلا هاش — يُحسب على الخادم)
    const logoBytes = fakeWebp('L');
    const regLogo = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth,
        store: {name: 'سوبر ماركت النور ٢', phone: '0591234567'},
        deliveryRegions: [{name: 'المركز', feeMinor: 1200}, {name: 'المخيم', feeMinor: 1500}],
        published: true,
        logo: {data: logoBytes.toString('base64'), ext: 'webp', width: 512, height: 512},
      },
    });
    ok('store logo uploaded via register',
      regLogo.status === 200 && regLogo.data.store.logoUrl &&
      regLogo.data.store.logoUrl.includes('/api/market/img/1/'));
    const storesWithLogo = await req('GET', '/api/market/stores');
    ok('stores list carries logo_url',
      storesWithLogo.data.stores.some(s2 => s2.logo_url === regLogo.data.store.logoUrl));
    const detailLogo = await req('GET', '/api/market/stores/1');
    ok('store detail carries logo_url',
      detailLogo.data.store.logo_url === regLogo.data.store.logoUrl);
    const logoFetch = await fetch(BASE + regLogo.data.store.logoUrl);
    ok('logo image served', logoFetch.status === 200 &&
      logoFetch.headers.get('content-type') === 'image/webp');

    // مزامنة صور فارغة: الكنس لا يلمس شعار المتجر
    const imgSweep = await req('POST', '/api/v1/store/images/sync', {
      body: {...auth, images: [{ref: '101', items: []}]},
    });
    ok('image sweep ran', imgSweep.status === 200);
    const logoAfterSweep = await fetch(BASE + regLogo.data.store.logoUrl);
    ok('logo protected from orphan cleanup', logoAfterSweep.status === 200);

    // إزالة الشعار: logo:null
    const regNoLogo = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth,
        store: {name: 'سوبر ماركت النور ٢', phone: '0591234567'},
        deliveryRegions: [{name: 'المركز', feeMinor: 1200}, {name: 'المخيم', feeMinor: 1500}],
        published: true,
        logo: null,
      },
    });
    ok('logo removed with logo:null', regNoLogo.status === 200 &&
      regNoLogo.data.store.logoUrl == null);
    const storesNoLogo = await req('GET', '/api/market/stores');
    ok('stores list drops logo_url when absent',
      storesNoLogo.data.stores.every(s2 => s2.logo_url == null));

    // رفع صورة منتج مضمّناً (بلا هاش على العميل) عبر images/sync
    const inlineImg = fakeWebp('Q');
    const inlineSync = await req('POST', '/api/v1/store/images/sync', {
      body: {
        ...auth,
        images: [
          {ref: '102', items: [{data: inlineImg.toString('base64'), ext: 'webp', width: 640, height: 480, slot: 0}]},
        ],
      },
    });
    ok('inline image upload (server-side hash)',
      inlineSync.status === 200 && inlineSync.data.inline === 1);
    const oil = await req('GET', '/api/market/stores/1/products?q=' + encodeURIComponent('زيت'));
    ok('inline-uploaded product image visible',
      oil.data.products[0].images != null && oil.data.products[0].images.length === 1);

    // إدارة: مستخدمو المتجر + بطاقة المتجر الكاملة + إحصاءات موسعة
    const adminUsers = await req('GET', '/api/admin/market/users', {token: 'root-master-token'});
    ok('admin market users list',
      adminUsers.status === 200 && adminUsers.data.users.length > 0 &&
      adminUsers.data.users.every(u => u.orders_count != null));
    const fullStore = await req('GET', '/api/admin/market/stores/1/full', {token: 'root-master-token'});
    ok('admin store full view',
      fullStore.status === 200 && fullStore.data.products.length === 3 &&
      fullStore.data.deliveryRegions != null && fullStore.data.orders != null);
    const adminStats = await req('GET', '/api/admin/market/stats', {token: 'root-master-token'});
    ok('admin stats extended (discounts + ratings)',
      adminStats.status === 200 && adminStats.data.discountedProducts === 2 &&
      adminStats.data.ratingCount != null);
    const adminProfile = await req('POST', '/api/admin/market/stores/1/profile',
      {token: 'root-master-token', body: {name: 'سوبر ماركت النور ٢', category: 'بقالة'}});
    ok('admin store profile edit', adminProfile.status === 200);
    const buyerId = adminUsers.data.users.find(u => u.id_number === buyer.data.user.idNumber)?.id;
    const disableUser = await req('POST', `/api/admin/market/users/${buyerId}/disable`,
      {token: 'root-master-token', body: {disabled: true}});
    ok('admin user disable', disableUser.status === 200);
    const disabledOrder = await req('GET', '/api/market/orders', {marketToken: buyer.data.token});
    ok('disabled user session revoked', disabledOrder.status === 401);

    /* v4.6 — تحديث محتوى صفحة الهبوط (هجرة معلَّمة بإصدار) */
    const site = await req('GET', '/api/public/site');
    const feats = (site.data.features || []).map(f => f.icon);
    ok('landing v2 content: hero mentions online store',
      site.status === 200 && /سيلا ماركت/.test(site.data.hero.subtitle || '') &&
      /متجر أونلاين/.test(site.data.hero.title || '') && /منظومة/.test(site.data.hero.badge || ''),
      JSON.stringify(site.data.hero || {}));
    ok('landing v2 content: new ecosystem features present',
      feats.includes('mall') && feats.includes('percent') &&
      feats.includes('star') && feats.includes('fingerprint'),
      'icons=' + feats.join(','));
    ok('landing v2 content: version marker applied once',
      site.status === 200 && (site.data.features || []).length === 10,
      'features=' + (site.data.features || []).length);
    // idempotence: markers/edits by the admin survive (no re-run on same version)

    /* v4.6 — طلبات العميل تحمل logo_url للمتجر (مطلوب لبطاقات الطلبات في
     * التطبيق: OrderListCard بصورة حقيقية بدل حرف). أعدنا تفعيل المشتري
     * أولاً لأن اختبار التعطيل السابق أبطل جلسته، ثم سجّل دخوله من
     * جديد — التعطيل يمحو الجلسات ولا يستعيدها التفعيل. وأعدنا رفع
     * شعار المتجر لأن اختبار «logo:null» السابق أزاله. */
    const reenable = await req('POST', `/api/admin/market/users/${buyerId}/disable`,
      {token: 'root-master-token', body: {disabled: false}});
    ok('admin user re-enable', reenable.status === 200);
    const regLogo2 = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth,
        store: {name: 'سوبر ماركت النور ٢', phone: '0591234567'},
        deliveryRegions: [{name: 'المركز', feeMinor: 1200}, {name: 'المخيم', feeMinor: 1500}],
        published: true,
        logo: {data: fakeWebp('B').toString('base64'), ext: 'webp', width: 512, height: 512},
      },
    });
    ok('store logo re-uploaded for orders test',
      regLogo2.status === 200 && regLogo2.data.store.logoUrl != null);
    const buyerRelogin = await req('POST', '/api/market/auth/login',
      {body: {idNumber: buyer.data.user.idNumber, password: 'buyer-12345'}});
    ok('re-enabled user can login again', buyerRelogin.status === 200 && buyerRelogin.data.token);
    const buyerOrders = await req('GET', '/api/market/orders', {marketToken: buyerRelogin.data.token});
    const bo = (buyerOrders.data.orders || []).find(o => o.store_id === 1);
    ok('customer orders carry store logo_url',
      buyerOrders.status === 200 && bo && bo.store && bo.store.logo_url != null,
      JSON.stringify(bo && bo.store));

    /* ── v4.7: الإخفاء الإداري للمنتجات (يقاوم مزامنات POS) ── */
    const beforeHide = await req('GET', '/api/market/stores/1/products');
    const hideTarget = beforeHide.data.products[0];
    const hideIt = await req('POST', `/api/admin/market/products/${hideTarget.id}/visibility`,
      {token: 'root-master-token', body: {hidden: true}});
    ok('admin hide product', hideIt.status === 200 && hideIt.data.ok);
    const afterHide = await req('GET', '/api/market/stores/1/products');
    ok('hidden product gone from market',
      afterHide.status === 200 && !afterHide.data.products.some(p => p.id === hideTarget.id));
    const resyncAll = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: '101', name: 'أرز أبو كاس 5كغ', category: 'بقالة', priceMinor: 3350, stock: 12},
          {ref: '102', name: 'زيت دوار الشمس 1.5ل', category: 'بقالة', priceMinor: 1800, stock: 9},
          {ref: '103', name: 'طماطم', category: 'خضار', priceMinor: 400, stock: 30, soldByWeight: true, unitLabel: 'كيلو'},
          {ref: '104', name: 'تيشيرت قطن', category: 'ملابس', priceMinor: 5900, stock: 25,
            options: [{name: 'المقاس', values: ['S', 'M', 'L', 'XL']}]},
        ],
      },
    });
    ok('pos re-sync after hide', resyncAll.status === 200);
    const afterResync = await req('GET', '/api/market/stores/1/products');
    ok('admin hide survives pos re-sync',
      !afterResync.data.products.some(p => p.id === hideTarget.id));
    const fullCard = await req('GET', '/api/admin/market/stores/1/full', {token: 'root-master-token'});
    ok('full card lists hidden product with flag',
      fullCard.data.products.some(p => p.id === hideTarget.id && p.admin_hidden === 1));
    const showIt = await req('POST', `/api/admin/market/products/${hideTarget.id}/visibility`,
      {token: 'root-master-token', body: {hidden: false}});
    ok('admin show product', showIt.status === 200);
    const afterShow = await req('GET', '/api/market/stores/1/products');
    ok('shown product back in market',
      afterShow.data.products.some(p => p.id === hideTarget.id));
    const etagProbe = await fetch(BASE + '/api/market/stores', {headers: {'If-None-Match': 'W/"fake"'}});
    ok('no etag on api responses (304 chain killed)',
      etagProbe.status === 200 && etagProbe.headers.get('etag') == null);

    /* ══ v5.5 (الجولة 60): إصلاح «محاولات كثيرة» + النداء المجمّع ══ */

    // 1) تغذية الرئيسية المجمعة — طلب واحد يعيد كل شيء.
    const home = await req('GET', '/api/market/home');
    ok('home bulk feed returns stores+categories+latest',
      home.status === 200 && Array.isArray(home.data.stores) &&
      Array.isArray(home.data.categories) && Array.isArray(home.data.latest));
    ok('home feed includes published store with products',
      home.data.stores.some(s => s.id === 1) &&
      home.data.latest.some(p => p.store_id === 1));
    const homeRegion = await req('GET', '/api/market/home?region=' + encodeURIComponent('المركز'));
    ok('home feed with region returns regionStores with fee',
      homeRegion.status === 200 && Array.isArray(homeRegion.data.regionStores) &&
      homeRegion.data.regionStores.length > 0 &&
      homeRegion.data.regionStores.every(s => Number.isFinite(s.deliveryFeeMinor)));

    /* ── v5.7 (الجولة 69): تغيير مفتاح الاشتراك ───────────────
     * شكوى التاجر بالنص: «إذا تم فقدان الاتصال بالمتجر مثلاً بتغيير
     * مفتاح الاشتراك تبقى المنتجات موجودة، وإذا تم إعادة تفعيله يظهر
     * المتجر في التطبيق وكأنه متجر جديد بمنتجات متكررة وحتى فاقدة
     * للصور، ويعامل كأنه متجر جديد فيحدث تراكم ومنتجات غير متصلة
     * بأي متجر». الآن: المفتاح الجديد على نفس الجهاز يستعيد المتجر
     * الأصلي — نفس storeNumber، بلا صفوف مكررة، وبالصور المحفوظة. */
    const Database4 = require('better-sqlite3');
    const db4 = new Database4(path.join(DATA_DIR, 'sela-license.db'));
    db4.prepare('UPDATE keys SET plan_expires_at = ? WHERE key_plain = ?')
      .run(Date.now() - 2000, key);
    db4.close();
    const expiredAgain = await req('POST', '/api/v1/store/products/sync',
      {body: {...auth, products: []}});
    ok('subscription expired again → SUBSCRIPTION_ENDED', expiredAgain.status === 403 &&
      expiredAgain.data.error === 'SUBSCRIPTION_ENDED');
    const hiddenAgain = await req('GET', '/api/market/stores');
    ok('store hidden after expiry', hiddenAgain.data.stores.length === 0);

    const created4 = await req('POST', '/api/admin/keys', {
      token: 'root-master-token', body: {planDays: 60, count: 1, note: 'مفتاح بديل لنفس المتجر'},
    });
    ok('replacement key created', created4.status === 200 && created4.data.keys.length === 1);
    const key4 = created4.data.keys[0].key;
    const act4 = await req('POST', '/api/v1/activate',
      {body: {key: key4, deviceId: dev, deviceLabel: 'pos', appVersion: '48.0.0'}});
    ok('new key activated on SAME device', act4.status === 200 && act4.data.license);
    const auth4 = {license: act4.data.license, signature: act4.data.signature, deviceId: dev};

    const reg4 = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth4,
        store: {name: 'سوبر ماركت النور ٢', phone: '0591234567'},
        deliveryRegions: [{name: 'المركز', feeMinor: 1200}],
        published: true,
      },
    });
    ok('key change reuses ORIGINAL store (no new store)',
      reg4.status === 200 && reg4.data.ok &&
      reg4.data.store.storeNumber === republish.data.store.storeNumber,
      `got ${reg4.data.store && reg4.data.store.storeNumber}`);
    const stores4 = await req('GET', '/api/market/stores');
    ok('exactly one store after key change (no duplicates)',
      stores4.data.stores.length === 1 &&
      stores4.data.stores[0].store_number === republish.data.store.storeNumber);

    const syncNewKey = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth4,
        products: [
          {ref: '101', name: 'أرز أبو كاس 5كغ', category: 'بقالة', priceMinor: 3400, stock: 10, discountPct: 20},
          {ref: '102', name: 'زيت دوار الشمس 1.5ل', category: 'بقالة', priceMinor: 1800, stock: 9},
        ],
      },
    });
    ok('catalog synced under new key', syncNewKey.status === 200 && syncNewKey.data.saved === 2);
    const prodsNewKey = await req('GET', '/api/market/stores/1/products');
    const riceNewKey = prodsNewKey.data.products.filter(p => p.product_ref === '101');
    const oilNewKey = prodsNewKey.data.products.find(p => p.product_ref === '102');
    ok('no duplicated product rows after key change', riceNewKey.length === 1,
      `found ${riceNewKey.length} rows for ref 101`);
    ok('product images preserved after key change',
      oilNewKey != null && Array.isArray(oilNewKey.images) && oilNewKey.images.length === 1,
      'oil images=' + JSON.stringify(oilNewKey && oilNewKey.images));
    ok('store keeps its identity (same id/number/ratings)',
      prodsNewKey.status === 200 && stores4.data.stores[0].id === 1 &&
      stores4.data.stores[0].rating != null && stores4.data.stores[0].ratingCount >= 1);

    /* ── v5.8 (الجولة 70): الحل المزدوج — الاستعادة برقم المتجر ──
     * طلب التاجر بالنص: «تأكد من أن الحل مزدوج في مشكلة ازدواج
     * المتجر عند تغيير المفتاح حيث يعمل من خلال مفتاح الاشتراك
     * ورقم المتجر». مسار v5.7 أعلاه يغطي المفتاح الجديد على نفس
     * الجهاز (سجل التفعيلات). هذا المسار يغطي الحالة الثانية:
     * جهاز جديد كلياً (نقطة بيع بديلة/إعادة تثبيت) بلا أي سجل
     * تفعيلات — POS يرسل رقم متجره الدائم المحفوظ فيُستعاد الأصل. */
    const savedStoreNumber = reg4.data.store.storeNumber;
    const Database5 = require('better-sqlite3');
    const db5 = new Database5(path.join(DATA_DIR, 'sela-license.db'));
    db5.prepare('UPDATE keys SET plan_expires_at = ? WHERE key_plain = ?')
      .run(Date.now() - 2000, key4);
    db5.close();
    const expired5 = await req('POST', '/api/v1/store/products/sync',
      {body: {...auth4, products: []}});
    ok('replacement key expired too → SUBSCRIPTION_ENDED',
      expired5.status === 403 && expired5.data.error === 'SUBSCRIPTION_ENDED');

    // مفتاح ثالث على جهاز جديد كلياً — لا سجل تفعيلات إطلاقاً.
    const created5 = await req('POST', '/api/admin/keys', {
      token: 'root-master-token', body: {planDays: 60, count: 1, note: 'مفتاح على جهاز جديد'},
    });
    ok('key for NEW device created', created5.status === 200 && created5.data.keys.length === 1);
    const key5 = created5.data.keys[0].key;
    const freshDev = 'fresh-pos-device-999';
    const act5 = await req('POST', '/api/v1/activate',
      {body: {key: key5, deviceId: freshDev, deviceLabel: 'pos2', appVersion: '62.0.0'}});
    ok('new key activated on BRAND-NEW device', act5.status === 200 && act5.data.license);
    const auth5 = {license: act5.data.license, signature: act5.data.signature, deviceId: freshDev};

    // register يرسل رقم المتجر المحفوظ (كما يفعل POS منذ v58).
    const reg5 = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth5,
        store: {name: 'سوبر ماركت النور ٣', phone: '0591234567', storeNumber: savedStoreNumber},
        deliveryRegions: [{name: 'المركز', feeMinor: 1200}],
        published: true,
      },
    });
    ok('NEW device + number hint → ORIGINAL store recovered (no duplicate)',
      reg5.status === 200 && reg5.data.ok &&
      reg5.data.store.storeNumber === savedStoreNumber,
      `got ${reg5.data.store && reg5.data.store.storeNumber}`);
    const stores5 = await req('GET', '/api/market/stores');
    ok('still exactly ONE store after new-device key change',
      stores5.data.stores.length === 1 &&
      stores5.data.stores[0].store_number === savedStoreNumber);

    // الصور والتقييمات باقية على المتجر المستعاد برقمه.
    const syncNewDev = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth5,
        products: [
          {ref: '101', name: 'أرز أبو كاس 5كغ', category: 'بقالة', priceMinor: 3400, stock: 10, discountPct: 20},
          {ref: '102', name: 'زيت دوار الشمس 1.5ل', category: 'بقالة', priceMinor: 1800, stock: 9},
        ],
      },
    });
    ok('catalog synced under new device key', syncNewDev.status === 200 && syncNewDev.data.saved === 2);
    const prodsNewDev = await req('GET', '/api/market/stores/1/products');
    const riceNewDev = prodsNewDev.data.products.filter(p => p.product_ref === '101');
    ok('no duplicated rows after number-recovery', riceNewDev.length === 1,
      `found ${riceNewDev.length} rows for ref 101`);
    const oilNewDev = prodsNewDev.data.products.find(p => p.product_ref === '102');
    ok('images preserved after number-recovery',
      oilNewDev != null && Array.isArray(oilNewDev.images) && oilNewDev.images.length === 1,
      'oil images=' + JSON.stringify(oilNewDev && oilNewDev.images));

    /* حارس الأمان: متجر حي بمفتاح نشط لا يُختطف برقمه — جهاز رابع
     * بمفتاح رابع يحاول التسجيل بنفس الرقم لا ينال المتجر الحي
     * بل يُنشأ له متجر جديد برقم مختلف تماماً. */
    const created6 = await req('POST', '/api/admin/keys', {
      token: 'root-master-token', body: {planDays: 30, count: 1, note: 'اختبار خطف الرقم'},
    });
    const key6 = created6.data.keys[0].key;
    const act6 = await req('POST', '/api/v1/activate',
      {body: {key: key6, deviceId: 'attacker-device-666', deviceLabel: 'x', appVersion: '62.0.0'}});
    const auth6 = {license: act6.data.license, signature: act6.data.signature, deviceId: 'attacker-device-666'};
    const hijack = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth6,
        store: {name: 'متجر مزعج', phone: '05', storeNumber: savedStoreNumber},
        deliveryRegions: [],
        published: true,
      },
    });
    ok('LIVE store with ACTIVE key can NOT be hijacked by its number',
      hijack.status === 200 && hijack.data.ok &&
      hijack.data.store.storeNumber !== savedStoreNumber,
      `got ${hijack.data.store && hijack.data.store.storeNumber}`);
    const stores6 = await req('GET', '/api/market/stores');
    ok('hijacker got his own NEW store (two stores, numbers differ)',
      stores6.data.stores.length === 2 &&
      stores6.data.stores.filter(s => s.store_number === savedStoreNumber).length === 1);

    // 2) سلوك حدود المعدل يُختبر على خادم مخصص أدناه (الخادم الرئيسي
    //    يعمل بـ RATE_LIMIT=9999 كي لا تعترض الحدودُ جناح الاختبار).

  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    server.kill('SIGKILL');
  }

  /* ══ v5.5: خادم مخصص لاختبار حدود المعدل الحقيقية ══════════════
   * RATE_LIMIT=12 (عام) و RATE_LIMIT_MARKET_GET=25 (قراءات المال):
   *  • 40 صورة متتالية لا تُقفل مطلقاً (الصور معفاة).
   *  • قراءات المال تعمل بعد استنفاد السقف العام (سلة مستقلة).
   *  • السقف العام نفسه ما زال يعمل (طلب 13+ على مسار غير معفى = 429).
   */
  {
    const PORT2 = 3997;
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    const DATA_DIR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-rl-'));
    const env2 = {
      ...env,
      PORT: String(PORT2),
      DATA_DIR: DATA_DIR2,
      RATE_LIMIT: '12',
      RATE_LIMIT_MARKET_GET: '25',
    };
    const server2 = spawn(process.execPath, [path.join(__dirname, 'src', 'server.js')], {
      env: env2, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('rl server boot timeout')), 15000);
        const onData = d => {
          if (String(d).includes('listening on')) { clearTimeout(t); resolve(); }
        };
        server2.stdout.on('data', onData);
        server2.on('exit', code => {
          clearTimeout(t);
          reject(new Error('rl server exited early code=' + code));
        });
      });

      // السقف العام: 12 نداءً على /api/public/site (غير معفى) ثم 429.
      let hit429At = -1;
      for (let i = 1; i <= 20; i++) {
        const r = await fetch(BASE2 + '/api/public/site');
        if (r.status === 429) { hit429At = i; break; }
      }
      ok('general rate limit enforced after 12 requests', hit429At === 13,
        `first 429 at request #${hit429At}`);

      // قراءات المال: سلتها مستقلة — تعمل رغم استنفاد السقف العام.
      const cfg = await fetch(BASE2 + '/api/market/config');
      ok('market reads use separate bucket (works after general exhausted)',
        cfg.status === 200);

      // سقف قراءات المال نفسه يعمل: 25 ثم 429 (سبق 1 نداء config = 26th).
      let market429At = -1;
      for (let i = 1; i <= 30; i++) {
        const r = await fetch(BASE2 + '/api/market/categories');
        if (r.status === 429) { market429At = i; break; }
      }
      ok('market bucket enforces its own ceiling (429 after 25)', market429At === 25,
        `first 429 at market read #${market429At}`);

      // الصور معفاة كلياً: حتى بعد استنفاد كل السلال أعلاه، 40 صورة
      // (مسار غير موجود كافٍ لإثبات الإعفاء — 429 ≠ 404).
      let imgExempt = true;
      for (let i = 0; i < 40; i++) {
        const r = await fetch(BASE2 + '/api/market/img/1/deadbeefdeadbeef.webp');
        if (r.status === 429) { imgExempt = false; break; }
      }
      ok('images fully exempt from rate limiting (404 not 429)', imgExempt);
    } finally {
      server2.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 300));
      server2.kill('SIGKILL');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
