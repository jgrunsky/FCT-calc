/**
 * FCT Dispatch Worker
 * ================================================================
 * Live Excel path: Worker FETCHes the work OneDrive Anyone-can-edit
 * share server-side (download=1 + FedAuth cookie across redirects) and
 * stores it as /latest.xlsx — same as Flow 1 ingest. The calc GETs
 * /latest then /latest.xlsx. No Microsoft login in the browser. CORS is
 * this Worker's problem. Power Automate HTTP was not purchased.
 *
 * Microsoft 365 Business Basic (work OneDrive / Excel Online (Business)).
 * POST /ingest and POST /push-row stay; Flow 2 URL stays empty.
 *
 * Endpoints:
 *   POST /ingest      — optional Flow 1. JSON rows or xlsx bytes. X-FCT-Key.
 *   GET  /latest      — Calc sync. Pulls the share if stale, then
 *                       { format:'xlsx', fileName, ingestedAt } or JSON rows.
 *   GET  /latest.xlsx — Workbook bytes.
 *   POST /push-row    — Flow 2 hop. Empty URL → skipped.
 *   POST /send-sms    — Optional. Missing secrets → SMS not configured.
 *   GET  /health
 *
 * KV binding: DISPATCH
 * Cron:       */2 * * * *  (refresh the share)
 */

import { sendSms, composeDriverSms } from './sms.js';
import {
  KV_LATEST, KV_LATEST_XLSX,
  ingestKeyFrom, readIngestRequest,
  latestPayloadFromRows, latestPayloadFromXlsx, isHttpsUrl
} from './ingest.js';
import {
  KV_SHARE_PULL, fetchShareXlsx, shareUrlFromEnv, xlsxNameFromEnv,
  pullIsFresh, sha256hex
} from './share.js';

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-FCT-Key, X-Ingest-Key',
    'Cache-Control': 'no-store'
  };
}
function json(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

async function readPullMeta(env){
  try { return JSON.parse((await env.DISPATCH.get(KV_SHARE_PULL)) || '{}'); }
  catch(_){ return {}; }
}

async function storeXlsx(env, bytes, fileName, extra){
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const hash = await sha256hex(u8);
  const prevMeta = await readPullMeta(env);
  const unchanged = !!(prevMeta && prevMeta.hash === hash && prevMeta.ok);
  await env.DISPATCH.put(KV_LATEST_XLSX, u8);
  let ingestedAt = prevMeta.ingestedAt;
  if(!unchanged || !ingestedAt){
    const payload = latestPayloadFromXlsx(fileName, extra);
    ingestedAt = payload.ingestedAt;
    await env.DISPATCH.put(KV_LATEST, JSON.stringify(payload));
  }
  const meta = {
    ok: true,
    pulledAt: new Date().toISOString(),
    ingestedAt,
    unchanged,
    bytes: u8.length,
    hash,
    fileName,
    error: ''
  };
  await env.DISPATCH.put(KV_SHARE_PULL, JSON.stringify(meta));
  return meta;
}

export async function pullShareIntoKv(env, fetchImpl){
  const url = shareUrlFromEnv(env);
  if(!url){
    const meta = { ok:false, pulledAt: new Date().toISOString(), error:'no_share_url' };
    await env.DISPATCH.put(KV_SHARE_PULL, JSON.stringify(meta));
    return meta;
  }
  const got = await fetchShareXlsx(url, fetchImpl || fetch);
  if(!got.ok){
    const meta = {
      ok:false,
      pulledAt: new Date().toISOString(),
      error: got.error || 'fetch_failed',
      message: got.message || '',
      url: got.url || url
    };
    await env.DISPATCH.put(KV_SHARE_PULL, JSON.stringify(meta));
    return meta;
  }
  return storeXlsx(env, got.bytes, got.fileName || xlsxNameFromEnv(env), {
    source: 'share',
    shareHops: got.hops
  });
}

async function ensureShareXlsx(env, opts){
  opts = opts || {};
  const meta = await readPullMeta(env);
  if(!opts.force && pullIsFresh(meta, Date.now())) return meta;
  try {
    return await pullShareIntoKv(env, fetch);
  } catch(e){
    const fail = {
      ok:false,
      pulledAt: new Date().toISOString(),
      error: 'exception',
      message: String(e && e.message || e).slice(0,180)
    };
    try { await env.DISPATCH.put(KV_SHARE_PULL, JSON.stringify(fail)); } catch(_){}
    return fail;
  }
}

export default {
  async scheduled(event, env, ctx){
    ctx.waitUntil(pullShareIntoKv(env, fetch));
  },

  async fetch(request, env){
    const url = new URL(request.url);
    const cors = corsHeaders();

    if(request.method === 'OPTIONS'){
      return new Response(null, { headers: cors });
    }

    if(url.pathname === '/health' && request.method === 'GET'){
      const pull = await readPullMeta(env);
      return json({ ok:true, ts: Date.now(), sharePull: pull });
    }

    if(url.pathname === '/ingest' && request.method === 'POST'){
      const auth = ingestKeyFrom(request, env);
      if(!auth.ok){
        return json({ error:'unauthorized' }, 401);
      }
      const parsed = await readIngestRequest(request);
      if(parsed.kind === 'bad'){
        return json({ error: parsed.error || 'bad_json' }, 400);
      }
      if(parsed.kind === 'xlsx'){
        const meta = await storeXlsx(env, parsed.bytes, parsed.fileName);
        return json({ ok:true, format:'xlsx', fileName: meta.fileName, ingestedAt: meta.ingestedAt });
      }
      const payload = latestPayloadFromRows(parsed.rows, { fileName: parsed.fileName });
      await env.DISPATCH.put(KV_LATEST, JSON.stringify(payload));
      return json({ ok:true, format:'rows', rowCount: payload.rowCount, ingestedAt: payload.ingestedAt });
    }

    if(url.pathname === '/latest' && request.method === 'GET'){
      await ensureShareXlsx(env, { force: url.searchParams.get('refresh') === '1' });
      const raw = await env.DISPATCH.get(KV_LATEST);
      if(!raw){
        const pull = await readPullMeta(env);
        return json({
          error:'no_data',
          message: pull && pull.error==='login_wall'
            ? (pull.message || 'Share redirected to Microsoft login')
            : 'No dispatch data ingested yet',
          sharePull: pull
        }, 404);
      }
      return new Response(raw, { headers: { 'Content-Type':'application/json', ...cors } });
    }

    if((url.pathname === '/latest.xlsx' || url.pathname === '/latest.xls') && request.method === 'GET'){
      await ensureShareXlsx(env);
      const bytes = await env.DISPATCH.get(KV_LATEST_XLSX, { type: 'arrayBuffer' });
      if(!bytes){
        const pull = await readPullMeta(env);
        return json({
          error:'no_xlsx',
          message: (pull && pull.message) || 'No workbook ingested yet',
          sharePull: pull
        }, 404);
      }
      let fileName = xlsxNameFromEnv(env);
      try {
        const meta = JSON.parse(await env.DISPATCH.get(KV_LATEST) || '{}');
        if(meta && meta.fileName) fileName = String(meta.fileName);
      } catch(_){}
      return new Response(bytes, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="'+fileName.replace(/"/g,'')+'"',
          ...cors
        }
      });
    }

    if(url.pathname === '/push-row' && request.method === 'POST'){
      let body;
      try { body = await request.json(); }
      catch(_){ return json({ error:'bad_json' }, 400); }
      const target = String((body && body.pushUrl) || (env && env.POWER_AUTOMATE_PUSH_URL) || '').trim();
      if(!target){
        return json({ ok:true, skipped:true, reason:'no Power Automate URL' });
      }
      if(!isHttpsUrl(target)){
        return json({ ok:false, error:'push URL must be https' }, 400);
      }
      const row = Object.assign({}, body);
      delete row.pushUrl;
      try {
        const r = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(row)
        });
        const text = await r.text();
        return json({ ok: r.ok, status: r.status, preview: String(text||'').slice(0,200) });
      } catch(e){
        return json({ ok:false, error: String(e && e.message || e).slice(0,180) }, 502);
      }
    }

    if(url.pathname === '/send-sms' && request.method === 'POST'){
      let body;
      try { body = await request.json(); }
      catch(_){ return json({ error:'bad_json' }, 400); }
      const result = await sendSms(env, body, fetch);
      if(result.configured === false || result.error === 'SMS not configured'){
        return json({ ok:false, configured:false, error:'SMS not configured', body: composeDriverSms(body) });
      }
      return json(result, result.ok ? 200 : 502);
    }

    return new Response(
      'FCT Dispatch Worker\n\nGET  /health\nGET  /latest\nGET  /latest.xlsx\nPOST /ingest (X-FCT-Key)\nPOST /push-row\nPOST /send-sms\n',
      { headers: { 'Content-Type':'text/plain', ...cors } }
    );
  }
};
