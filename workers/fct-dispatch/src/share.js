/* Pull the work OneDrive anyone-link from the Worker (not the browser).
 *
 * Verified 2026-08-25: GET of the Anyone-can-edit :x:/g/ share with
 * ?download=1 yields the xlsx at .../Documents/2026 FCT Dispatch Log.xlsx?ga=1
 * ONLY if Set-Cookie FedAuth from the first SharePoint 302 is sent on the
 * next hop. fetch() redirect:'follow' drops cookies, so the Worker follows
 * redirects by hand. Without FedAuth the same URL lands on
 * login.microsoftonline.com — that is the CORS/login wall the browser hits.
 * Graph /shares is 401 without an app token; we do not invent that.
 * No Power Automate Premium. No Microsoft login in the calc.
 */

import { looksLikeZipXlsx } from './ingest.js';

export const KV_SHARE_PULL = 'share-pull';
export const SHARE_STALE_MS = 90 * 1000;
export const DEFAULT_SHARE_URL =
  'https://frenchcamptransport-my.sharepoint.com/:x:/g/personal/jamesgrunsky_frenchcamptransport_onmicrosoft_com/IQBGRbC6973TRowZbmxEeoQEAS6NSIu-Zazhwpp9Pu5BitI?e=coV1OH';
export const DEFAULT_XLSX_NAME = '2026 FCT Dispatch Log.xlsx';

const UA = 'Mozilla/5.0 (compatible; FCT-dispatch-worker/1.41; +https://fct-calc)';

export function withDownloadParam(url){
  const u = new URL(String(url||''));
  if(!u.searchParams.has('download')) u.searchParams.set('download', '1');
  return u.href;
}

export function shareTokenFromUrl(url){
  const m = String(url||'').match(/\/:(?:x|u|w):\/g\/personal\/[^/]+\/([^/?#]+)/i);
  return m ? m[1] : '';
}

export function personalSiteFromShareUrl(url){
  try {
    const u = new URL(String(url||''));
    const m = u.pathname.match(/\/personal\/([^/]+)/i);
    if(!m) return '';
    return u.origin + '/personal/' + m[1];
  } catch(_){ return ''; }
}

export function downloadAspxUrl(shareUrl){
  const token = shareTokenFromUrl(shareUrl);
  const site = personalSiteFromShareUrl(shareUrl);
  if(!token || !site) return '';
  return site + '/_layouts/15/download.aspx?share=' + encodeURIComponent(token);
}

export function candidateShareUrls(shareUrl){
  const src = String(shareUrl||'').trim();
  const out = [];
  if(src) out.push(withDownloadParam(src));
  const aspx = downloadAspxUrl(src);
  if(aspx) out.push(aspx);
  return out;
}

export function isLoginUrl(url){
  return /login\.microsoftonline\.com|login\.live\.com|login\.windows\.net/i.test(String(url||''));
}

export function looksLikeLoginHtml(bytes){
  if(!bytes || bytes.length < 20) return false;
  const head = new TextDecoder('utf-8', { fatal:false }).decode(bytes.slice(0, 800));
  return /Sign in to your account|login\.microsoftonline\.com|ConvergedSignIn/i.test(head);
}

export function parseSetCookie(raw){
  const line = String(raw||'').trim();
  if(!line) return null;
  const first = line.split(';')[0];
  const eq = first.indexOf('=');
  if(eq < 1) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq+1).trim();
  if(!name || /^(Max-Age|Expires|Path|Domain|Secure|HttpOnly|SameSite)$/i.test(name)) return null;
  return { name, value };
}

export function cookieHeaderFromMap(map){
  return Array.from(map.entries()).map(([k,v])=>k+'='+v).join('; ');
}

export function applySetCookieHeaders(headers, map){
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get && headers.get('Set-Cookie') ? [headers.get('Set-Cookie')] : []);
  (list || []).forEach(raw=>{
    const p = parseSetCookie(raw);
    if(p) map.set(p.name, p.value);
  });
  return map;
}

export function fileNameFromResponse(headers, finalUrl, fallback){
  const cd = (headers && headers.get && headers.get('Content-Disposition')) || '';
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if(star && star[1]){
    try { return decodeURIComponent(star[1].replace(/["']/g,'').trim()); }
    catch(_){ return star[1].replace(/["']/g,'').trim(); }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if(plain && plain[1]) return plain[1].trim();
  try {
    const path = new URL(String(finalUrl||'')).pathname;
    const leaf = decodeURIComponent(path.split('/').pop() || '');
    if(/\.xlsx?$/i.test(leaf)) return leaf;
  } catch(_){}
  return fallback || DEFAULT_XLSX_NAME;
}

function redirectLocation(res, currentUrl){
  const loc = res.headers.get('Location') || res.headers.get('location');
  if(!loc) return '';
  try { return new URL(loc, currentUrl).href; } catch(_){ return ''; }
}

export async function fetchFollowCookies(url, fetchImpl, cookies, opts){
  opts = opts || {};
  const maxHops = opts.maxHops || 12;
  let current = url;
  const cookieMap = cookies || new Map();
  for(let hop=0; hop<maxHops; hop++){
    if(isLoginUrl(current)){
      return { ok:false, error:'login_wall', url: current, hops: hop,
        message:'SharePoint redirected to Microsoft login. Anyone-link did not stay anonymous.' };
    }
    const headers = { 'User-Agent': UA, 'Accept': '*/*' };
    if(cookieMap.size) headers.Cookie = cookieHeaderFromMap(cookieMap);
    const res = await fetchImpl(current, { method:'GET', headers, redirect:'manual' });
    applySetCookieHeaders(res.headers, cookieMap);
    if(res.status >= 300 && res.status < 400){
      const next = redirectLocation(res, current);
      if(!next){
        return { ok:false, error:'redirect_without_location', status: res.status, url: current };
      }
      current = next;
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      url: current,
      bytes: buf,
      headers: res.headers,
      hops: hop+1
    };
  }
  return { ok:false, error:'too_many_redirects', url: current };
}

export async function fetchShareXlsx(shareUrl, fetchImpl){
  const cookies = new Map();
  const urls = candidateShareUrls(shareUrl);
  if(!urls.length){
    return { ok:false, error:'no_share_url' };
  }
  let last = null;
  for(const u of urls){
    const got = await fetchFollowCookies(u, fetchImpl, cookies);
    last = got;
    if(got && got.ok && got.bytes && looksLikeZipXlsx(got.bytes)){
      return {
        ok:true,
        bytes: got.bytes,
        fileName: fileNameFromResponse(got.headers, got.url, DEFAULT_XLSX_NAME),
        finalUrl: got.url,
        hops: got.hops
      };
    }
    if(got && (got.error==='login_wall' || (got.bytes && looksLikeLoginHtml(got.bytes)))){
      /* Keep going: download.aspx with FedAuth already in the jar may still work. */
      last = Object.assign({}, got, {
        error: got.error || 'login_wall',
        message: got.message || 'Anonymous share redirected to Microsoft login.'
      });
      continue;
    }
  }
  if(last && last.bytes && looksLikeZipXlsx(last.bytes)){
    return { ok:true, bytes:last.bytes, fileName: DEFAULT_XLSX_NAME, finalUrl: last.url };
  }
  if(last && (last.error==='login_wall' || (last.bytes && looksLikeLoginHtml(last.bytes)))){
    return {
      ok:false,
      error:'login_wall',
      message:'Unauthenticated GET of the Anyone-can-edit share redirected to Microsoft login. Cookie-aware download=1 did not yield xlsx. Graph /shares is 401 without an app token — not used (no PA Premium, no invented paid connector).',
      url: last.url
    };
  }
  return {
    ok:false,
    error: (last && last.error) || 'not_xlsx',
    status: last && last.status,
    message: 'Share fetch did not return an xlsx (PK zip).',
    url: last && last.url
  };
}

export async function sha256hex(bytes, cryptoImpl){
  const c = cryptoImpl || globalThis.crypto;
  const digest = await c.subtle.digest('SHA-256', bytes);
  const u8 = new Uint8Array(digest);
  let hex = '';
  for(let i=0;i<u8.length;i++) hex += u8[i].toString(16).padStart(2,'0');
  return hex;
}

export function shareUrlFromEnv(env){
  return String((env && (env.DISPATCH_SHARE_URL || env.SHARE_URL)) || DEFAULT_SHARE_URL).trim();
}

export function xlsxNameFromEnv(env){
  return String((env && env.DISPATCH_XLSX_NAME) || DEFAULT_XLSX_NAME).trim() || DEFAULT_XLSX_NAME;
}

export function pullIsFresh(meta, nowMs, staleMs){
  if(!meta || !meta.pulledAt) return false;
  const t = Date.parse(meta.pulledAt);
  if(!isFinite(t)) return false;
  const age = nowMs - t;
  if(meta.ok) return age < (staleMs == null ? SHARE_STALE_MS : staleMs);
  /* Failed pull (login_wall, etc.): do not hammer SharePoint on every GET. */
  return age < 5 * 60 * 1000;
}
