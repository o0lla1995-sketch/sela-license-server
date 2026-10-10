/**
 * verify-v32.js — targeted checks for the v3.2 changes:
 *   1. policy pages serve correctly (usage / privacy / deletion) + unknown → 404
 *   2. cache headers: panel + site css/js = no-cache, html = no-store
 *   3. panel index.html references versioned assets (?v=3.2)
 *   4. footer of the homepage contains the policy links
 */
'use strict';
const {spawn} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sela-v32-'));

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  ADMIN_EMAIL: 'owner@sela.test',
  ADMIN_PASSWORD: 'owner-pass-123',
  ADMIN_PATH_SECRET: 'verify-panel-1',
  ADMIN_TOKEN: 'root-token',
};

const child = spawn('node', ['src/server.js'], {env, stdio: 'ignore'});
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(p, raw) {
  const res = await fetch(BASE + p);
  const body = raw ? await res.text() : null;
  return {status: res.status, headers: res.headers, body};
}

function check(name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : ''));
  if (!ok) failed++;
}

(async () => {
  await sleep(1200);

  // ── 1) policy pages ──────────────────────────────────────────
  for (const [slug, title] of [
    ['usage', 'شروط الاستخدام وسياسة الاستخدام'],
    ['privacy', 'سياسة الخصوصية'],
    ['deletion', 'سياسة حذف البيانات'],
  ]) {
    const r = await req('/policies/' + slug, true);
    const ok = r.status === 200 &&
      r.body.includes('<title>' + title) &&
      r.body.includes('policy-card') &&
      r.body.includes('آخر تحديث');
    check('policy page /policies/' + slug, ok, 'status ' + r.status);
    check('  … footer legal links present', r.body.includes('f-legal') &&
      r.body.includes('/policies/usage') && r.body.includes('/policies/deletion'));
    check('  … cache no-store', r.headers.get('cache-control') === 'no-store',
      r.headers.get('cache-control'));
  }
  const unknown = await req('/policies/whatever');
  check('unknown policy → 404', unknown.status === 404, 'status ' + unknown.status);

  // ── 2) homepage + contact footer ─────────────────────────────
  const home = await req('/', true);
  check('homepage 200 + legal links in footer',
    home.status === 200 && home.body.includes('f-legal') &&
    home.body.includes('/policies/usage') && home.body.includes('/policies/privacy') &&
    home.body.includes('/policies/deletion'));
  const contact = await req('/contact', true);
  check('contact page 200 + legal links in footer',
    contact.status === 200 && contact.body.includes('f-legal'));

  // ── 3) cache headers ─────────────────────────────────────────
  const siteCss = await req('/site.css');
  check('site.css → no-cache', siteCss.headers.get('cache-control') === 'no-cache',
    siteCss.headers.get('cache-control'));
  const siteIcon = await req('/icon-512.png');
  check('site icon → public max-age', /public, max-age=86400/.test(siteIcon.headers.get('cache-control') || ''),
    siteIcon.headers.get('cache-control'));

  const panel = await req('/verify-panel-1', true);
  check('panel html → no-store + versioned assets',
    panel.status === 200 &&
    panel.headers.get('cache-control') === 'no-store' &&
    panel.body.includes('styles.css?v=3.2') &&
    panel.body.includes('app.js?v=3.2'));
  const panelCss = await req('/verify-panel-1/styles.css?v=3.2');
  check('panel styles.css → no-cache', panelCss.headers.get('cache-control') === 'no-cache',
    panelCss.headers.get('cache-control'));
  const panelJs = await req('/verify-panel-1/app.js?v=3.2');
  check('panel app.js → no-cache', panelJs.headers.get('cache-control') === 'no-cache',
    panelJs.headers.get('cache-control'));

  // ── 4) the new CSS/JS bits are really deployed in the files ──
  const css = panelCss ? await (await fetch(BASE + '/verify-panel-1/styles.css?v=3.2')).text() : '';
  check('panel css has mobile tl-row rules',
    css.includes('flex-wrap: wrap') && css.includes('body.drawer-open'));
  check('panel css has grid min-width guard', css.includes('.row-2 > *, .row-3 > *, .row-4 > *'));
  const js = await (await fetch(BASE + '/verify-panel-1/app.js?v=3.2')).text();
  check('panel js has swipe-to-close + scroll lock',
    js.includes('touchstart') && js.includes('drawer-open'));
  const siteCssText = await (await fetch(BASE + '/site.css')).text();
  check('site css has policy styles',
    siteCssText.includes('.policy-card') && siteCssText.includes('.p-others') &&
    siteCssText.includes('.f-legal'));

  console.log(failed === 0 ? '\nALL VERIFIED ✓' : '\n' + failed + ' CHECK(S) FAILED ✗');
  child.kill();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify error:', e);
  child.kill();
  process.exit(1);
});
