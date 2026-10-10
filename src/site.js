/**
 * site.js — public marketing site + content management (v3).
 * ─────────────────────────────────────────────────────────────────
 * PUBLIC (no auth):
 *   GET  /api/public/site           everything the landing page needs
 *
 * ADMIN (session/token):
 *   GET  /api/admin/site            full site config (hero, features,
 *                                   downloads, pricing, footer, contact)
 *   PUT  /api/admin/site            save site config
 *   GET  /api/admin/media           list screenshots
 *   POST /api/admin/media           upload screenshot {name, mime, dataBase64, title}
 *   POST /api/admin/media/:id       rename {title}
 *   POST /api/admin/media/:id/move  reorder {dir: 'up'|'down'}
 *   POST /api/admin/media/:id/delete
 *   GET  /api/admin/contact-options list contact options
 *   POST /api/admin/contact-options            create {type,label,value}
 *   POST /api/admin/contact-options/:id        update {type,label,value,enabled}
 *   POST /api/admin/contact-options/:id/move   reorder {dir}
 *   POST /api/admin/contact-options/:id/delete
 *
 * Screenshots are stored on disk under DATA_DIR/uploads with metadata
 * in the `media` table; served publicly at /media/{filename}.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {stmt, getSetting, setSetting, audit, DATA_DIR} = require('./db');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, {recursive: true});

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB per screenshot
const ALLOWED_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const DOWNLOAD_PLATFORMS = ['google_play', 'direct_apk', 'desktop', 'apple_store'];
const CONTACT_TYPES = ['phone', 'whatsapp', 'telegram', 'email', 'website', 'custom'];

// ── image dimensions (pure header parsing, no native deps) ─────────
function imageDimensions(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
      return {width: buf.readUInt32BE(16), height: buf.readUInt32BE(20)};
    }
    if (mime === 'image/jpeg') {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {off++; continue;}
        const marker = buf[off + 1];
        const size = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return {height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7)};
        }
        off += 2 + size;
      }
    }
    if (mime === 'image/webp' && buf.length > 30) {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        return {
          width: 1 + buf.readUIntLE(24, 3),
          height: 1 + buf.readUIntLE(27, 3),
        };
      }
      if (fourcc === 'VP8 ') {
        return {width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff};
      }
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return {width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1};
      }
    }
  } catch (_) {
    /* dimension is best-effort only */
  }
  return {width: null, height: null};
}

// ── shared payload builders ────────────────────────────────────────
function safeFeatures() {
  try {
    const parsed = JSON.parse(getSetting('landing_features', '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(f => f && typeof f === 'object')
      .slice(0, 12)
      .map(f => ({
        icon: String(f.icon || 'star').slice(0, 24),
        title: String(f.title || '').slice(0, 80),
        text: String(f.text || '').slice(0, 300),
      }))
      .filter(f => f.title);
  } catch (_) {
    return [];
  }
}

function heroPayload() {
  return {
    badge: getSetting('landing_hero_badge', ''),
    title: getSetting('landing_hero_title', ''),
    subtitle: getSetting('landing_hero_subtitle', ''),
    ctaText: getSetting('landing_cta_text', ''),
  };
}

function downloadsPublic() {
  return stmt.listDownloadLinks.all().map(d => ({
    platform: d.platform,
    url: d.enabled ? d.url : '',
    label: d.label,
    enabled: !!d.enabled && String(d.url || '').trim().length > 0,
  }));
}

function mediaPublic() {
  return stmt.listMedia.all().map(m => ({
    id: m.id,
    url: `/media/${m.filename}`,
    title: m.title || '',
    width: m.width,
    height: m.height,
  }));
}

function contactOptionsPublic() {
  return stmt.listEnabledContactOptions.all().map(o => ({
    id: o.id,
    type: o.type,
    label: o.label,
    value: o.value,
  }));
}

function pricingPublic() {
  const cur = getSetting('currency', '₪');
  return {
    show: getSetting('landing_show_pricing', '1') === '1',
    currency: cur,
    plans: [
      {id: 'trial', days: 7, label: 'تجريبي', price: Number(getSetting('price_trial', '0'))},
      {id: 'monthly', days: 30, label: 'شهري', price: Number(getSetting('price_monthly', '50'))},
      {id: 'quarterly', days: 90, label: 'ربع سنوي', price: Number(getSetting('price_quarterly', '120'))},
      {id: 'yearly', days: 365, label: 'سنوي', price: Number(getSetting('price_yearly', '400'))},
    ].map(p => ({...p, priceLabel: p.price === 0 ? 'مجاناً' : `${p.price} ${cur}`})),
  };
}

/** Everything the public landing + contact pages need (no auth). */
function sitePublicPayload() {
  return {
    ok: true,
    hero: heroPayload(),
    features: safeFeatures(),
    downloads: downloadsPublic(),
    screenshots: mediaPublic(),
    contactOptions: contactOptionsPublic(),
    contactNote: getSetting('contact_note', ''),
    pricing: pricingPublic(),
    footerNote: getSetting('site_footer_note', ''),
    seoDescription: getSetting('site_seo_description', ''),
    serverTime: Date.now(),
  };
}

// ── admin: site config ─────────────────────────────────────────────
function buildSiteAdminRouter() {
  const router = express.Router();

  router.get('/site', (_req, res) => {
    res.json({
      ok: true,
      hero: heroPayload(),
      features: safeFeatures(),
      downloads: stmt.listDownloadLinks.all().map(d => ({
        platform: d.platform,
        url: d.url,
        label: d.label,
        enabled: !!d.enabled,
      })),
      pricingShow: getSetting('landing_show_pricing', '1') === '1',
      footerNote: getSetting('site_footer_note', ''),
      seoDescription: getSetting('site_seo_description', ''),
      media: stmt.listMedia.all(),
      contactOptions: stmt.listContactOptions.all(),
    });
  });

  router.put('/site', (req, res) => {
    const b = req.body || {};
    const admin = {adminId: req.adminUser.id, ip: req.ip};

    if (b.hero && typeof b.hero === 'object') {
      const {badge, title, subtitle, ctaText} = b.hero;
      if (typeof badge === 'string') setSetting('landing_hero_badge', badge.trim().slice(0, 120));
      if (typeof title === 'string') setSetting('landing_hero_title', title.trim().slice(0, 160));
      if (typeof subtitle === 'string') setSetting('landing_hero_subtitle', subtitle.trim().slice(0, 600));
      if (typeof ctaText === 'string') setSetting('landing_cta_text', ctaText.trim().slice(0, 80));
    }

    if (Array.isArray(b.features)) {
      const clean = b.features
        .filter(f => f && typeof f === 'object' && String(f.title || '').trim())
        .slice(0, 12)
        .map(f => ({
          icon: String(f.icon || 'star').slice(0, 24),
          title: String(f.title).trim().slice(0, 80),
          text: String(f.text || '').trim().slice(0, 300),
        }));
      setSetting('landing_features', JSON.stringify(clean));
    }

    if (Array.isArray(b.downloads)) {
      const now = Date.now();
      for (const d of b.downloads) {
        if (!d || typeof d !== 'object') continue;
        const platform = String(d.platform || '');
        if (!DOWNLOAD_PLATFORMS.includes(platform)) continue;
        const url = String(d.url || '').trim().slice(0, 500);
        // A link can only be enabled when it has a real URL.
        const enabled = !!d.enabled && /^https?:\/\//i.test(url) ? 1 : 0;
        const label = String(d.label || '').trim().slice(0, 60) || null;
        stmt.upsertDownloadLink.run(platform, url, label, enabled, DOWNLOAD_PLATFORMS.indexOf(platform) + 1, now);
      }
    }

    if (b.pricingShow !== undefined) {
      setSetting('landing_show_pricing', b.pricingShow ? '1' : '0');
    }
    if (typeof b.footerNote === 'string') setSetting('site_footer_note', b.footerNote.trim().slice(0, 160));
    if (typeof b.seoDescription === 'string') setSetting('site_seo_description', b.seoDescription.trim().slice(0, 300));

    audit('admin_update_site', admin);
    res.json({ok: true});
  });

  // ── screenshots / media ──────────────────────────────────────────

  router.get('/media', (_req, res) => {
    res.json({ok: true, media: stmt.listMedia.all()});
  });

  router.post('/media', (req, res) => {
    const {name, mime, dataBase64, title} = req.body || {};
    if (!mime || !ALLOWED_MIME[mime]) {
      return res.status(400).json({ok: false, error: 'BAD_MIME'});
    }
    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
      return res.status(400).json({ok: false, error: 'BAD_DATA'});
    }
    let buf;
    try {
      buf = Buffer.from(dataBase64, 'base64');
    } catch (_) {
      return res.status(400).json({ok: false, error: 'BAD_BASE64'});
    }
    if (!buf || buf.length < 100) {
      return res.status(400).json({ok: false, error: 'BAD_DATA'});
    }
    if (buf.length > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ok: false, error: 'TOO_LARGE', maxBytes: MAX_UPLOAD_BYTES});
    }

    const ext = ALLOWED_MIME[mime];
    const safeTitle = String(title || '').trim().slice(0, 80) || null;
    const baseName = String(name || 'screenshot')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'screenshot';
    const filename = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${baseName}.${ext}`;

    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    const dims = imageDimensions(buf, mime);
    const sort = (stmt.maxMediaSort.get().m || 0) + 1;
    const info = stmt.insertMedia.run(
      filename,
      safeTitle,
      mime,
      buf.length,
      dims.width,
      dims.height,
      sort,
      Date.now(),
    );
    audit('admin_upload_media', {
      adminId: req.adminUser.id,
      ip: req.ip,
      details: {filename, size: buf.length, dims},
    });
    res.json({ok: true, id: Number(info.lastInsertRowid), url: `/media/${filename}`, dims});
  });

  router.post('/media/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = stmt.mediaById.get(id);
    if (!row) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const title = String((req.body || {}).title || '').trim().slice(0, 80);
    stmt.updateMediaTitle.run(title || null, id);
    res.json({ok: true});
  });

  router.post('/media/:id/move', (req, res) => {
    const id = Number(req.params.id);
    const row = stmt.mediaById.get(id);
    if (!row) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const dir = String((req.body || {}).dir || '');
    if (dir !== 'up' && dir !== 'down') {
      return res.status(400).json({ok: false, error: 'BAD_DIR'});
    }
    const target = dir === 'up' ? row.sort_order - 1 : row.sort_order + 1;
    const other = stmt.mediaBySort.get(target);
    dbTransaction(() => {
      if (other) stmt.setMediaSort.run(row.sort_order, other.id);
      stmt.setMediaSort.run(target, id);
    });
    res.json({ok: true});
  });

  router.post('/media/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const row = stmt.mediaById.get(id);
    if (!row) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    stmt.deleteMedia.run(id);
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, row.filename));
    } catch (_) {
      /* file already gone — row removal is what matters */
    }
    audit('admin_delete_media', {
      adminId: req.adminUser.id,
      ip: req.ip,
      details: {filename: row.filename},
    });
    res.json({ok: true});
  });

  // ── contact options (website contact page) ──────────────────────

  router.get('/contact-options', (_req, res) => {
    res.json({ok: true, options: stmt.listContactOptions.all()});
  });

  router.post('/contact-options', (req, res) => {
    const {type, label, value} = req.body || {};
    const t = String(type || '');
    if (!CONTACT_TYPES.includes(t)) {
      return res.status(400).json({ok: false, error: 'BAD_TYPE'});
    }
    const l = String(label || '').trim().slice(0, 60);
    const v = String(value || '').trim().slice(0, 300);
    if (!l || !v) {
      return res.status(400).json({ok: false, error: 'MISSING_FIELDS'});
    }
    const sort = (stmt.maxContactSort.get().m || 0) + 1;
    const info = stmt.insertContactOption.run(t, l, v, 1, sort, Date.now());
    audit('admin_add_contact', {
      adminId: req.adminUser.id,
      ip: req.ip,
      details: {type: t, label: l},
    });
    res.json({ok: true, id: Number(info.lastInsertRowid)});
  });

  router.post('/contact-options/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = stmt.contactOptionById.get(id);
    if (!row) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const {type, label, value, enabled} = req.body || {};
    const t = CONTACT_TYPES.includes(String(type || '')) ? String(type) : row.type;
    const l = String(label || '').trim().slice(0, 60) || row.label;
    const v = String(value || '').trim().slice(0, 300) || row.value;
    const e = enabled === true ? 1 : enabled === false ? 0 : row.enabled;
    stmt.updateContactOption.run(t, l, v, e, id);
    audit('admin_update_contact', {adminId: req.adminUser.id, ip: req.ip, details: {id, type: t}});
    res.json({ok: true});
  });

  router.post('/contact-options/:id/move', (req, res) => {
    const id = Number(req.params.id);
    const row = stmt.contactOptionById.get(id);
    if (!row) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    const dir = String((req.body || {}).dir || '');
    if (dir !== 'up' && dir !== 'down') {
      return res.status(400).json({ok: false, error: 'BAD_DIR'});
    }
    const target = dir === 'up' ? row.sort_order - 1 : row.sort_order + 1;
    const other = stmt.contactOptionBySort.get(target);
    dbTransaction(() => {
      if (other) stmt.setContactSort.run(row.sort_order, other.id);
      stmt.setContactSort.run(target, id);
    });
    res.json({ok: true});
  });

  router.post('/contact-options/:id/delete', (req, res) => {
    const id = Number(req.params.id);
    const row = stmt.contactOptionById.get(id);
    if (!row) return res.status(404).json({ok: false, error: 'NOT_FOUND'});
    stmt.deleteContactOption.run(id);
    audit('admin_delete_contact', {adminId: req.adminUser.id, ip: req.ip, details: {id}});
    res.json({ok: true});
  });

  return router;
}

// tiny wrapper so this module doesn't import `db` twice for transactions
const {db} = require('./db');
function dbTransaction(fn) {
  db.transaction(fn)();
}

/** Serve an uploaded screenshot by filename (public). */
function serveMedia(req, res) {
  const filename = String(req.params.filename || '');
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return res.status(404).end();
  }
  const row = stmt.mediaByFilename.get(filename);
  if (!row) return res.status(404).end();
  const file = path.join(UPLOAD_DIR, filename);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.status(404).end();
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Content-Length', st.size);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    stream.on('error', () => res.end());
  });
}

module.exports = {
  buildSiteAdminRouter,
  sitePublicPayload,
  serveMedia,
  UPLOAD_DIR,
};
