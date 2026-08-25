/**
 * FCT Dispatch Worker
 * ================================================================
 * Receives the 2026 FCT Dispatch Log rows from Power Automate /
 * Office Script, stores the latest snapshot in KV, serves it as JSON
 * to the FCT calc, and (v2.1.41) sends driver SMS via Twilio.
 *
 * Endpoints:
 *   POST /ingest    — Power Automate hits this on every file-modified event
 *   GET  /latest    — FCT calc fetches this to populate today's dashboard
 *   POST /sms       — Send dispatch text. Twilio secrets on the Worker, not
 *                     the phone. Missing TWILIO_* returns "SMS not configured"
 *                     without failing the in-app assignment.
 *   GET  /health    — sanity check
 *
 * Auth:
 *   POST /ingest requires X-FCT-Key header matching INGEST_KEY secret.
 *   GET is public but returns only the parsed dispatch data (not sensitive).
 *   POST /sms is open like /latest (operator-only app). Do not put Twilio
 *   keys in the page.
 *
 * KV binding: DISPATCH  (namespace stores "latest" key with JSON blob)
 * Secret:     INGEST_KEY  (shared secret with Power Automate flow)
 * Secrets:    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 *             (optional — SMS path no-ops with a clear error if absent)
 *
 * Deploy:
 *   cd workers/fct-dispatch && npx wrangler deploy
 *   wrangler secret put TWILIO_ACCOUNT_SID
 *   wrangler secret put TWILIO_AUTH_TOKEN
 *   wrangler secret put TWILIO_FROM
 * Never commit secret values.
 */

import { handleSendSms } from "./sms.js";

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-FCT-Key',
  'Cache-Control': 'no-store'
};

function json(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Health
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, ts: Date.now() });
    }

    // Ingest from Power Automate
    if (url.pathname === '/ingest' && request.method === 'POST') {
      const key = request.headers.get('X-FCT-Key');
      if (!env.INGEST_KEY || key !== env.INGEST_KEY) {
        return json({ error: 'unauthorized' }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'bad_json' }, 400);
      }
      // Power Automate typically sends { value: [ {row}, {row}, ... ] }
      // Store what we got, tagged with server timestamp
      const payload = {
        rows: body.value || body.rows || body,
        ingestedAt: new Date().toISOString(),
        rowCount: Array.isArray(body.value) ? body.value.length : (Array.isArray(body.rows) ? body.rows.length : 0)
      };
      await env.DISPATCH.put('latest', JSON.stringify(payload));
      return json({ ok: true, rowCount: payload.rowCount, ingestedAt: payload.ingestedAt });
    }

    // Serve latest snapshot to the calc
    if (url.pathname === '/latest' && request.method === 'GET') {
      const raw = await env.DISPATCH.get('latest');
      if (!raw) {
        return json({ error: 'no_data', message: 'No dispatch data ingested yet' }, 404);
      }
      return new Response(raw, {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    // Driver SMS — Twilio keys stay on the Worker.
    if (url.pathname === '/sms' || url.pathname === '/send-sms') {
      const result = await handleSendSms(request, env);
      return json(result.body, result.status);
    }

    return new Response('FCT Dispatch Worker\n\nGET  /health\nGET  /latest\nPOST /ingest (auth required)\nPOST /sms\n', {
      headers: { 'Content-Type': 'text/plain', ...CORS }
    });
  }
};
