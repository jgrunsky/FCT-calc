/**
 * FCT Dispatch Worker
 * ================================================================
 * Existing GET /latest + POST /ingest (JSON rows) plus optional SMS.
 *
 * Excel two-way in the calc is download-xlsx then drop — not this Worker.
 * POST /send-sms: if TWILIO_* (or another provider) is missing, return
 * { error: "SMS not configured" } so the assignment on the phone still
 * succeeds. Never commit secrets. CI does not send real texts.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /latest     — { rows, ingestedAt, rowCount }
 *   POST /ingest     — JSON rows (X-FCT-Key = INGEST_KEY). Pre-existing.
 *   POST /send-sms   — optional. Missing secrets → SMS not configured.
 *
 * KV binding: DISPATCH
 */

import { sendSms, composeDriverSms } from './sms.js';
import {
  KV_LATEST,
  ingestKeyFrom, readIngestRequest,
  latestPayloadFromRows
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
        return json({ error:'xlsx_ingest_not_used', message:'Drop the xlsx in the calc. Excel two-way is download then import.' }, 400);
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
      'FCT Dispatch Worker\n\nGET  /health\nGET  /latest\nPOST /ingest (X-FCT-Key)\nPOST /send-sms\n',
      { headers: { 'Content-Type':'text/plain', ...cors } }
    );
  }
};
