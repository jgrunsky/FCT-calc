/**
 * Site gate (2026-10-23). Whole fct-calc site + /api/* proxy require a
 * per-device sign-in cookie. Code = SITE_ACCESS_CODE (Pages secret).
 * Cookie = HMAC(SITE_COOKIE_SECRET) signed, HttpOnly, 400 days.
 * To sign everyone out: change SITE_COOKIE_SECRET. To change the code: SITE_ACCESS_CODE.
 */
const COOKIE = 'fct_auth';
const MAX_AGE = 400 * 24 * 3600;
const enc = new TextEncoder();

async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function eq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
  return null;
}
async function validCookie(req, secret) {
  const v = getCookie(req, COOKIE); if (!v) return false;
  const [ts, sig] = v.split('.'); if (!ts || !sig) return false;
  const t = parseInt(ts, 36); if (!t || Date.now() - t > MAX_AGE * 1000) return false;
  return eq(sig, await hmac(secret, 'v1:' + ts));
}
function page(msg, status) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FCT Calc · Sign in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0f1115;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#1a1d24;padding:28px;border-radius:14px;width:min(340px,88vw)}h1{font-size:20px;margin:0 0 6px}p{color:#9aa;font-size:14px}
input{width:100%;box-sizing:border-box;font-size:18px;padding:12px;border-radius:10px;border:1px solid #333;background:#0f1115;color:#fff;margin:10px 0}
button{width:100%;font-size:17px;padding:12px;border:0;border-radius:10px;background:#2f7cf6;color:#fff}.e{color:#f77}</style></head>
<body><form method="POST" action="/__fct_login"><h1>French Camp Transport</h1><p>Enter the access code once on this device.</p>
${msg ? `<p class="e">${msg}</p>` : ''}<input name="code" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button></form></body></html>`;
  return new Response(html, { status: status || 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const code = env.SITE_ACCESS_CODE, secret = env.SITE_COOKIE_SECRET;
  if (!code || !secret) return new Response('Site gate not configured', { status: 503 });

  if (url.pathname === '/__fct_login' && request.method === 'POST') {
    let got = '';
    try { const f = await request.formData(); got = String(f.get('code') || '').trim(); } catch (_) {}
    if (!eq(got.toLowerCase(), String(code).toLowerCase())) {
      await new Promise(r => setTimeout(r, 800));
      return page('Wrong code. Try again.', 401);
    }
    const ts = Date.now().toString(36);
    const val = ts + '.' + await hmac(secret, 'v1:' + ts);
    return new Response(null, { status: 303, headers: {
      location: '/', 'cache-control': 'no-store',
      'set-cookie': `${COOKIE}=${val}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
    } });
  }
  if (url.pathname === '/__fct_logout') {
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
  }
  if (await validCookie(request, secret)) return next();
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized', message: 'Sign in at / first' }), { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  return page('', 401);
}
