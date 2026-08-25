import { strict as assert } from 'node:assert';
import {
  withDownloadParam, shareTokenFromUrl, personalSiteFromShareUrl,
  downloadAspxUrl, candidateShareUrls, isLoginUrl, looksLikeLoginHtml,
  parseSetCookie, cookieHeaderFromMap, applySetCookieHeaders,
  fileNameFromResponse, fetchShareXlsx, pullIsFresh, DEFAULT_SHARE_URL
} from './share.js';
import { looksLikeZipXlsx } from './ingest.js';

{
  const u = withDownloadParam(DEFAULT_SHARE_URL);
  assert.match(u, /download=1/);
  assert.equal(withDownloadParam(u), u);
  assert.equal(shareTokenFromUrl(DEFAULT_SHARE_URL), 'IQBGRbC6973TRowZbmxEeoQEAS6NSIu-Zazhwpp9Pu5BitI');
  assert.match(personalSiteFromShareUrl(DEFAULT_SHARE_URL), /\/personal\/jamesgrunsky_frenchcamptransport_onmicrosoft_com$/);
  assert.match(downloadAspxUrl(DEFAULT_SHARE_URL), /download\.aspx\?share=IQBGRbC6973TRowZbmxEeoQEAS6NSIu-Zazhwpp9Pu5BitI/);
  const c = candidateShareUrls(DEFAULT_SHARE_URL);
  assert.equal(c.length, 2);
  assert.ok(c[0].includes('download=1'));
}

{
  assert.equal(isLoginUrl('https://login.microsoftonline.com/common/oauth2/authorize'), true);
  assert.equal(isLoginUrl('https://frenchcamptransport-my.sharepoint.com/foo'), false);
  const html = new TextEncoder().encode('<!DOCTYPE html><title>Sign in to your account</title>');
  assert.equal(looksLikeLoginHtml(html), true);
  assert.equal(looksLikeZipXlsx(new Uint8Array([0x50,0x4b,0x03,0x04])), true);
}

{
  const p = parseSetCookie('FedAuth=abc+def; path=/; SameSite=None; secure; HttpOnly');
  assert.equal(p.name, 'FedAuth');
  assert.equal(p.value, 'abc+def');
  const map = new Map();
  applySetCookieHeaders({ getSetCookie: ()=>['FedAuth=tok; path=/', 'rtFa=x; path=/'] }, map);
  assert.equal(map.get('FedAuth'), 'tok');
  assert.equal(cookieHeaderFromMap(map).includes('FedAuth=tok'), true);
}

{
  const headers = { get: k => k.toLowerCase()==='content-disposition'
    ? 'attachment;filename*=utf-8\'\'2026%20FCT%20Dispatch%20Log%2Exlsx;filename="2026 FCT Dispatch Log.xlsx"'
    : null };
  assert.equal(fileNameFromResponse(headers, 'https://x.example/foo.bin'), '2026 FCT Dispatch Log.xlsx');
}

{
  assert.equal(pullIsFresh({ ok:true, pulledAt: new Date(Date.now()-1000).toISOString() }, Date.now(), 90000), true);
  assert.equal(pullIsFresh({ ok:true, pulledAt: new Date(Date.now()-120000).toISOString() }, Date.now(), 90000), false);
  assert.equal(pullIsFresh({ ok:false, pulledAt: new Date().toISOString() }, Date.now(), 90000), true);
  assert.equal(pullIsFresh({ ok:false, pulledAt: new Date(Date.now()-6*60*1000).toISOString() }, Date.now(), 90000), false);
}

{
  /* Cookie-aware: first hop sets FedAuth and redirects; second hop with Cookie returns xlsx. */
  const xlsx = new Uint8Array([0x50,0x4b,0x03,0x04, 0,1,2,3,4,5,6,7]);
  const hops = [];
  const fetchImpl = async (url, init)=>{
    hops.push({ url, cookie: (init.headers && init.headers.Cookie) || '' });
    if(hops.length===1){
      return {
        status: 302,
        headers: {
          get: k => k.toLowerCase()==='location' ? 'https://frenchcamptransport-my.sharepoint.com/personal/u/Documents/2026%20FCT%20Dispatch%20Log.xlsx?ga=1' : null,
          getSetCookie: ()=>['FedAuth=guest-token; path=/; secure']
        },
        arrayBuffer: async ()=> new ArrayBuffer(0)
      };
    }
    assert.match(init.headers.Cookie, /FedAuth=guest-token/);
    assert.equal(init.redirect, 'manual');
    return {
      ok: true,
      status: 200,
      headers: {
        get: k => k.toLowerCase()==='content-type'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : (k.toLowerCase()==='content-disposition' ? 'attachment;filename="2026 FCT Dispatch Log.xlsx"' : null),
        getSetCookie: ()=>[]
      },
      arrayBuffer: async ()=> xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset+xlsx.byteLength)
    };
  };
  const got = await fetchShareXlsx(DEFAULT_SHARE_URL, fetchImpl);
  assert.equal(got.ok, true);
  assert.equal(got.fileName, '2026 FCT Dispatch Log.xlsx');
  assert.ok(looksLikeZipXlsx(got.bytes));
  assert.ok(hops[0].url.includes('download=1'));
}

{
  /* Without a usable xlsx, login redirect is reported clearly — not a silent fail. */
  const fetchImpl = async (url)=>{
    if(/login\.microsoftonline/.test(url)){
      return { status:200, ok:true, headers:{ get:()=>null, getSetCookie:()=>[] },
        arrayBuffer: async ()=> new TextEncoder().encode('Sign in to your account').buffer };
    }
    return {
      status: 302,
      headers: {
        get: k => k.toLowerCase()==='location' ? 'https://login.microsoftonline.com/common/oauth2/authorize?foo=1' : null,
        getSetCookie: ()=>[]
      },
      arrayBuffer: async ()=> new ArrayBuffer(0)
    };
  };
  const got = await fetchShareXlsx(DEFAULT_SHARE_URL, fetchImpl);
  assert.equal(got.ok, false);
  assert.equal(got.error, 'login_wall');
}

console.log('share.test.mjs ok');
