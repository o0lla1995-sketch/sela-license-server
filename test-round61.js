/**
 * test-round61.js — v5.6 (الجولة 61): اختبارات حرّوس الإصلاحات.
 * ─────────────────────────────────────────────────────────────────
 *  1. الخلل الخطير: «تجهيز وفاتورة» بدون «قبول» — البائع كان يضغط
 *     الإرسال مباشرة على طلب «جديد» فتُسجّل الفاتورة محلياً بينما
 *     يرفض الخادم الانتقال (BAD_STATUS مبتلع) فيبقى مستخدم المتجر
 *     «بانتظار قبول المتجر» إلى الأبد. الآن: الإرسال من «جديد»
 *     يعمل ويُثبت accepted_at ضمنياً.
 *  2. إعادة الإبلاغ بنفس الفاتورة idempotent (مسار إعادة المحاولة
 *     في POS بعد انقطاع شبكة) — لا رفض ولا ازدواج.
 *  3. المسار القديم الكامل (قبول → إرسال → تسليم) ما زال يعمل.
 *  4. نقطة النهاية الجديدة /products/availability — تنظيف المفضلة:
 *     طلب التاجر: «كما يختفي المنتج عند إلغاء تفعيله وظهوره في
 *     المتجر أن يختفي من قائمة المفضلة ولا يبقى محفوظاً».
 *
 * Run: node test-round61.js
 */
'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-r61-'));

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
  console.log('server booted (round-61 guards, port ' + PORT + ')\n');

  try {
    /* ══ أ) تجهيز التاجر ═════════════════════════════════════════ */

    await req('POST', '/api/admin/auth/login',
      {body: {email: 'owner@sela.test', password: 'owner-pass-123'}});

    const created = await req('POST', '/api/admin/keys', {
      token: 'root-master-token',
      body: {planDays: 30, maxDevices: 2, count: 1, note: 'حرّوس الجولة 61'},
    });
    const key = created.data.keys[0].key;

    const dev = 'r61-device-1';
    const act = await req('POST', '/api/v1/activate',
      {body: {key, deviceId: dev, deviceLabel: 'pos', appVersion: '57.0.0'}});
    ok('A1: تفعيل جهاز نقطة البيع', act.status === 200 && act.data.license);
    const auth = {license: act.data.license, signature: act.data.signature, deviceId: dev};

    const reg = await req('POST', '/api/v1/store/register', {
      body: {
        ...auth,
        store: {name: 'بقالية الحرّوس', category: 'بقالة', region: 'غزة',
          phone: '0591000000', whatsapp: '0591000000', description: ''},
        deliveryRegions: [{name: 'الشجاعية', feeMinor: 500}],
        published: true,
      },
    });
    ok('A2: تسجيل المتجر', reg.status === 200 && reg.data.ok);

    const sync = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: 'P1', name: 'أرز 5كغ', category: 'بقالة', priceMinor: 4200, stock: 10},
          {ref: 'P2', name: 'زيت 1ل', category: 'بقالة', priceMinor: 2900, stock: 6},
          {ref: 'P3', name: 'سكر 1كغ', category: 'بقالة', priceMinor: 700, stock: 8},
        ],
      },
    });
    ok('A3: مزامنة 3 منتجات', sync.status === 200 && sync.data.saved === 3);

    /* ══ ب) الخلل الخطير: تجهيز وفاتورة بلا قبول ════════════════ */

    const ureg = await req('POST', '/api/market/auth/register',
      {body: {idNumber: '405559999', name: 'سلوي الحرّوس', phone: '0593333333',
        password: 'r61-pass-1234'}});
    ok('B1: تسجيل الزبون', ureg.status === 200 && ureg.data.token);
    const mtok = ureg.data.token;

    const catalog = await req('GET', '/api/market/stores/1/products');
    const rice = catalog.data.products.find(p => p.product_ref === 'P1');

    const orderRes = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [{productId: rice.id, quantity: 2}],
        regionName: 'الشجاعية',
        address: 'الشجاعية، شارع 1',
        clientRequestId: 'r61-press-' + Date.now(),
      },
    });
    const o1 = orderRes.data.order ?? {};
    ok('B2: الطلب وُضع بحالة «جديد»',
      orderRes.status === 200 && o1.status === 'new');

    /* البائع يضغط «تجهيز وفاتورة» مباشرة — بلا زر القبول. */
    const directSend = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: o1.order_number, action: 'send',
        invoiceRef: 'INV-O-6101'}});
    ok('B3: ⚑ الإرسال المباشر من «جديد» يُقبل (الخلل الخطير)',
      directSend.status === 200 && directSend.data.ok === true &&
      directSend.data.order.status === 'sent' &&
      directSend.data.order.invoice_ref === 'INV-O-6101',
      'status=' + directSend.status + ' body=' + JSON.stringify(directSend.data).slice(0, 160));
    ok('B4: القبول الضمني مُثبت (accepted_at)',
      directSend.status === 200 &&
      directSend.data.order.accepted_at != null &&
      directSend.data.order.sent_at != null,
      'accepted_at=' + (directSend.data.order && directSend.data.order.accepted_at));

    /* ما يراه المستخدم في المتجر — يجب ألا يبقى «بانتظار القبول». */
    const myOrders = await req('GET', '/api/market/orders', {marketToken: mtok});
    const seen = (myOrders.data.orders ?? []).find(x => x.order_number === o1.order_number);
    ok('B5: مستخدم المتجر يرى الطلب «مرسلاً» (لا عالقاً بانتظار القبول)',
      myOrders.status === 200 && seen != null && seen.status === 'sent',
      'seen=' + JSON.stringify(seen && seen.status));

    /* إعادة الإبلاغ بنفس الفاتورة — مسار إعادة المحاولة في POS. */
    const resend = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: o1.order_number, action: 'send',
        invoiceRef: 'INV-O-6101'}});
    ok('B6: إعادة الإبلاغ بنفس الفاتورة idempotent (لا ازدواج ولا رفض)',
      resend.status === 200 && resend.data.ok === true &&
      resend.data.order.status === 'sent' &&
      resend.data.order.invoice_ref === 'INV-O-6101');

    const deliverR = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: o1.order_number, action: 'deliver'}});
    ok('B7: تأكيد التسليم بعد الإرسال المباشر',
      deliverR.status === 200 && deliverR.data.order.status === 'delivered');

    /* ══ ج) المسار القديم (قبول → إرسال) ما زال يعمل ════════════ */

    const order2 = await req('POST', '/api/market/orders', {
      marketToken: mtok,
      body: {
        storeId: 1,
        items: [{productId: rice.id, quantity: 1}],
        regionName: 'الشجاعية',
        address: 'الشجاعية، شارع 2',
        clientRequestId: 'r61-press2-' + Date.now(),
      },
    });
    const o2 = order2.data.order ?? {};
    const acceptR = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: o2.order_number, action: 'accept'}});
    const send2 = await req('POST', '/api/v1/store/orders/action',
      {body: {...auth, orderNumber: o2.order_number, action: 'send',
        invoiceRef: 'INV-O-6102'}});
    ok('C1: المسار القديم قبول→إرسال سليم',
      acceptR.status === 200 && acceptR.data.order.status === 'accepted' &&
      send2.status === 200 && send2.data.order.status === 'sent');

    /* ══ د) فحص توفر المنتجات — تنظيف المفضلة ═══════════════════ */

    const ids = catalog.data.products.map(p => p.id).join(',');
    const avail1 = await req('GET', '/api/market/products/availability?ids=' + ids);
    ok('D1: نقطة النهاية تعيد الثلاثة متاحة',
      avail1.status === 200 && avail1.data.ok === true &&
      Array.isArray(avail1.data.available) && avail1.data.available.length === 3,
      JSON.stringify(avail1.data).slice(0, 120));

    /* التاجر يوقف عرض «سكر 1كغ» — مزامنة بلا P3 → available=0. */
    const sync2 = await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...auth,
        products: [
          {ref: 'P1', name: 'أرز 5كغ', category: 'بقالة', priceMinor: 4200, stock: 7},
          {ref: 'P2', name: 'زيت 1ل', category: 'بقالة', priceMinor: 2900, stock: 6},
        ],
      },
    });
    ok('D2: مزامنة بلا «سكر» (إيقاف العرض)', sync2.status === 200 && sync2.data.saved === 2);

    const sugar = catalog.data.products.find(p => p.product_ref === 'P3');
    const avail2 = await req('GET',
      '/api/market/products/availability?ids=' + ids);
    ok('D3: ⚑ السكر الموقوف يختفي من المتاح (يُشطب من المفضلة)',
      avail2.status === 200 &&
      avail2.data.available.includes(rice.id) &&
      avail2.data.available.includes(catalog.data.products.find(p => p.product_ref === 'P2').id) &&
      !avail2.data.available.includes(sugar.id),
      JSON.stringify(avail2.data));

    /* الكتالوج العام يتطابق مع الإتاحة (لا انفصام بين المصدرين). */
    const catalog2 = await req('GET', '/api/market/stores/1/products');
    ok('D4: الكتالوج العام أسقط السكر كذلك',
      catalog2.data.products.length === 2 &&
      !catalog2.data.products.some(p => p.product_ref === 'P3'));

    const empty = await req('GET', '/api/market/products/availability?ids=');
    ok('D5: معرفات فارغة → قائمة فارغة (لا خطأ)',
      empty.status === 200 && empty.data.ok && empty.data.available.length === 0);

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    server.kill();
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error('FATAL:', e.message);
    console.error(errLines.join(''));
    server.kill();
    process.exit(1);
  }
}

main();
