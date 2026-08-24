/* Company-wide load-bearing settings (diesel, MPG, driver rate).
 * GET  /canonical-settings  → KV, falling back to shipped defaults
 * POST /canonical-settings  → merge + write KV (same as PUT)
 * PUT  /canonical-settings  → merge + write KV
 * OPTIONS                   → CORS preflight
 *
 * CORS matches the rest of fct-verizon: Access-Control-Allow-Origin: *
 * No auth on v1 — same as /dispatch-log POST. Last write wins.
 */

export const KV_KEY_CANONICAL_SETTINGS = "canonical_settings";

/** Shipped defaults — same numbers the live worker served as hardcoded JSON. */
export const CANONICAL_SETTINGS_DEFAULTS = {
  fuelPricePerGal: 6.919,
  fleetAvgMPG: 6.3,
  defaultDriverRate: 22.28,
  subFlatRate: 150,
  laneMilesHash: "v2.1.23-adm-port",
  rateTableHash: "v2.1.23-perdue-org-corn",
  computedAt: "2026-08-21T00:00:00Z",
  note: "Company-wide settings. Phone and computer both read and write this."
};

const POSITIVE_FIELDS = ["fuelPricePerGal", "fleetAvgMPG", "defaultDriverRate"];
const NON_NEGATIVE_FIELDS = ["subFlatRate"];
const STRING_FIELDS = ["laneMilesHash", "rateTableHash", "note"];

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders()
    }
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      "access-control-max-age": "86400"
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}

export async function loadCanonicalSettings(env) {
  const defaults = { ...CANONICAL_SETTINGS_DEFAULTS };
  if (!env || !env.FCT_VERIZON) return defaults;
  try {
    const raw = await env.FCT_VERIZON.get(KV_KEY_CANONICAL_SETTINGS);
    if (!raw) return defaults;
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return defaults;
    return { ...defaults, ...stored };
  } catch (_) {
    return defaults;
  }
}

/**
 * Merge a POST/PUT body onto current settings.
 * Returns { ok: true, value } or { ok: false, status, error }.
 */
export function mergeCanonicalSettings(current, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      error: {
        error: "bad_body",
        hint: "expected JSON object with fuelPricePerGal, fleetAvgMPG, defaultDriverRate"
      }
    };
  }
  const next = { ...(current || CANONICAL_SETTINGS_DEFAULTS) };
  for (const k of POSITIVE_FIELDS) {
    if (body[k] == null || body[k] === "") continue;
    const n = Number(body[k]);
    if (!isFinite(n) || n <= 0) {
      return {
        ok: false,
        status: 400,
        error: { error: "bad_field", field: k, hint: "must be a number greater than 0" }
      };
    }
    next[k] = n;
  }
  for (const k of NON_NEGATIVE_FIELDS) {
    if (body[k] == null || body[k] === "") continue;
    const n = Number(body[k]);
    if (!isFinite(n) || n < 0) {
      return {
        ok: false,
        status: 400,
        error: { error: "bad_field", field: k, hint: "must be a number of 0 or more" }
      };
    }
    next[k] = n;
  }
  for (const k of STRING_FIELDS) {
    if (typeof body[k] === "string") next[k] = body[k].slice(0, 500);
  }
  const stamp = nowIso();
  next.computedAt = stamp;
  next.updatedAt = stamp;
  if (typeof body.source === "string" && body.source.trim()) {
    next.updatedFrom = body.source.trim().slice(0, 80);
  }
  if (typeof body.appVersion === "string" && body.appVersion.trim()) {
    next.appVersion = body.appVersion.trim().slice(0, 120);
  }
  delete next.servedAt;
  delete next.ok;
  return { ok: true, value: next };
}

export async function handleCanonicalSettingsRequest(request, env) {
  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method === "GET") {
    const settings = await loadCanonicalSettings(env);
    const out = { ...settings };
    delete out.ok;
    return json({ ...out, servedAt: nowIso() });
  }
  if (request.method === "POST" || request.method === "PUT") {
    let body = null;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad_json", message: String(e && e.message || e) }, 400);
    }
    const current = await loadCanonicalSettings(env);
    const merged = mergeCanonicalSettings(current, body);
    if (!merged.ok) return json(merged.error, merged.status);
    try {
      if (!env || !env.FCT_VERIZON) {
        return json({ error: "kv_unbound", hint: "FCT_VERIZON KV namespace is not bound on this worker" }, 500);
      }
      await env.FCT_VERIZON.put(KV_KEY_CANONICAL_SETTINGS, JSON.stringify(merged.value));
    } catch (e) {
      return json({ error: "kv_put_failed", message: String(e && e.message || e) }, 500);
    }
    return json({ ok: true, ...merged.value, servedAt: nowIso() });
  }
  return json({ error: "method_not_allowed", hint: "GET, POST, or PUT" }, 405);
}
