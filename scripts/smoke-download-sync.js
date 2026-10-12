#!/usr/bin/env node
/**
 * smoke-download-sync.js — اختبار سريع لمزامنة رابط أحدث إصدار APK.
 * 1) مجلد بيانات مؤقت + require db.js (يبذر الجداول)
 * 2) نزرع رابطاً بنمط v43 (مفعّلًا) — نفس حالة الإنتاج الحالية
 * 3) require site.js — يشعل المزامنة عند الإقلاع
 * 4) نتحقق أن الرابط تحدّث إلى أحدث إصدار من GitHub
 * 5) نتحقق أن رابطاً مخصصاً وآخر معطّلاً لا يُمسان
 */
'use strict';

const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-dlsync-'));
const env = {...process.env, DATA_DIR, PORT: '3997'};

// (1)+(2)+(3) في عملية واحدة: نبذر ثم نعدّل الصف ثم نشعل المزامنة عبر require
const probe = `
const ROOT = ${JSON.stringify(path.dirname(__dirname))};
const {stmt} = require(ROOT + '/src/db');
// زرع رابط بنمط v43 — نفس حالة الإنتاج
stmt.upsertDownloadLink.run('direct_apk',
  'https://github.com/o0lla1995-sketch/sela/releases/download/v43.0.0/Sela-v43.0.0.apk',
  'تحميل مباشر APK', 1, 2, Date.now());
// رابط مخصص لمستودع آخر — يجب ألا يُمس
stmt.upsertDownloadLink.run('desktop', 'https://example.com/my-build.apk', 'نسخة خاصة', 1, 3, Date.now());
// منصة معطلة — يجب ألا تُمس
stmt.upsertDownloadLink.run('apple_store', 'https://github.com/o0lla1995-sketch/sela/releases/download/v43.0.0/old.ipa', 'آب ستور', 0, 4, Date.now());

require(ROOT + '/src/site'); // يشعل syncLatestPosRelease() عند الإقلاع

setTimeout(async () => {
  const {stmt: st} = require(ROOT + '/src/db');
  const apk = st.downloadLinkByPlatform.get('direct_apk');
  const desktop = st.downloadLinkByPlatform.get('desktop');
  const apple = st.downloadLinkByPlatform.get('apple_store');
  const ok = (name, cond, extra) => {
    console.log(cond ? '  ✓ ' + name : '  ✗ ' + name + ' | ' + (extra || ''));
    if (!cond) process.exitCode = 1;
  };
  ok('direct_apk updated away from v43',
    apk.url.includes('/v43.0.0/') === false && /github\\.com\\/o0lla1995-sketch\\/sela\\/releases\\/download\\//.test(apk.url),
    apk.url);
  ok('direct_apk points to the latest tag (v50)', /\\/v50\\.0\\.0\\//.test(apk.url), apk.url);
  ok('custom link untouched', desktop.url === 'https://example.com/my-build.apk', desktop.url);
  ok('disabled platform untouched (still v43-style, still disabled)',
    apple.enabled === 0 && apple.url.includes('/v43.0.0/'), JSON.stringify(apple));
}, 2500);
`;
fs.writeFileSync(path.join(DATA_DIR, 'probe.js'), probe);
const r = spawnSync(process.execPath, [path.join(DATA_DIR, 'probe.js')], {
  env, cwd: __dirname, encoding: 'utf8', timeout: 20000,
});
console.log(r.stdout || '');
if (r.stderr) console.error(r.stderr.slice(0, 500));
process.exit(r.status || 0);
