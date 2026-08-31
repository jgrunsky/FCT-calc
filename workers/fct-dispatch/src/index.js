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
 *   GET is public but returns only the parsed dispatch data (not sensitive).
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
        /* bodyBytes/headHex: first 16 wire bytes so a PA 400 shows empty vs `{` vs PK.
           Never echo INGEST_KEY / X-FCT-Key. */
        return json({
          error: parsed.error || 'bad_json',
          bodyBytes: Number.isFinite(parsed.bodyBytes) ? parsed.bodyBytes : 0,
          headHex: typeof parsed.headHex === 'string' ? parsed.headHex : ''
        }, 400);
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
