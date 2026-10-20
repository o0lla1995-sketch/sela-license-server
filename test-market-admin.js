/**
 * test-market-admin.js — v5.9 (الجولة 71): إدارة المتاجر والمنتجات
 * في لوحة التحكم — اختبار تكاملي كامل.
 * ─────────────────────────────────────────────────────────────────
 * يغطي طلب المالك: «مميزات وخيارات أشمل وأوسع لعرض المنتجات
 * وتفاصيلها وإمكانية إخفائها… وكل الإجراءات المطلوبة في المتجر
 * سواء للمستخدمين أو المتاجر أو المنتجات نفسها، وتنظيف المنتجات
 * التي لم تعد مرتبطة بأي متجر وبقيت معروضة دون تنظيف».
 *
 *  1) متجر حي: كتالوج الإدارة (بحث/فلاتر/صفحات/تفاصيل/صور)
 *  2) إخفاء/إظهار مفرد + جماعي + حذف مفرد (بتأكيد السلوك)
 *  3) زبائن المتجر (بعد طلب حقيقي من مستخدم)
 *  4) متجر ميت (اشتراك منتهٍ > ١٤ يوماً):
 *     يظهر في قائمة المتاجر بعلامة موته + فحص اليتامى + التنظيف
 *     (إخفاء ثم حذف) + حماية المتجر الحي + حماية ذي الطلبات
 *     + حذف متجر ميت بلا طلبات نهائياً
 *  5) الإحصاءات: «منتجات معروضة» يستثني الميتة + «يتيمة» رقم صريح
 *
 * Run: node test-market-admin.js
 */
'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-mkt-admin-'));

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

async function makeLiveStore(note, storeName, region) {
  const created = await req('POST', '/api/admin/keys', {
    token: 'root-master-token',
    body: {planDays: 60, maxDevices: 2, count: 1, note},
  });
  const key = created.data.keys[0].key;
  const dev = note + '-dev-1';
  const act = await req('POST', '/api/v1/activate',
    {body: {key, deviceId: dev, deviceLabel: 'pos', appVersion: '59.0.0'}});
  const auth = {license: act.data.license, signature: act.data.signature, deviceId: dev};
  const reg = await req('POST', '/api/v1/store/register', {
    body: {
      ...auth,
      store: {name: storeName, category: 'بقالة', region,
        phone: '0591234567', whatsapp: ''},
      deliveryRegions: [{name: region, feeMinor: 500}],
      published: true,
    },
  });
  return {auth, storeId: reg.data.store.id, keyId: created.data.keys[0].id};
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
    /* ── 1) متجر حي + كتالوج غني ─────────────────────────── */
    const s1 = await makeLiveStore('متجر حي', 'متجر الحياة', 'الشمال');
    ok('live store registered', s1.storeId > 0);

    await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...s1.auth,
        products: [
          {ref: 'A', name: 'تفاح أحمر', priceMinor: 1000, stock: 10,
            barcode: '111222333', category: 'فواكه'},
          {ref: 'B', name: 'موز أصفر', priceMinor: 2000, stock: 2, discountPct: 20},
          {ref: 'C', name: 'عنب أسود', priceMinor: 3000, stock: 0,
            soldByWeight: true, unitLabel: 'كجم'},
          {ref: 'D', name: 'تمر مجهول', priceMinor: 4000, stock: 4},
        ],
      },
    });
    // مزامنة ثانية بلا «تمر مجهول» → يُسحب (available=0)
    await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...s1.auth,
        products: [
          {ref: 'A', name: 'تفاح أحمر', priceMinor: 1000, stock: 10,
            barcode: '111222333', category: 'فواكه'},
          {ref: 'B', name: 'موز أصفر', priceMinor: 2000, stock: 2, discountPct: 20},
          {ref: 'C', name: 'عنب أسود', priceMinor: 3000, stock: 0,
            soldByWeight: true, unitLabel: 'كجم'},
        ],
      },
    });

    const admin = 'root-master-token';
    const cat = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?per=50`, {token: admin});
    ok('admin catalog: total 4 (المسحوب يظهر للإدارة)',
      cat.status === 200 && cat.data.total === 4, JSON.stringify(cat.data).slice(0, 120));
    const byRef = {};
    (cat.data.products || []).forEach((p) => { byRef[p.product_ref] = p; });
    ok('admin catalog: full details (barcode/unit/weight/discount)',
      byRef.A && byRef.A.barcode === '111222333' &&
      byRef.C && byRef.C.sold_by_weight === 1 && byRef.C.unit_label === 'كجم' &&
      Number(byRef.B.discount_pct) === 20);
    ok('admin catalog: withdrawn product flagged (available=0)',
      byRef.D && byRef.D.available === 0);

    const searched = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?q=${encodeURIComponent('تفاح')}`,
      {token: admin});
    ok('admin catalog: search by name', searched.data.total === 1 &&
      searched.data.products[0].product_ref === 'A');

    const byBarcode = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?q=111222333`, {token: admin});
    ok('admin catalog: search by barcode', byBarcode.data.total === 1);

    const offers = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?filter=offers`, {token: admin});
    ok('filter offers → B فقط', offers.data.total === 1 &&
      offers.data.products[0].product_ref === 'B');

    const outofstock = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?filter=outofstock`, {token: admin});
    ok('filter outofstock → C فقط', outofstock.data.total === 1 &&
      outofstock.data.products[0].product_ref === 'C');

    const withdrawn = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?filter=unavailable`, {token: admin});
    ok('filter unavailable → D فقط', withdrawn.data.total === 1 &&
      withdrawn.data.products[0].product_ref === 'D');

    const page1 = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?per=2&page=1`, {token: admin});
    const page2 = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?per=2&page=2`, {token: admin});
    ok('admin catalog: pagination (2+2 من 4)',
      page1.data.products.length === 2 && page2.data.products.length === 2 &&
      page1.data.total === 4);

    /* ── 2) إخفاء/إظهار/حذف — مفرد وجماعي ────────────────── */
    const hideA = await req('POST',
      `/api/admin/market/products/${byRef.A.id}/visibility`,
      {token: admin, body: {hidden: true}});
    ok('hide A (admin decision)', hideA.status === 200);
    const adminHidden = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?filter=adminhidden`, {token: admin});
    ok('filter adminhidden → A', adminHidden.data.total === 1 &&
      adminHidden.data.products[0].product_ref === 'A');
    const showA = await req('POST',
      `/api/admin/market/products/${byRef.A.id}/visibility`,
      {token: admin, body: {hidden: false}});
    ok('show A again', showA.status === 200);

    const bulkHide = await req('POST', '/api/admin/market/products/bulk',
      {token: admin, body: {ids: [byRef.B.id, byRef.C.id], action: 'hide'}});
    ok('bulk hide B+C', bulkHide.status === 200 && bulkHide.data.affected === 2);
    const bulkShow = await req('POST', '/api/admin/market/products/bulk',
      {token: admin, body: {ids: [byRef.B.id, byRef.C.id], action: 'show'}});
    ok('bulk show B+C', bulkShow.status === 200 && bulkShow.data.affected === 2);
    const afterBulk = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?filter=available`, {token: admin});
    ok('available after bulk show = 3 (A,B,C)', afterBulk.data.total === 3);

    const delD = await req('POST',
      `/api/admin/market/products/${byRef.D.id}/delete`, {token: admin});
    ok('delete withdrawn product D permanently', delD.status === 200);
    const afterDel = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/products?per=50`, {token: admin});
    ok('catalog total now 3', afterDel.data.total === 3);

    /* ── 3) زبائن المتجر (بعد طلب حقيقي) ──────────────────── */
    await req('POST', '/api/market/auth/register', {
      body: {idNumber: '111222333', name: 'زبون المتجر', phone: '0599998888',
        password: 'pass-12345'},
    });
    const login = await req('POST', '/api/market/auth/login',
      {body: {idNumber: '111222333', password: 'pass-12345'}});
    ok('market user login', login.status === 200 && login.data.ok);
    const buyerToken = login.data.token;
    const pubProducts = await req('GET',
      `/api/market/stores/${s1.storeId}/products?per=10`);
    const apple = pubProducts.data.products.find((p) => p.name === 'تفاح أحمر');
    const orderRes = await req('POST', '/api/market/orders', {
      marketToken: buyerToken,
      body: {
        storeId: s1.storeId,
        items: [{productId: apple.id, quantity: 2}],
        regionName: 'الشمال',
        address: 'شارع الرئيسية 1',
      },
    });
    ok('order placed on live store', orderRes.status === 200 && orderRes.data.ok);

    const customers = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/customers`, {token: admin});
    ok('store customers: one buyer with one order',
      customers.status === 200 && customers.data.customers.length === 1 &&
      customers.data.customers[0].orders_count === 1 &&
      customers.data.customers[0].name === 'زبون المتجر');

    /* ── 4) متجر ميت: فحص + تنظيف + حمايات ───────────────── */
    const s2 = await makeLiveStore('متجر ميت بطلبات', 'متجر الأشباح', 'الجنوب');
    await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...s2.auth,
        products: [
          {ref: 'X', name: 'شبح 1', priceMinor: 500, stock: 3},
          {ref: 'Y', name: 'شبح 2', priceMinor: 600, stock: 4},
          {ref: 'Z', name: 'شبح 3', priceMinor: 700, stock: 5},
        ],
      },
    });
    // طلب من المتجر الثاني قبل موته (كي نختبر حماية ذي الطلبات)
    const ghostPub = await req('GET', `/api/market/stores/${s2.storeId}/products?per=10`);
    const ghostItem = ghostPub.data.products[0];
    const ghostOrder = await req('POST', '/api/market/orders', {
      marketToken: buyerToken,
      body: {
        storeId: s2.storeId,
        items: [{productId: ghostItem.id, quantity: 1}],
        regionName: 'الجنوب',
        address: 'حي الأشباح',
      },
    });
    ok('order placed on soon-dead store', ghostOrder.status === 200);

    const s3 = await makeLiveStore('متجر ميت نظيف', 'متجر الرماد', 'الوسط');
    await req('POST', '/api/v1/store/products/sync', {
      body: {
        ...s3.auth,
        products: [
          {ref: 'R1', name: 'رماد 1', priceMinor: 100, stock: 1},
          {ref: 'R2', name: 'رماد 2', priceMinor: 200, stock: 2},
        ],
      },
    });

    // موت المفتاحين: انتهاء قبل ٢٠ يوماً (تجاوز مهلة السماح ١٤)
    const Database = require('better-sqlite3');
    const db = new Database(path.join(DATA_DIR, 'sela-license.db'));
    const DAY = 24 * 3600 * 1000;
    const now = Date.now();
    db.prepare('UPDATE keys SET plan_expires_at = ? WHERE id IN (?, ?)')
      .run(now - 20 * DAY, s2.keyId, s3.keyId);
    db.close();

    const adminStores = await req('GET', '/api/admin/market/stores', {token: admin});
    const s2row = adminStores.data.stores.find((s) => s.id === s2.storeId);
    const s3row = adminStores.data.stores.find((s) => s.id === s3.storeId);
    const s1row = adminStores.data.stores.find((s) => s.id === s1.storeId);
    ok('dead stores visible in admin list with reason',
      s2row && s2row.deadReason === 'expired' &&
      s3row && s3row.deadReason === 'expired');
    ok('live store has no deadReason', s1row && s1row.deadReason == null);

    const scan1 = await req('GET', '/api/admin/market/stores/orphan-scan', {token: admin});
    const g2 = (scan1.data.groups || []).find((g) => g.store.id === s2.storeId);
    const g3 = (scan1.data.groups || []).find((g) => g.store.id === s3.storeId);
    ok('orphan scan: dead store 2 with 3 orphan products',
      g2 && g2.products === 3 && g2.reason === 'expired' && g2.orders === 1);
    ok('orphan scan: dead store 3 with 2 orphans, deletable (no orders)',
      g3 && g3.products === 2 && g3.deletableStore === true);
    ok('orphan scan: live store NOT listed',
      !(scan1.data.groups || []).some((g) => g.store.id === s1.storeId));

    /* الإحصاءات: المعروض يستثني الميت + اليتمة رقم صريح */
    const stats1 = await req('GET', '/api/admin/market/stats', {token: admin});
    ok('stats: ghost products counted (3+2=5)',
      stats1.data.ghostProducts === 5, 'ghost=' + stats1.data.ghostProducts);
    ok('stats: displayed products exclude dead stores (=3 للمتجر الحي)',
      stats1.data.products === 3, 'products=' + stats1.data.products);
    ok('stats: dead stores hidden from public market',
      stats1.data.publishedStores === 1);

    /* حماية المتجر الحي: تنظيف موجَّه إليه لا يمسه */
    const guard = await req('POST', '/api/admin/market/stores/orphan-clean',
      {token: admin, body: {storeIds: [s1.storeId], mode: 'delete'}});
    ok('live store protected from orphan-clean',
      guard.status === 200 && guard.data.stores === 0 && guard.data.productsDeleted === 0);
    const aliveDel = await req('POST',
      `/api/admin/market/stores/${s1.storeId}/delete`, {token: admin});
    ok('live store cannot be deleted (409 STORE_ALIVE)',
      aliveDel.status === 409 && aliveDel.data.error === 'STORE_ALIVE');

    /* حماية ذي الطلبات */
    const ordersDel = await req('POST',
      `/api/admin/market/stores/${s2.storeId}/delete`, {token: admin});
    ok('dead store with orders cannot be deleted (409 STORE_HAS_ORDERS)',
      ordersDel.status === 409 && ordersDel.data.error === 'STORE_HAS_ORDERS');

    /* التنظيف: إخفاء منتجات المتجر الميت ذي الطلبات */
    const hideGhosts = await req('POST', '/api/admin/market/stores/orphan-clean',
      {token: admin, body: {storeIds: [s2.storeId], mode: 'hide'}});
    ok('orphan-clean hide: 3 hidden',
      hideGhosts.status === 200 && hideGhosts.data.productsHidden === 3);
    const scan2 = await req('GET', '/api/admin/market/stores/orphan-scan', {token: admin});
    const g2b = (scan2.data.groups || []).find((g) => g.store.id === s2.storeId);
    ok('after hide: store 2 has 0 displayed orphans (3 unavailable)',
      g2b && g2b.products === 0 && g2b.unavailable === 3);

    /* التنظيف: حذف نهائي لمنتجات المتجر الميت النظيف ثم حذفه */
    const delGhosts = await req('POST', '/api/admin/market/stores/orphan-clean',
      {token: admin, body: {storeIds: [s3.storeId], mode: 'delete'}});
    ok('orphan-clean delete: 2 deleted',
      delGhosts.status === 200 && delGhosts.data.productsDeleted === 2);
    const delStore3 = await req('POST',
      `/api/admin/market/stores/${s3.storeId}/delete`, {token: admin});
    ok('dead store without orders deleted permanently',
      delStore3.status === 200 && delStore3.data.ok);
    const adminStores2 = await req('GET', '/api/admin/market/stores', {token: admin});
    ok('deleted store gone from admin list',
      !adminStores2.data.stores.some((s) => s.id === s3.storeId));
    const stats2 = await req('GET', '/api/admin/market/stats', {token: admin});
    ok('stats after cleanup: ghosts 0, displayed still 3',
      stats2.data.ghostProducts === 0 && stats2.data.products === 3,
      'ghost=' + stats2.data.ghostProducts + ' products=' + stats2.data.products);

    /* بطاقة المتجر الكاملة تشمل معلومات المفتاح والاشتراك */
    const full1 = await req('GET',
      `/api/admin/market/stores/${s1.storeId}/full`, {token: admin});
    ok('full card: key info + no dead reason',
      full1.status === 200 && full1.data.store.key_plain &&
      full1.data.store.subscriptionActive === true &&
      full1.data.store.deadReason == null);
    const full2 = await req('GET',
      `/api/admin/market/stores/${s2.storeId}/full`, {token: admin});
    ok('full card: dead store loads without crash (key info flags)',
      full2.status === 200 && full2.data.store.deadReason === 'expired' &&
      full2.data.store.subscriptionActive === false);

    console.log('\\n' + (passed + ' passed, ' + failed + ' failed'));
  } catch (e) {
    console.error('TEST CRASH:', e);
    failed += 1;
  } finally {
    server.kill();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
