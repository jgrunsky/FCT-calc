/**
 * FCT Dispatch Worker
 * ================================================================
 * Receives the 2026 FCT Dispatch Log from Office Script (JSON rows)
 * or Power Automate Flow 1 (OneDrive Get file content / raw xlsx),
 * stores the latest snapshot in KV, serves JSON to the FCT calc.
 *
 * Endpoints:
 *   POST /ingest    — Office Script or Power Automate (X-FCT-Key)
 *   GET  /latest    — FCT calc fetches this to populate today's dashboard
 *   GET  /health    — sanity check
 *
 * Auth:
 *   POST requires X-FCT-Key header matching INGEST_KEY secret.
 *   GET /latest requires X-FCT-Read-Key matching READ_KEY secret.
 *
 * KV binding: DISPATCH  (namespace stores "latest" key with JSON blob)
 * Secret:     INGEST_KEY  (shared secret with Power Automate / Office Script)
 *
 * POST /ingest accepts:
 *   1. JSON { rows: [...] } / { value: [...] }  (Office Script)
 *   2. OneDrive Get file content envelopes ($content / fileContent / body)
 *   3. Raw xlsx bytes (PK zip magic)
 * Sheet "2026" is parsed into the same { time, po, driver, origin, fb,
 * commodity, truck, status, extra } row shape GET /latest already stores.
 *
 * Do not log or echo INGEST_KEY / X-FCT-Key.
 */

import {
  KV_LATEST,
  ingestKeyOk,
  readIngestRequest,
  latestPayloadFromRows
} from './ingest.js';

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-FCT-Key',
    'Cache-Control': 'no-store'
  };
}

// Security (2026-10-23): GET /latest requires X-FCT-Read-Key == READ_KEY secret.
// The Pages proxy (fct-calc.pages.dev/api/dispatch) injects it server-side.
function readKeyOk(request, env){
  const got = request.headers.get('X-FCT-Read-Key');
  const expected = env && env.READ_KEY;
  if(!expected || typeof got !== 'string' || got.length !== expected.length) return false;
  let d = 0;
  for(let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return d === 0;
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
      return json({ ok: true, ts: Date.now() });
    }

    if(url.pathname === '/ingest' && request.method === 'POST'){
      if(!ingestKeyOk(request, env)){
        return json({ error: 'unauthorized' }, 401);
      }
      const parsed = await readIngestRequest(request);
      if(parsed.kind === 'bad'){
        return json({ error: parsed.error || 'bad_json' }, 400);
      }
      const payload = latestPayloadFromRows(parsed.rows);
      await env.DISPATCH.put(KV_LATEST, JSON.stringify(payload));
      return json({
        ok: true,
        rowCount: payload.rowCount,
        ingestedAt: payload.ingestedAt
      });
    }

    if(url.pathname === '/latest' && request.method === 'GET'){
      if(!readKeyOk(request, env)){
        return json({ error: 'unauthorized' }, 401);
      }
      const raw = await env.DISPATCH.get(KV_LATEST);
      if(!raw){
        return json({ error: 'no_data', message: 'No dispatch data ingested yet' }, 404);
      }
      return new Response(raw, {
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    return new Response(
      'FCT Dispatch Worker\n\nGET  /health\nGET  /latest\nPOST /ingest (auth required)\n',
      { headers: { 'Content-Type': 'text/plain', ...cors } }
    );
  }
};
