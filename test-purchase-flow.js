/**
 * test-purchase-flow.js — v5.4 محاكاة تجربة شراء كاملة end-to-end.
 * ─────────────────────────────────────────────────────────────────
 * طلب التاجر بالنص: «بعد تعديل تطبيق متجر سيلا بشكل احترافي قم
 * بمحاكاة تجربة شراء وتأكد أن كل شيء يعمل ويصل إلى المتجر وخصوصاً
 * عند ضغط المستخدم زر إرسال الطلب — هل سيرسل الطلب أم لا؟».
 *
 * هذه المحاكاة تسلك المسار الحقيقي نفسه الذي يسلكه التطبيقان:
 *
 *  [تطبيق المتجر — رحلة الزبون الجديدة v2.8]
 *   1. تسجيل مستخدم + دخول (رمز جلسة)
 *   2. صفحة المنتج: جلب كتالوج المتجر (الكمية/الوزن تُختار هناك)
 *   3. السلة: جلب مناطق التوصيل (العنوان + المنطقة + الرسوم)
 *   4. ضغط «إتمام الطلب» → POST /api/market/orders بمفتاح
 *      إيديمبوتنسية (نفس ما يرسله الزر تماماً)
 *
 *  [نقطة البيع — استلام التاجر]
 *   5. الاستطلاع (poll) كما يستدعيه POS كل دورة: الطلب وصل؟
 *      بالأصناف الصحيحة؟ بالأسعار الصحيحة؟ بالعنوان والمنطقة
 *      والملاحظة وبيانات الزبون؟ ← «هل يصل الطلب للمتجر؟»
 *   6. دورة التاجر كاملة: قبول → إرسال (فاتورة INV-O) → تسليم
 *
 *  [سقف المخزون v5.4 — «لماذا يستطيع المستخدم طلب أكبر منها؟»]
 *   7. طلب أكبر من المتاح → 409 INSUFFICIENT_STOCK باسم المنتج
 *      والكمية المتاحة
 *   8. المخزون يُخصم ذرياً مع كل طلب ناجح (يظهر في الكتالوج فوراً)
 *   9. طلب آخر قطعة متاحة → نجاح → نفاد → أي طلب بعده يُرفض
 *  10. منتج سُحب من المتجر (أُخفي) → PRODUCT_UNAVAILABLE لا
 *      PRODUCT_NOT_FOUND
 *  11. إلغاء المستخدم قبل الإرسال → التاجر يرى الحالة الملغاة
 *
 *  [الإيديمبوتنسية v5.2 — «إعادة الضغط لا تنشئ طلباً مكرراً»]
 *  12. إعادة إرسال بنفس المفتاح → نفس رقم الطلب، لا نسخة ثانية
 *
 * Run: node test-purchase-flow.js
 */
'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-purchase-'));

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  ADMIN_EMAIL: 'owner@sela.test',
  ADMIN_PASSWORD: 'owner-pass-123',
  ADMIN_TOKEN: 'root-master-token',
  ADMIN_PATH_SECRET: 'test-secret-panel-2',
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
  console.log('server booted (purchase-flow simulation, port ' + PORT + ')\n');

  try {
    /* ══ أ) تجهيز التاجر — كما يفعل POS عند أول تشغيل ═══════════ */

    const admin = await req('POST', '/api/admin/auth/login',
      {body: {email: 'owner@sela.test', password: 'owner-pass-123'}});
    ok('A1: دخول الإدارة', admin.status === 200 && admin.data.ok);

    const created = await req('POST', '/api/admin/keys', {
      token: 'root-master-token',
      body: {planDays: 30, maxDevices: 2, count: 1, note: 'متجر محاكاة الشراء'},
    });
    const key = created.data.keys[0].key;

    const dev = 'purchase-sim-device-1';
    const act = await req('POST', '/api/v1/activate',
      {body: {key, deviceId: dev, deviceLabel: 'pos', appVersion: '56.0.0'}});
    ok('A2: تفعيل جهاز نقطة البيع', act.status === 200 && act.data.license);
    const auth = {license: act.data.license, signature: act.data.signature, deviceId: dev};

    const reg = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth,
        store: {name: 'بقالية المحاكاة', category: 'بقالة', region: 'غزة',
          phone: '0591111111', whatsapp: '0591111111', description: 'متجر محاكاة الشراء'},
        deliveryRegions: [
          {name: 'الشجاعية', feeMinor: 500},
          {name: 'الرمال', feeMinor: 800},
        ],
        published: true,
      },
    });
    ok('A3: تسجيل المتجر + مناطق التوصيل',
      reg.status === 200 && reg.data.ok && /^ST-/.test(reg.data.store.storeNumber));

    /* كتالوج بمخزون صغير مقصود — لاختبار السقف والنفاد. */
    const sync = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: 'P1', name: 'أرز بسمتي 5كغ', category: 'بقالة', priceMinor: 4200, stock: 5},
          {ref: 'P2', name: 'زيت زيتون 1ل', category: 'بقالة', priceMinor: 2900, stock: 3,
            discountPct: 10},
          {ref: 'P3', name: 'طماطم بلدي', category: 'خضار', priceMinor: 350, stock: 2.5,
            soldByWeight: true, unitLabel: 'كيلو'},
          {ref: 'P4', name: 'تيشيرت قطن', category: 'ملابس', priceMinor: 5500, stock: 4,
            options: [{name: 'المقاس', values: ['M', 'L', 'XL']}]},
        ],
      },
    });
    ok('A4: مزامنة 4 منتجات بمخزون محدود', sync.status === 200 && sync.data.saved === 4);

    /* ══ ب) رحلة الزبون — كما يتسلسلها تطبيق المتجر v2.8 ═══════ */

    const ureg = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '405551234', name: 'سالم المحاكي', phone: '0592222222',
        password: 'sim-pass-1234'}});
    ok('B1: تسجيل الزبون', ureg.status === 200 && ureg.data.token);
    const mtok = ureg.data.token;

    /* صفحة المنتج تقرأ الكتالوج — الكمية/الوزن تُختار هنا. */
    const catalog = await req('GET', '/api/market/stores/1/products');
    const prods = catalog.data.products;
    const rice = prods.find(p => p.product_ref === 'P1');
    const oil = prods.find(p => p.product_ref === 'P2');
    const tomato = prods.find(p => p.product_ref === 'P3');
    const tshirt = prods.find(p => p.product_ref === 'P4');
    ok('B2: صفحة المنتج ترى الكتالوج والمخزون',
      prods.length === 4 && rice.stock === 5 && oil.stock === 3 &&
      tomato.stock === 2.5 && tshirt.stock === 4);

    /* السلة تقرأ مناطق التوصيل ورسومها. */
    const detail = await req('GET', '/api/market/stores/1');
    ok('B3: السلة ترى مناطق التوصيل',
      detail.data.ok && detail.data.deliveryRegions.length === 2 &&
      detail.data.deliveryRegions.some(r => r.name === 'الشجاعية' && r.fee_minor === 500));

    /* ضغط «إتمام الطلب» — النداء الذي يرسله الزر حرفياً.
     * طلب واقعي: أرز 2 + طماطم 1.5 كيلو + تيشيرت بمقاسه. */
    const PRESS_1 = 'sim-press-0001-' + Date.now();
    const orderRes = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [
          {productId: rice.id, quantity: 2},
          {productId: tomato.id, quantity: 1.5},
          {productId: tshirt.id, quantity: 1, variant: 'المقاس: XL'},
        ],
        regionName: 'الشجاعية',
        address: 'حي الشجاعية، شارع الوحدة، بناية 12، الطابق 3',
        note: 'اتصل قبل الوصول بعشر دقائق',
        clientRequestId: PRESS_1,
      },
    });
    /* أسعار الخادم: أرز 2×4200=8400، طماطم 1.5×350=525، تيشيرت 5500
     * → منتجات 14425 + توصيل 500 = 14925. */
    const o = orderRes.data.order ?? {};
    ok('B4: ضغط «إتمام الطلب» → الطلب وُضع وقُبل',
      orderRes.status === 200 && orderRes.data.ok === true &&
      o.order_number != null && o.status === 'new',
      JSON.stringify(orderRes.data).slice(0, 200));
    ok('B5: الأسعار حُسبت من الخادم (لا من العميل)',
      o.items_total_minor === 14425 && o.delivery_fee_minor === 500 &&
      o.total_minor === 14925,
      'got items=' + o.items_total_minor + ' fee=' + o.delivery_fee_minor +
      ' total=' + o.total_minor);
    ok('B6: الرد كامل التفاصيل فوراً (أسطر + خيار المقاس + العنوان)',
      Array.isArray(o.items) && o.items.length === 3 &&
      o.items.some(it => it.variant === 'المقاس: XL' && it.product_name === 'تيشيرت قطن') &&
      o.address != null && o.note != null);
    const orderNumber = o.order_number;

    /* ══ ج) وصول الطلب للتاجر — جوهر سؤال التاجر ════════════════
     * «هل سوف يرسل الطلب أم لا؟» — الاستطلاع هنا هو أذن نقطة
     * البيع: ما تراه هذه الفقرة هو ما سيراه التاجر على جهازه. */

    const poll1 = await req('POST', '/api/v1/store/orders/poll',
      {body: {...auth, since: 0}});
    const polled = (poll1.data.orders ?? []).find(x => x.order_number === orderNumber);
    ok('C1: الطلب وصل إلى نقطة البيع (poll)',
      poll1.data.ok === true && polled != null,
      'orders=' + JSON.stringify((poll1.data.orders ?? []).map(x => x.order_number)));
    ok('C2: وصل بأصنافه الثلاثة وكمياته الدقيقة',
      polled != null && polled.items != null &&
      polled.items.length === 3 &&
      polled.items.some(it => it.product_name === 'أرز بسمتي 5كغ' && it.quantity === 2) &&
      polled.items.some(it => it.product_name === 'طماطم بلدي' && it.quantity === 1.5) &&
      polled.items.some(it => it.product_name === 'تيشيرت قطن' && it.variant === 'المقاس: XL'));
    ok('C3: وصل بمبلغده وعنوانه ومنطقته وملاحظته',
      polled != null && polled.total_minor === 14925 &&
      polled.region_name === 'الشجاعية' &&
      String(polled.address ?? '').includes('بناية 12') &&
      String(polled.note ?? '').includes('عشر دقائق'));
    ok('C4: وصل ببيانات الزبون (اسم/هاتف/هوية)',
      polled != null && polled.customer != null &&
      polled.customer.name === 'سالم المحاكي' &&
      polled.customer.phone === '0592222222' &&
      polled.customer.idNumber === '405551234');
    ok('C5: حالة الطلب «جديد» — بانتظار قرار التاجر',
      polled != null && polled.status === 'new');

    /* دورة التاجر كاملة: قبول → إرسال بفاتورة → تسليم. */
    const acceptR = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'accept'}});
    ok('C6: التاجر قبِل الطلب',
      acceptR.status === 200 && acceptR.data.order.status === 'accepted');
    const sendR = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'send', invoiceRef: 'INV-O-1001'}});
    ok('C7: التجهيز والإرسال بفاتورة INV-O',
      sendR.status === 200 && sendR.data.order.status === 'sent' &&
      sendR.data.order.invoice_ref === 'INV-O-1001');
    const deliverR = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber, action: 'deliver'}});
    ok('C8: تأكيد التسليم — الدورة اكتملت',
      deliverR.status === 200 && deliverR.data.order.status === 'delivered');

    /* ══ د) سقف المخزون — «لماذا يستطيع طلب أكبر منها؟» ══════════ */

    /* المخزون خُصم ذرياً: أرز 5−2=3، طماطم 2.5−1.5=1، تيشيرت 4−1=3. */
    const catalogAfter = await req('GET', '/api/market/stores/1/products');
    const rice2 = catalogAfter.data.products.find(p => p.product_ref === 'P1');
    const tomato2 = catalogAfter.data.products.find(p => p.product_ref === 'P3');
    const tshirt2 = catalogAfter.data.products.find(p => p.product_ref === 'P4');
    ok('D1: المخزون خُصم فوراً بعد الطلب (أرز 3، طماطم 1)',
      rice2.stock === 3 && tomato2.stock === 1 && tshirt2.stock === 3,
      'rice=' + rice2.stock + ' tomato=' + tomato2.stock + ' tshirt=' + tshirt2.stock);

    /* طلب أكبر من المتاح → رفض صريح باسم المنتج والمتاح. */
    const over = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [{productId: rice2.id, quantity: 4}],   // المتاح 3
        regionName: 'الرمال',
        address: 'حي الرمال',
        clientRequestId: 'sim-over-0001-' + Date.now(),
      },
    });
    ok('D2: طلب أكبر من المتاح يُرفض بـ INSUFFICIENT_STOCK',
      over.status === 409 && over.data.error === 'INSUFFICIENT_STOCK',
      'status=' + over.status + ' error=' + over.data.error);
    ok('D3: الرفض يسمّي المنتج والكمية المتاحة (واجهة السلة تعرضها)',
      over.data.productName === 'أرز بسمتي 5كغ' && over.data.available === 3,
      JSON.stringify(over.data));

    /* طلب كل المتبقي من الطماطم (1 كيلو) → نجاح → نفاد. */
    const PRESS_2 = 'sim-press-0002-' + Date.now();
    const lastTomato = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [{productId: tomato2.id, quantity: 1}],
        regionName: 'الرمال',
        address: 'حي الرمال',
        clientRequestId: PRESS_2,
      },
    });
    ok('D4: طلب آخر المتاح بالضبط ينجح',
      lastTomato.status === 200 && lastTomato.data.order.status === 'new');

    const catalogAfter2 = await req('GET', '/api/market/stores/1/products');
    const tomato3 = catalogAfter2.data.products.find(p => p.product_ref === 'P3');
    ok('D5: النفاد يظهر في الكتالوج فوراً (المخزون 0)',
      tomato3.stock === 0 || tomato3.stock === 0.0,
      'stock=' + tomato3.stock);

    /* بعد النفاد: أي كمية (حتى 1) تُرفض. */
    const starved = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [{productId: tomato3.id, quantity: 1}],
        regionName: 'الرمال',
        address: 'حي الرمال',
        clientRequestId: 'sim-starve-0001-' + Date.now(),
      },
    });
    ok('D6: الطلب على منتج نافد يُرفض (متاح 0)',
      starved.status === 409 && starved.data.error === 'INSUFFICIENT_STOCK' &&
      starved.data.available === 0);

    /* منتج سُحب من الكتالوج (مزامنة بدونه) → PRODUCT_UNAVAILABLE
     * لا PRODUCT_NOT_FOUND — السلة تعرض رسالة السحب الصحيحة. */
    await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: 'P1', name: 'أرز بسمتي 5كغ', category: 'بقالة', priceMinor: 4200, stock: 3},
          {ref: 'P3', name: 'طماطم بلدي', category: 'خضار', priceMinor: 350, stock: 0,
            soldByWeight: true, unitLabel: 'كيلو'},
          {ref: 'P4', name: 'تيشيرت قطن', category: 'ملابس', priceMinor: 5500, stock: 3},
        ],
      },
    });
    const delisted = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [{productId: oil.id, quantity: 1}],   // الزيت اختفى من المزامنة
        regionName: 'الرمال',
        address: 'حي الرمال',
        clientRequestId: 'sim-delisted-0001-' + Date.now(),
      },
    });
    ok('D7: منتج سُحب من المتجر → PRODUCT_UNAVAILABLE (لا NOT_FOUND)',
      delisted.status === 409 && delisted.data.error === 'PRODUCT_UNAVAILABLE' &&
      delisted.data.productName === 'زيت زيتون 1ل');

    /* ══ هـ) إلغاء المستخدم — التاجر يرى التحديث ════════════════ */

    const PRESS_3 = 'sim-press-0003-' + Date.now();
    const order3 = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [{productId: rice2.id, quantity: 1}],
        regionName: 'الشجاعية',
        address: 'حي الشجاعية',
        clientRequestId: PRESS_3,
      },
    });
    const cancelR = await req('POST',
      '/api/market/orders/' + order3.data.order.id + '/cancel',
      {marketToken: mtok, body: {}});
    ok('E1: المستخدم يلغي طلبه قبل الإرسال',
      cancelR.status === 200 && cancelR.data.order.status === 'cancelled');

    /* الاستطلاع يوصل الإلغاء للتاجر (updated_at يتقدم). */
    const poll2 = await req('POST', '/api/v1/store/orders/poll',
      {body: {...auth, since: 0}});
    const cancelledPolled = (poll2.data.orders ?? [])
      .find(x => x.order_number === order3.data.order.order_number);
    ok('E2: نقطة البيع ترى الطلب الملغى',
      cancelledPolled != null && cancelledPolled.status === 'cancelled');

    /* ══ و) الإيديمبوتنسية — «إعادة الضغط لا تكرر الطلب» ══════════ */

    const replay = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [{productId: rice2.id, quantity: 1}],
        regionName: 'الشجاعية',
        address: 'حي الشجاعية',
        clientRequestId: PRESS_3,        // نفس مفتاح الطلب الملغى
      },
    });
    ok('F1: إعادة الضغط بنفس المفتاح تعيد الطلب نفسه (لا تكرار)',
      replay.status === 200 &&
      replay.data.order.order_number === order3.data.order.order_number);
    const myOrders = await req('GET', '/api/market/orders', {marketToken: mtok});
    const dupCount = myOrders.data.orders
      .filter(x => x.order_number === order3.data.order.order_number).length;
    ok('F2: قائمة طلباتي بلا نسخ مكررة', dupCount === 1);

    /* ══ ز) الخلاصة ═══════════════════════════════════════════════ */

    console.log('\n════════════════════════════════════════════════');
    console.log('محاكاة الشراء: ' + passed + ' نجح · ' + failed + ' فشل');
    console.log('════════════════════════════════════════════════');
    if (failed === 0) {
      console.log('الخلاصة: ضغط «إتمام الطلب» يرسل الطلب فعلاً، ويصل');
      console.log('إلى نقطة البيع بأصنافه وأسعاره وعنوانه كاملة،');
      console.log('والمخزون يُحترم في كل مسار (سقف + خصم + نفاد + سحب).');
    }
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
    server.kill('SIGKILL');
    try { fs.rmSync(DATA_DIR, {recursive: true, force: true}); } catch (_) {}
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
