/**
 * sms.js — v5.0 نظام رسائل التحقق القصيرة متعدد المزودين.
 * ─────────────────────────────────────────────────────────────────
 * يخدم تدفق «نسيت كلمة المرور» في تطبيق سيلا ماركت: رمز 6 أرقام
 * يصل لجوال المستخدم المسجل فقط (مفتاح التفعيل/الإيقاف من لوحة
 * الإدارة — market_forgot_enabled).
 *
 * المزودون المدعومون (يختار المالك من اللوحة ويملك بياناته):
 *  • hisms     — hisms.sa (شائع في فلسطين، نمط api.php)
 *  • moltasms  — moltasms.net (غزة، نفس النمط)
 *  • unifonic  — api.unifonic.com (الخليج، AppSid)
 *  • twilio    — api.twilio.com (عالمي، Basic Auth)
 *  • generic   — أي بوابة HTTP أخرى: رابط بقوسَي {phone} و{message}
 *                وطريقة POST/GET + قالب جسم JSON اختياري
 *
 * كل النداءات بمهلة 10 ثوان (AbortController) — فشل المزود لا
 * يعلّق طلب المستخدم أبداً. لا نطبع المفاتيح في السجلات إطلاقاً.
 */
'use strict';

const SMS_TIMEOUT_MS = 10000;

/* إعدادات كل مزود كما تظهر في اللوحة (المعرفات المستخدمة في settings). */
const PROVIDER_FIELDS = {
  hisms: [
    {key: 'sms_username', label: 'اسم المستخدم'},
    {key: 'sms_password', label: 'كلمة المرور'},
    {key: 'sms_sender', label: 'اسم المُرسِل (Sender)'},
  ],
  moltasms: [
    {key: 'sms_username', label: 'اسم المستخدم'},
    {key: 'sms_password', label: 'كلمة المرور'},
    {key: 'sms_sender', label: 'اسم المُرسِل (Sender)'},
  ],
  unifonic: [
    {key: 'sms_app_sid', label: 'AppSid'},
    {key: 'sms_sender', label: 'اسم المُرسِل (SenderID)'},
  ],
  twilio: [
    {key: 'sms_account_sid', label: 'Account SID'},
    {key: 'sms_auth_token', label: 'Auth Token'},
    {key: 'sms_sender', label: 'رقم المُرسِل (From)'},
  ],
  generic: [
    {key: 'sms_generic_url', label: 'رابط البوابة (يحوي {phone} و {message})'},
    {key: 'sms_generic_method', label: 'الطريقة GET أو POST'},
    {key: 'sms_generic_body', label: 'قالب الجسم JSON (اختياري)'},
  ],
};

/** هل الإعدادات الحالية كافية لإرسال رسالة عبر المزود المختار؟ */
function smsConfigComplete(provider, settings) {
  if (!provider || !PROVIDER_FIELDS[provider]) return false;
  return PROVIDER_FIELDS[provider].every(f => {
    const v = settings[f.key];
    if (f.key === 'sms_generic_body' || f.key === 'sms_generic_method') return true; // اختيارية
    return typeof v === 'string' && v.trim() !== '';
  });
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || SMS_TIMEOUT_MS);
  try {
    return await fetch(url, {...opts, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

/* ── المزودون — كل دالة تعيد {ok, detail} ولا ترمي أبداً ────────── */

async function sendViaHismsLike(endpoint, s, phone, message) {
  const url = `${endpoint}?send_sms&username=${encodeURIComponent(s.sms_username)}` +
    `&password=${encodeURIComponent(s.sms_password)}` +
    `&message=${encodeURIComponent(message)}` +
    `&numbers=${encodeURIComponent(phone)}` +
    `&sender=${encodeURIComponent(s.sms_sender || '')}&return=json`;
  const res = await fetchWithTimeout(url, {method: 'POST'});
  const text = await res.text();
  // استجابة json المعروفة: {"status":"success","code":"1",...}
  let code = text;
  try {
    const j = JSON.parse(text);
    code = String(j.code ?? j.status ?? text);
  } catch { /* نص عادي */ }
  const ok = res.ok && (code === '1' || code === 'success' || code === 'true');
  return {ok, detail: ok ? '' : 'رمز المزود: ' + code.slice(0, 80)};
}

async function sendViaUnifonic(s, phone, message) {
  const body = new URLSearchParams({
    AppSid: s.sms_app_sid,
    Body: message,
    Recipient: phone,
    SenderID: s.sms_sender || '',
  });
  const res = await fetchWithTimeout('https://api.unifonic.com/v1/gateway/messages/send', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: body.toString(),
  });
  const j = await res.json().catch(() => ({}));
  const ok = res.ok && j.success === 'true';
  return {ok, detail: ok ? '' : 'رمز المزود: ' + String(j.message || j.errorCode || res.status).slice(0, 80)};
}

async function sendViaTwilio(s, phone, message) {
  const auth = Buffer.from(`${s.sms_account_sid}:${s.sms_auth_token}`).toString('base64');
  const body = new URLSearchParams({
    To: phone.startsWith('+') ? phone : '+' + phone.replace(/^00/, ''),
    Body: message,
  });
  if (s.sms_sender) body.set('From', s.sms_sender);
  const res = await fetchWithTimeout(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.sms_account_sid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    },
  );
  const j = await res.json().catch(() => ({}));
  const ok = res.ok && j.sid != null;
  return {ok, detail: ok ? '' : 'رمز المزود: ' + String(j.code || j.message || res.status).slice(0, 80)};
}

async function sendViaGeneric(s, phone, message) {
  const method = (s.sms_generic_method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const fill = (tpl) => String(tpl || '')
    .split('{phone}').join(encodeURIComponent(phone))
    .split('{message}').join(encodeURIComponent(message));
  let url = fill(s.sms_generic_url || '');
  const opts = {method};
  if (method === 'POST') {
    // قالب جسم JSON اختياري بحقول {phone}/{message} غير مشفّرة
    if (s.sms_generic_body && s.sms_generic_body.trim() !== '') {
      const bodyRaw = String(s.sms_generic_body)
        .split('{phone}').join(phone)
        .split('{message}').join(message);
      try {
        JSON.parse(bodyRaw); // تحقق — إن فشل نرسله نصاً كما هو
      } catch { /* نص حر */ }
      opts.headers = {'Content-Type': 'application/json'};
      opts.body = bodyRaw;
    } else {
      url = url; // الرابط يحمل القيم مشفّرة أصلاً
    }
  }
  const res = await fetchWithTimeout(url, opts);
  const ok = res.ok;
  return {ok, detail: ok ? '' : 'HTTP ' + res.status};
}

/**
 * يرسل رسالة نصية عبر المزود المُعدّ — لا يرمي أبداً.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function sendSms(provider, settings, phone, message) {
  try {
    if (!smsConfigComplete(provider, settings)) {
      return {ok: false, detail: 'الإعدادات غير مكتملة'};
    }
    switch (provider) {
      case 'hisms':
        return await sendViaHismsLike('https://hisms.sa/api.php', settings, phone, message);
      case 'moltasms':
        return await sendViaHismsLike('https://moltasms.net/api.php', settings, phone, message);
      case 'unifonic':
        return await sendViaUnifonic(settings, phone, message);
      case 'twilio':
        return await sendViaTwilio(settings, phone, message);
      case 'generic':
        return await sendViaGeneric(settings, phone, message);
      default:
        return {ok: false, detail: 'مزود غير معروف'};
    }
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? 'مهلة 10 ثوان' : 'خطأ شبكة';
    return {ok: false, detail: reason};
  }
}

/** إخفاء سر في العرض: أبقي آخر محرفين فقط. */
function maskSecret(v) {
  if (typeof v !== 'string' || v === '') return '';
  if (v.length <= 2) return '••';
  return '••••••••' + v.slice(-2);
}

module.exports = {
  PROVIDER_FIELDS,
  smsConfigComplete,
  sendSms,
  maskSecret,
};
