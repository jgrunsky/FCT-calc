/**
 * FCT Dispatch Worker
 * ================================================================
 * Excel two-way via Power Automate + optional Twilio SMS.
 *
 * Endpoints:
 *   POST /ingest     — Flow 1 (file-modified). JSON rows or xlsx bytes.
 *                      Header X-FCT-Key = INGEST_KEY secret.
 *   GET  /latest     — Calc fetches this. { rows, ingestedAt, rowCount }
 *                      or { format:'xlsx', fileName, ingestedAt } after a file push.
 *   GET  /latest.xlsx— Raw workbook when the last ingest was file bytes.
 *   POST /push-row   — Calc → Flow 2 HTTP trigger (writes driver back to Excel).
 *                      Body includes pushUrl from Settings, or env POWER_AUTOMATE_PUSH_URL.
 *   POST /send-sms   — Optional. Twilio if TWILIO_* secrets exist; else
 *                      { error: "SMS not configured" } without failing the assignment.
 *   GET  /health
 *
 * KV binding: DISPATCH
 * Secret:     INGEST_KEY
 *
 * Do not commit secrets. Deploy does not create them:
 *   npx wrangler secret put INGEST_KEY
 *   npx wrangler secret put TWILIO_ACCOUNT_SID
 *   npx wrangler secret put TWILIO_AUTH_TOKEN
 *   npx wrangler secret put TWILIO_FROM
 */

import { sendSms, composeDriverSms } from './sms.js';
import {
  KV_LATEST, KV_LATEST_XLSX,
  ingestKeyFrom, readIngestRequest,
  latestPayloadFromRows, latestPayloadFromXlsx, isHttpsUrl
} from './ingest.js';

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

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const cors = corsHeaders();

    if(request.method === 'OPTIONS'){
      return new Response(null, { headers: cors });
    }

    if(url.pathname === '/health' && request.method === 'GET'){
      return json({ ok:true, ts: Date.now() });
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
        await env.DISPATCH.put(KV_LATEST_XLSX, parsed.bytes);
        const payload = latestPayloadFromXlsx(parsed.fileName);
        await env.DISPATCH.put(KV_LATEST, JSON.stringify(payload));
        return json({ ok:true, format:'xlsx', fileName: payload.fileName, ingestedAt: payload.ingestedAt });
      }
      const payload = latestPayloadFromRows(parsed.rows, { fileName: parsed.fileName });
      await env.DISPATCH.put(KV_LATEST, JSON.stringify(payload));
      return json({ ok:true, format:'rows', rowCount: payload.rowCount, ingestedAt: payload.ingestedAt });
    }

    if(url.pathname === '/latest' && request.method === 'GET'){
      const raw = await env.DISPATCH.get(KV_LATEST);
      if(!raw){
        return json({ error:'no_data', message:'No dispatch data ingested yet' }, 404);
      }
      return new Response(raw, { headers: { 'Content-Type':'application/json', ...cors } });
    }

    if((url.pathname === '/latest.xlsx' || url.pathname === '/latest.xls') && request.method === 'GET'){
      const bytes = await env.DISPATCH.get(KV_LATEST_XLSX, { type: 'arrayBuffer' });
      if(!bytes){
        return json({ error:'no_xlsx', message:'No workbook ingested yet' }, 404);
      }
      let fileName = 'dispatch.xlsx';
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
