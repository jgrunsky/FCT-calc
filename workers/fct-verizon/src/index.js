/* fct-verizon Worker
 * Production snapshot (Cloudflare, 2026-08-21) plus KV-backed
 * /canonical-settings (GET from FCT_VERIZON KV, POST/PUT write).
 * v0.14: live fuel defaults are QBO $4.50 / 6 MPG, not EIA $6.919.
 *
 * Original deploy was wrangler/esbuild-bundled (hence __name helpers).
 * Keep /latest, /miles, /signals, /calibration, /dispatch-log, /health.
 */
import { handleCanonicalSettingsRequest } from "./canonical-settings.js";

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var BASE = "https://fim.api.us.fleetmatics.com";
var KV_KEY_LATEST = "latest";
var KV_KEY_TOKEN = "reveal_token";
var KV_KEY_PREV_STATE = "previous_states";
var KV_KEY_SIGNALS = "signals";
var TOKEN_LIFETIME_MS = 18 * 60 * 1e3;
var SIGNALS_MAX = 100;
var index_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return corsPreflight();
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, ts: nowIso() });
      if (url.pathname === "/latest") return await handleLatest(env);
      if (url.pathname === "/debug/auth") return await handleDebugAuth(env);
      if (url.pathname === "/debug/refresh") {
        ctx.waitUntil(refreshSnapshot(env));
        return json({ ok: true, msg: "refresh queued" });
      }
      if (url.pathname === "/debug/token") {
        const t = await getToken(
          env,
          /*force*/
          true
        );
        return json({
          ok: t.ok,
          status: t.status,
          tokenPrefix: t.token ? t.token.slice(0, 12) + "\u2026" : null,
          bodyPreview: t.raw
        });
      }
      if (url.pathname === "/debug/probe") {
        return await handleProbe(env);
      }
      if (url.pathname === "/debug/reset-day") {
        const q = url.searchParams;
        const date = q.get("date") || fctDayKey();
        const milesKey = `daily_miles_${date}`;
        const before = await env.FCT_VERIZON.get(milesKey);
        await env.FCT_VERIZON.delete(milesKey);
        const snapKey = `snap_last_${date}`;
        await env.FCT_VERIZON.delete(snapKey);
        return json({ ok: true, date, cleared: !!before, previousBytes: before ? before.length : 0 });
      }
      if (url.pathname === "/signals") {
        const raw = await env.FCT_VERIZON.get(KV_KEY_SIGNALS);
        const signals = raw ? JSON.parse(raw) : [];
        return json({ signals, count: signals.length });
      }
      if (url.pathname === "/miles-today" || url.pathname === "/miles-yesterday") {
        const d = /* @__PURE__ */ new Date();
        if (url.pathname === "/miles-yesterday") d.setTime(d.getTime() - 864e5);
        url.searchParams.set("date", fctDayKey(d));
        url.pathname = "/miles";
      }
      if (url.pathname === "/miles-real") {
        return await handleMilesReal(env, url);
      }
      if (url.pathname === "/debug/segments-raw") {
        const q = url.searchParams;
        const v = q.get("v") || "13";
        const date = q.get("date") || fctDayKey();
        const tok = await getToken(env);
        if (!tok.ok) return json({ error: "auth" }, 502);
        const bounds = pacificDayUtcBounds(date);
        const authHeader = `Atmosphere atmosphere_app_id=${env.VERIZON_APP_ID}, Bearer ${tok.token}`;
        const path = `/rad/v1/vehicles/${encodeURIComponent(v)}/segments?startdateutc=${encodeURIComponent(bounds.startUtc)}&enddateutc=${encodeURIComponent(bounds.endUtc)}`;
        const r = await fetch(`${BASE}${path}`, { method: "GET", headers: { Authorization: authHeader, Accept: "application/json" } });
        const body = await r.text();
        return new Response(body, { status: r.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      }
      if (url.pathname === "/debug/miles-probe") {
        return await handleMilesProbe(env, url);
      }
      if (url.pathname === "/miles") {
        const q = url.searchParams;
        const date = q.get("date") || fctDayKey();
        const milesKey = `daily_miles_${date}`;
        const raw = await env.FCT_VERIZON.get(milesKey);
        const perVehicle = raw ? JSON.parse(raw) : {};
        const rounded = {};
        let fleetMiles = 0;
        for (const tid in perVehicle) {
          const mi = Number(perVehicle[tid]) || 0;
          rounded[tid] = Number(mi.toFixed(1));
          fleetMiles += mi;
        }
        return json({
          date,
          fleetMiles: Number(fleetMiles.toFixed(1)),
          perVehicle: rounded,
          trucksReporting: Object.keys(rounded).length,
          method: "haversine snapshots \xD7 1.20 curve correction",
          computedAt: nowIso()
        });
      }
      if (url.pathname === "/miles/range") {
        const q = url.searchParams;
        const start = q.get("start");
        const end = q.get("end") || start;
        if (!start) return json({ error: "start required" }, 400);
        const startD = /* @__PURE__ */ new Date(start + "T00:00:00Z");
        const endD = /* @__PURE__ */ new Date(end + "T00:00:00Z");
        const days = [];
        for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
          const dstr = d.toISOString().slice(0, 10);
          const raw = await env.FCT_VERIZON.get(`daily_miles_${dstr}`);
          const perV = raw ? JSON.parse(raw) : {};
          let daily = 0;
          for (const tid in perV) daily += Number(perV[tid]) || 0;
          days.push({ date: dstr, fleetMiles: Number(daily.toFixed(1)) });
        }
        const total = days.reduce((a, d) => a + d.fleetMiles, 0);
        return json({ start, end, totalFleetMiles: Number(total.toFixed(1)), days });
      }
      if (url.pathname === "/debug/asg") {
        const tok = await getToken(env);
        if (!tok.ok) return json({ error: "auth", detail: tok });
        const vNum = url.searchParams.get("v") || "3";
        const paths = [
          `/da/v1/driverassignments/vehicles/${vNum}/currentassignment`,
          `/da/v1/driverassignments/drivers/${vNum}/currentassignment`,
          `/da/v1/driverassignments`,
          `/da/v1/driverassignments/vehicles/${vNum}`,
          `/rad/v1/driverassignments/vehicles/${vNum}/currentassignment`
        ];
        const results = await Promise.all(paths.map(async (p) => {
          const authHeader = `Atmosphere atmosphere_app_id=${env.VERIZON_APP_ID}, Bearer ${tok.token}`;
          try {
            const r = await fetch(`${BASE}${p}`, { method: "GET", headers: { Authorization: authHeader, Accept: "application/json" } });
            const body = await r.text();
            return { path: p, status: r.status, body: body.slice(0, 400) };
          } catch (e) {
            return { path: p, error: String(e && e.message || e) };
          }
        }));
        return json({ vehicleNumber: vNum, results });
      }
      if (url.pathname === "/dispatch-log") {
        if (request.method === "OPTIONS") return corsPreflight();
        if (request.method !== "POST") return json({ error: "method_not_allowed", hint: "POST { date, rows }" }, 405);
        return await handleDispatchLogPost(env, request);
      }
      if (url.pathname === "/calibration") {
        return await handleCalibration(env, url);
      }
      if (url.pathname === "/debug/calibration-inputs") {
        return await handleCalibrationInputs(env, url);
      }
      if (url.pathname === "/canonical-settings") {
        return await handleCanonicalSettingsRequest(request, env);
      }
      if (url.pathname === "/") {
        return json({
          service: "fct-verizon",
          version: "v0.14-canonical-settings-qbo-defaults-2026-08-24",
          endpoints: ["/health", "/latest", "/miles", "/miles-real", "/miles-today", "/miles-yesterday", "/miles/range", "/signals", "/calibration", "/canonical-settings (GET+POST/PUT)", "/dispatch-log (POST)", "/debug/auth", "/debug/token", "/debug/refresh", "/debug/miles-probe", "/debug/calibration-inputs"]
        });
      }
      return json({ error: "not_found", path: url.pathname }, 404);
    } catch (err) {
      return json({ error: "handler_exception", message: String(err && err.message || err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshSnapshot(env));
  }
};
async function handleLatest(env) {
  const raw = await env.FCT_VERIZON.get(KV_KEY_LATEST);
  if (!raw) {
    return json({
      error: "no_snapshot",
      hint: "cron has not fired yet, or auth failed. hit /debug/refresh then /debug/auth for diagnosis."
    }, 503);
  }
  return new Response(raw, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "*"
    }
  });
}
__name(handleLatest, "handleLatest");
async function handleDebugAuth(env) {
  const tokenAttempt = await getToken(
    env,
    /*force*/
    true
  );
  const result = {
    ts: nowIso(),
    app_id_prefix: (env.VERIZON_APP_ID || "").slice(0, 32),
    username: env.VERIZON_USERNAME || "(missing)",
    password_len: (env.VERIZON_PASSWORD || "").length,
    tokenAttempt: {
      status: tokenAttempt.status,
      ok: tokenAttempt.ok,
      tokenPrefix: tokenAttempt.token ? tokenAttempt.token.slice(0, 12) + "\u2026" : null,
      bodyPreview: tokenAttempt.raw
    }
  };
  if (tokenAttempt.ok && tokenAttempt.token) {
    const listAttempt = await callApi(env, tokenAttempt.token, "/cmd/v1/vehicles");
    result.dataAttempt = {
      path: "/cmd/v1/vehicles",
      status: listAttempt.status,
      ok: listAttempt.ok,
      bodyPreview: truncate(listAttempt.raw, 800)
    };
  }
  return json(result);
}
__name(handleDebugAuth, "handleDebugAuth");
async function handleProbe(env) {
  const tok = await getToken(env);
  if (!tok.ok || !tok.token) {
    return json({ error: "auth_failed", detail: tok });
  }
  const candidates = [
    "/cmd/v1/vehicles",
    "/rad/v2/vehicles",
    "/cmd/v1/vehicles/list",
    "/cmd/v1/vehicles/status",
    "/cmd/v1/drivers",
    "/cmd/v1/drivers/list",
    "/rad/v1/driverassignment",
    "/rad/v1/driverassignments",
    "/rad/v1/driver-assignment",
    "/rest/v1/vehicles",
    "/rest/v2/vehicles",
    "/fleetintegration/v1/vehicles",
    "/fleetintegration/v2/vehicles",
    "/vehicles",
    "/api/vehicles",
    "/cmd/v1/vehicles",
    "/v1/vehicles",
    "/v2/vehicles",
    "/rest/vehicles",
    "/rad/v1/attribute/vehicles",
    "/rad/v1/vehicle",
    "/rad/v1/vehiclelocations",
    "/rad/v1/vehiclelocation",
    "/rad/v1/fleet",
    "/rad/v1/fleet/vehicles"
  ];
  const results = await Promise.all(candidates.map(async (path) => {
    const authHeader = `Atmosphere atmosphere_app_id=${env.VERIZON_APP_ID}, Bearer ${tok.token}`;
    try {
      const r = await fetch(`${BASE}${path}`, {
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" }
      });
      const body = await r.text();
      return { path, status: r.status, ok: r.ok, snippet: body.slice(0, 200) };
    } catch (e) {
      return { path, error: String(e && e.message || e) };
    }
  }));
  const hits = results.filter((r) => r.ok || r.status && r.status !== 404 && r.status !== 405);
  return json({ tokenOk: true, hits, all: results });
}
__name(handleProbe, "handleProbe");
async function refreshSnapshot(env) {
  const started = nowIso();
  const tok = await getToken(env);
  if (!tok.ok || !tok.token) {
    await env.FCT_VERIZON.put(KV_KEY_LATEST, JSON.stringify({
      ingestedAt: started,
      error: "auth_failed",
      status: tok.status,
      bodyPreview: tok.raw
    }));
    return;
  }
  const vehicles = await callApi(env, tok.token, "/cmd/v1/vehicles");
  const drivers = await callApi(env, tok.token, "/cmd/v1/drivers");
  const vehicleList = Array.isArray(vehicles.data) ? vehicles.data : [];
  const enriched = [];
  const batchSize = 5;
  for (let i = 0; i < vehicleList.length; i += batchSize) {
    const batch = vehicleList.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(async (v) => {
      const asgNum = v.VehicleNumber || v.Name;
      const locNum = v.Name || v.VehicleNumber;
      if (!asgNum) return { ...v, _location: null, _assignment: null, _driverName: null };
      const [loc, asg] = await Promise.all([
        callApi(env, tok.token, `/rad/v1/vehicles/${encodeURIComponent(locNum)}/location`),
        callApi(env, tok.token, `/da/v1/driverassignments/vehicles/${encodeURIComponent(asgNum)}/currentassignment`)
      ]);
      let driverName = null, asgStart = null;
      if (asg.ok && asg.data) {
        const d = asg.data;
        if (d.DriverNumber || d.driverNumber) {
          driverName = d.DriverName || d.driverName || d.DriverNumber || d.driverNumber;
          asgStart = d.StartDateUTC || d.startDateUTC || null;
        }
      } else if (asg.status === 404 && asg.raw) {
        const m = asg.raw.match(/([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+)\s+is currently assigned to Vehicle Number/i);
        if (m) driverName = m[1];
      }
      return {
        ...v,
        _location: loc.ok ? loc.data : null,
        _locStatus: loc.status,
        _assignment: asg.ok ? asg.data : null,
        _asgStatus: asg.status,
        _asgRaw: asg.status === 404 ? String(asg.raw || "").slice(0, 200) : null,
        _driverName: driverName,
        _driverAssignmentStart: asgStart
      };
    }));
    const results = settled.map((s, idx) => s.status === "fulfilled" ? s.value : { ...batch[idx], _location: null, _driverName: null, _enrichmentError: String(s.reason && s.reason.message || s.reason) });
    enriched.push(...results);
    try {
      await env.FCT_VERIZON.put(KV_KEY_LATEST, JSON.stringify({
        ingestedAt: started,
        workerVersion: "v0.11-calibration-2026-08-21",
        vehicleCount: vehicleList.length,
        driverCount: Array.isArray(drivers.data) ? drivers.data.length : 0,
        vehiclesEnrichedWithDriverName: enriched.filter((v) => v._driverName).length,
        vehiclesEnriched: enriched.length,
        vehiclesTotal: vehicleList.length,
        partial: enriched.length < vehicleList.length,
        vehicles: enriched.concat(vehicleList.slice(enriched.length)).slice(0, 200),
        drivers: Array.isArray(drivers.data) ? drivers.data.slice(0, 200) : []
      }));
    } catch (e) {
    }
  }
  try {
    const prevRaw = await env.FCT_VERIZON.get(KV_KEY_PREV_STATE);
    const prev = prevRaw ? JSON.parse(prevRaw) : {};
    const newSignals = [];
    const nowIsoStr = nowIso();
    enriched.forEach((v) => {
      const truckId = String(v.Name || v.VehicleNumber || "");
      if (!truckId || !v._location) return;
      const loc = v._location;
      const p = prev[truckId] || {};
      const curSpeed = loc.Speed || 0;
      const curGeoFence = String(loc.GeoFenceName || "");
      const curDisplayState = String(loc.DisplayState || "");
      const isHome = /home terminal/i.test(curGeoFence);
      const prevSpeed = p.speed || 0;
      const prevGeoFence = String(p.geoFence || "");
      const prevWasHome = /home terminal/i.test(prevGeoFence);
      const base = { truck: truckId, driver: v._driverName || null, at: nowIsoStr, lat: loc.Latitude, lng: loc.Longitude, addr: loc.Address && loc.Address.AddressLine1 || curGeoFence };
      if (p.speed !== void 0) {
        if (prevSpeed === 0 && curSpeed > 0) {
          newSignals.push({ type: "truck_start", ...base, note: "engine on" });
        } else if (prevSpeed > 0 && curSpeed === 0) {
          newSignals.push({ type: "truck_stop", ...base, note: "stopped" });
        }
        if (!prevWasHome && isHome) {
          newSignals.push({ type: "arrived_yard", ...base, note: "returned to yard" });
        } else if (prevWasHome && !isHome && curSpeed > 0) {
          newSignals.push({ type: "left_yard", ...base, note: "departed yard" });
        }
        if (prevGeoFence !== curGeoFence && curGeoFence && !isHome) {
          newSignals.push({ type: "arrived_location", ...base, note: "arrived " + curGeoFence });
        }
      }
      prev[truckId] = { speed: curSpeed, geoFence: curGeoFence, displayState: curDisplayState, at: nowIsoStr };
    });
    await env.FCT_VERIZON.put(KV_KEY_PREV_STATE, JSON.stringify(prev));
    if (newSignals.length) {
      const existingRaw = await env.FCT_VERIZON.get(KV_KEY_SIGNALS);
      const existing = existingRaw ? JSON.parse(existingRaw) : [];
      const combined = newSignals.concat(existing).slice(0, SIGNALS_MAX);
      await env.FCT_VERIZON.put(KV_KEY_SIGNALS, JSON.stringify(combined));
    }
  } catch (e) {
  }
  try {
    const prevLocRaw = await env.FCT_VERIZON.get("prev_locations");
    const prevLoc = prevLocRaw ? JSON.parse(prevLocRaw) : {};
    const today = fctDayKey();
    const milesKey = `daily_miles_${today}`;
    const milesRaw = await env.FCT_VERIZON.get(milesKey);
    const milesToday = milesRaw ? JSON.parse(milesRaw) : {};
    const nowMs = Date.now();
    for (const v of enriched) {
      const tid = String(v.Name || v.VehicleNumber || "");
      if (!tid || !v._location) continue;
      const loc = v._location;
      const lat = Number(loc.Latitude), lng = Number(loc.Longitude);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const prev = prevLoc[tid];
      if (prev && isFinite(prev.lat) && isFinite(prev.lng)) {
        const mi = haversineMiles(prev.lat, prev.lng, lat, lng) * 1.2;
        if (mi > 0.05 && mi < 200) {
          milesToday[tid] = (milesToday[tid] || 0) + mi;
        }
      }
      prevLoc[tid] = { lat, lng, at: nowMs };
    }
    await env.FCT_VERIZON.put("prev_locations", JSON.stringify(prevLoc));
    await env.FCT_VERIZON.put(milesKey, JSON.stringify(milesToday), { expirationTtl: 60 * 60 * 24 * 35 });
  } catch (e) {
  }
  const snapshot = {
    ingestedAt: started,
    workerVersion: "v0.9.1-reset-day-2026-08-21",
    vehicleCount: Array.isArray(vehicles.data) ? vehicles.data.length : 0,
    driverCount: Array.isArray(drivers.data) ? drivers.data.length : 0,
    vehiclesEnrichedWithDriverName: enriched.filter((v) => v._driverName).length,
    vehiclesEnriched: enriched.length,
    vehiclesTotal: vehicleList.length,
    partial: false,
    enrichmentSampleFirst: enriched[0] ? Object.keys(enriched[0]) : [],
    vehicles: enriched.slice(0, 200),
    drivers: Array.isArray(drivers.data) ? drivers.data.slice(0, 200) : [],
    debug: {
      vehiclesStatus: vehicles.status,
      driversStatus: drivers.status,
      vehiclesBodyPreview: vehicles.data ? null : truncate(vehicles.raw, 500),
      driversBodyPreview: drivers.data ? null : truncate(drivers.raw, 500)
    }
  };
  await env.FCT_VERIZON.put(KV_KEY_LATEST, JSON.stringify(snapshot));
}
__name(refreshSnapshot, "refreshSnapshot");
function pacificDayUtcBounds(dateStr) {
  const probe = /* @__PURE__ */ new Date(dateStr + "T12:00:00-07:00");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false
  }).formatToParts(probe);
  const laHour = parseInt((parts.find((p) => p.type === "hour") || {}).value || "12", 10);
  const offset = laHour === 12 ? "-07:00" : "-08:00";
  const start = /* @__PURE__ */ new Date(dateStr + "T00:00:00" + offset);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1e3);
  const fmt = /* @__PURE__ */ __name((d) => d.toISOString().slice(0, 19), "fmt");
  return { startUtc: fmt(start), endUtc: fmt(end), offset };
}
__name(pacificDayUtcBounds, "pacificDayUtcBounds");
async function getFleetVehicleList(env, token) {
  const raw = await env.FCT_VERIZON.get(KV_KEY_LATEST);
  if (raw) {
    try {
      const snap = JSON.parse(raw);
      if (Array.isArray(snap.vehicles) && snap.vehicles.length) {
        return snap.vehicles.map((v) => ({
          name: String(v.Name || v.VehicleNumber || ""),
          vehicleNumber: String(v.VehicleNumber || v.Name || "")
        })).filter((v) => v.name);
      }
    } catch (_) {
    }
  }
  const res = await callApi(env, token, "/cmd/v1/vehicles");
  if (res.ok && Array.isArray(res.data)) {
    return res.data.map((v) => ({
      name: String(v.Name || v.VehicleNumber || ""),
      vehicleNumber: String(v.VehicleNumber || v.Name || "")
    })).filter((v) => v.name);
  }
  return [];
}
__name(getFleetVehicleList, "getFleetVehicleList");
async function fetchVehicleRealMiles(env, token, vehicleName, startUtc, endUtc) {
  const authHeader = `Atmosphere atmosphere_app_id=${env.VERIZON_APP_ID}, Bearer ${token}`;
  const enc = encodeURIComponent;
  const tried = [];
  const segPath = `/rad/v1/vehicles/${enc(vehicleName)}/segments?startdateutc=${enc(startUtc)}&enddateutc=${enc(endUtc)}`;
  try {
    const r = await fetch(`${BASE}${segPath}`, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/json" }
    });
    if (r.status === 200) {
      const body = await r.text();
      let data = null;
      try {
        data = JSON.parse(body);
      } catch (_) {
      }
      if (data) {
        const miles = milesFromSegmentsResponse(data);
        if (miles !== null) {
          tried.push({ path: segPath, status: 200, note: `ok ${miles.toFixed(1)} mi` });
          return { ok: true, method: "segment", miles, sourcePath: segPath, tried };
        }
        tried.push({ path: segPath, status: 200, note: "200 but no Segments/DistanceKilometers (" + describeShape(data) + ")" });
      } else {
        tried.push({ path: segPath, status: 200, note: "unparseable JSON" });
      }
    } else {
      const body = await r.text();
      tried.push({ path: segPath, status: r.status, note: body.slice(0, 120) });
    }
  } catch (e) {
    tried.push({ path: segPath, status: 0, note: "fetch_error: " + String(e && e.message || e) });
  }
  const chunkHours = 4;
  const startMs = Date.parse(startUtc + "Z");
  const endMs = Date.parse(endUtc + "Z");
  const chunkMs = chunkHours * 3600 * 1e3;
  let minOdo = null, maxOdo = null;
  let anyChunk200 = false;
  const chunkNotes = [];
  const fmtUtc = /* @__PURE__ */ __name((ms) => new Date(ms).toISOString().slice(0, 19), "fmtUtc");
  for (let cs = startMs; cs < endMs; cs += chunkMs) {
    const ce = Math.min(cs + chunkMs, endMs);
    const histPath = `/rad/v1/vehicles/${enc(vehicleName)}/status/history?startdatetimeutc=${enc(fmtUtc(cs))}&enddatetimeutc=${enc(fmtUtc(ce))}`;
    try {
      const r = await fetch(`${BASE}${histPath}`, {
        method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" }
      });
      if (r.status === 200) {
        anyChunk200 = true;
        const body = await r.text();
        let arr = null;
        try {
          arr = JSON.parse(body);
        } catch (_) {
        }
        if (Array.isArray(arr)) {
          for (const rec of arr) {
            const o = Number(rec && rec.OdometerInKM);
            if (isFinite(o) && o > 0) {
              if (minOdo === null || o < minOdo) minOdo = o;
              if (maxOdo === null || o > maxOdo) maxOdo = o;
            }
          }
          chunkNotes.push(`${fmtUtc(cs).slice(11)}: ${arr.length} recs`);
        }
      } else {
        chunkNotes.push(`${fmtUtc(cs).slice(11)}: ${r.status}`);
      }
    } catch (e) {
      chunkNotes.push(`${fmtUtc(cs).slice(11)}: err`);
    }
  }
  if (anyChunk200) {
    const km = minOdo !== null && maxOdo !== null ? Math.max(0, maxOdo - minOdo) : 0;
    const miles = km * 0.621371;
    tried.push({ path: "history-chunked", status: 200, note: `odo \u0394 ${km.toFixed(1)} km = ${miles.toFixed(1)} mi; ${chunkNotes.join(", ")}` });
    return { ok: true, method: "history", miles, sourcePath: "history-chunked-4h", tried };
  }
  return { ok: false, method: null, miles: 0, sourcePath: null, tried };
}
__name(fetchVehicleRealMiles, "fetchVehicleRealMiles");
function milesFromSegmentsResponse(data) {
  if (!Array.isArray(data)) return null;
  let totalKm = 0;
  let matched = 0;
  for (const wrap of data) {
    const segs = wrap && (wrap.Segments || wrap.segments);
    if (!Array.isArray(segs)) continue;
    for (const seg of segs) {
      const km = Number(seg && (seg.DistanceKilometers ?? seg.distanceKilometers));
      if (isFinite(km) && km > 0) {
        totalKm += km;
        matched++;
      }
    }
  }
  if (data.length && matched === 0) {
    return 0;
  }
  return totalKm * 0.621371;
}
__name(milesFromSegmentsResponse, "milesFromSegmentsResponse");
function describeShape(data) {
  if (Array.isArray(data)) {
    if (data.length === 0) return "[] empty array";
    return "array[" + data.length + "], first keys: " + Object.keys(data[0] || {}).slice(0, 6).join(",");
  }
  if (data && typeof data === "object") return "object keys: " + Object.keys(data).slice(0, 6).join(",");
  return typeof data;
}
__name(describeShape, "describeShape");
async function handleMilesReal(env, url) {
  const q = url.searchParams;
  const date = q.get("date") || fctDayKey();
  const debug = q.get("debug") === "1";
  const tok = await getToken(env);
  if (!tok.ok || !tok.token) {
    return json({ error: "auth_failed", detail: tok }, 502);
  }
  const bounds = pacificDayUtcBounds(date);
  const vehicles = await getFleetVehicleList(env, tok.token);
  if (!vehicles.length) {
    return json({ error: "no_vehicles", hint: "latest snapshot missing and live vehicle list failed" }, 503);
  }
  const batchSize = 25;
  const perVehicle = {};
  const diagnostics = [];
  const methodCounts = { segment: 0, history: 0, none: 0 };
  for (let i = 0; i < vehicles.length; i += batchSize) {
    const batch = vehicles.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(
      (v) => fetchVehicleRealMiles(env, tok.token, v.name, bounds.startUtc, bounds.endUtc).then((res) => ({ v, res }))
    ));
    for (const s of settled) {
      if (s.status !== "fulfilled") {
        diagnostics.push({ truck: "?", error: String(s.reason && s.reason.message || s.reason) });
        continue;
      }
      const { v, res } = s.value;
      if (res.ok) {
        perVehicle[v.name] = Number(res.miles.toFixed(1));
        methodCounts[res.method] = (methodCounts[res.method] || 0) + 1;
        if (debug) diagnostics.push({ truck: v.name, method: res.method, miles: perVehicle[v.name], sourcePath: res.sourcePath });
      } else {
        perVehicle[v.name] = 0;
        methodCounts.none++;
        diagnostics.push({ truck: v.name, error: "all endpoints failed", tried: res.tried });
      }
    }
  }
  const fleetMiles = Object.values(perVehicle).reduce((a, b) => a + Number(b || 0), 0);
  const trucksReporting = Object.values(perVehicle).filter((m) => m > 0).length;
  let method = "none";
  if (methodCounts.segment && methodCounts.history) method = "mixed";
  else if (methodCounts.segment) method = "segment";
  else if (methodCounts.history) method = "history";
  return json({
    date,
    fleetMiles: Number(fleetMiles.toFixed(1)),
    perVehicle,
    trucksReporting,
    method,
    methodCounts,
    utcRange: { start: bounds.startUtc, end: bounds.endUtc, pacificOffset: bounds.offset },
    computedAt: nowIso(),
    workerVersion: "v0.11-calibration-2026-08-21",
    ...debug || methodCounts.none ? { diagnostics } : {}
  });
}
__name(handleMilesReal, "handleMilesReal");
async function handleMilesProbe(env, url) {
  const q = url.searchParams;
  const v = q.get("v") || "13";
  const date = q.get("date") || fctDayKey();
  const tok = await getToken(env);
  if (!tok.ok || !tok.token) return json({ error: "auth", detail: tok }, 502);
  const bounds = pacificDayUtcBounds(date);
  const authHeader = `Atmosphere atmosphere_app_id=${env.VERIZON_APP_ID}, Bearer ${tok.token}`;
  const enc = encodeURIComponent;
  const now = /* @__PURE__ */ new Date();
  const twoAgo = new Date(now.getTime() - 2 * 60 * 60 * 1e3);
  const fmt = /* @__PURE__ */ __name((d) => d.toISOString().slice(0, 19), "fmt");
  const s2h = fmt(twoAgo), e2h = fmt(now);
  const fullDayS = bounds.startUtc, fullDayE = bounds.endUtc;
  const paths = [
    // History variations
    `/rad/v1/vehicles/${enc(v)}/status/history?startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    `/rad/v1/vehicles/${enc(v)}/status/history?startDateTimeUtc=${enc(s2h)}&endDateTimeUtc=${enc(e2h)}`,
    `/rad/v1/vehicles/${enc(v)}/status/history?startdatetimeutc=${enc(s2h + ".000Z")}&enddatetimeutc=${enc(e2h + ".000Z")}`,
    `/rad/v1/vehicles/${enc(v)}/status/history?startdatetimeutc=${enc(s2h + "Z")}&enddatetimeutc=${enc(e2h + "Z")}`,
    `/rad/v1/vehicles/${enc(v)}/status/history?startdatetimeutc=${s2h}&enddatetimeutc=${e2h}`,
    `/rad/v1/vehicles/${enc(v)}/history?startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    // Full-day (24 hours) — might exceed a "max window" limit
    `/rad/v1/vehicles/${enc(v)}/status/history?startdatetimeutc=${enc(fullDayS)}&enddatetimeutc=${enc(fullDayE)}`,
    // Segment / trip variants — different paths
    `/rad/v2/vehicles/${enc(v)}/segments?startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    `/rad/v1/vehicles/${enc(v)}/segments?startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    // Segment API wants `startdateutc` / `enddateutc` (no "time" middle)
    `/rad/v1/vehicles/${enc(v)}/segments?startdateutc=${enc(s2h)}&enddateutc=${enc(e2h)}`,
    `/rad/v1/vehicles/${enc(v)}/segments?startdateutc=${enc(fullDayS)}&enddateutc=${enc(fullDayE)}`,
    // Try 12-hour chunk on history
    `/rad/v1/vehicles/${enc(v)}/status/history?startdatetimeutc=${enc(fullDayS)}&enddatetimeutc=${enc(fmt(new Date((/* @__PURE__ */ new Date(fullDayS + "Z")).getTime() + 12 * 3600 * 1e3)))}`,
    // Try 4-hour chunk on history
    `/rad/v1/vehicles/${enc(v)}/status/history?startdatetimeutc=${enc(fullDayS)}&enddatetimeutc=${enc(fmt(new Date((/* @__PURE__ */ new Date(fullDayS + "Z")).getTime() + 4 * 3600 * 1e3)))}`,
    `/rad/v1/vehiclesegments?vehiclenumber=${enc(v)}&startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    `/rad/v1/segments/vehicles/${enc(v)}?startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    `/rad/v1/vehicles/${enc(v)}/trip?startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    // Odometer / distance summary
    `/rad/v1/vehicles/${enc(v)}/distance?startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    `/rad/v1/vehicles/${enc(v)}/distancesummary?startdatetimeutc=${enc(s2h)}&enddatetimeutc=${enc(e2h)}`,
    // Try /documents to see what routes exist
    `/rad/v1/documents`,
    `/rad/documents`,
    `/documents`
  ];
  const results = await Promise.all(paths.map(async (p) => {
    try {
      const r = await fetch(`${BASE}${p}`, { method: "GET", headers: { Authorization: authHeader, Accept: "application/json" } });
      const body = await r.text();
      return { path: p, status: r.status, snippet: body.slice(0, 300) };
    } catch (e) {
      return { path: p, error: String(e && e.message || e) };
    }
  }));
  return json({
    vehicle: v,
    date,
    windowUsed: { start: s2h, end: e2h },
    fullDayWindow: { start: fullDayS, end: fullDayE },
    results
  });
}
__name(handleMilesProbe, "handleMilesProbe");
async function getToken(env, force = false) {
  if (!force) {
    const cached = await env.FCT_VERIZON.get(KV_KEY_TOKEN, "json");
    if (cached && cached.token && cached.expiresAt && cached.expiresAt - Date.now() > 6e4) {
      return { ok: true, token: cached.token, status: 200, raw: "(cached)" };
    }
  }
  const basic = btoa(`${env.VERIZON_USERNAME}:${env.VERIZON_PASSWORD}`);
  const res = await fetch(`${BASE}/token`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "text/plain"
    }
  });
  const bodyText = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, token: null, raw: truncate(bodyText, 500) };
  }
  const token = bodyText.trim().replace(/^"|"$/g, "");
  if (!token) {
    return { ok: false, status: res.status, token: null, raw: "(empty body)" };
  }
  await env.FCT_VERIZON.put(KV_KEY_TOKEN, JSON.stringify({
    token,
    expiresAt: Date.now() + TOKEN_LIFETIME_MS
  }));
  return { ok: true, status: res.status, token, raw: token.slice(0, 40) + "\u2026" };
}
__name(getToken, "getToken");
async function callApi(env, token, path) {
  const authHeader = `Atmosphere atmosphere_app_id=${env.VERIZON_APP_ID}, Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      Accept: "application/json"
    }
  });
  const bodyText = await res.text();
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch (_) {
  }
  return { ok: res.ok, status: res.status, data, raw: bodyText };
}
__name(callApi, "callApi");
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    }
  });
}
__name(json, "json");
function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400"
    }
  });
}
__name(corsPreflight, "corsPreflight");
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
__name(nowIso, "nowIso");
function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "\u2026" : s;
}
__name(truncate, "truncate");
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = /* @__PURE__ */ __name((d) => d * Math.PI / 180, "toRad");
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}
__name(haversineMiles, "haversineMiles");
var LANE_MILES = {
  "PNG": { "LATHROP": 32, "RIPON": 50 },
  "PENNY NEWMAN": { "LATHROP": 32, "RIPON": 50 },
  "FCG": { "LATHROP": 10, "RIPON": 26, "PURINA": 80, "ARDENT": 30, "FARMERS": 80, "DIESTEL": 120, "CNP": 250, "MILLER": 100, "BERRY": 80, "LOCKWOOD": 250 },
  "FCGE": { "LATHROP": 10, "RIPON": 26, "PURINA": 80, "ARDENT": 30, "FARMERS": 80, "DIESTEL": 120, "CNP": 250, "MILLER": 100, "BERRY": 80, "LOCKWOOD": 250 },
  "ARA": { "LATHROP": 28, "RIPON": 50 },
  "FOSTER": { "RIPON": 78, "LATHROP": 85 },
  "FOSTERS": { "RIPON": 78, "LATHROP": 85 },
  "CV MEAT": { "RIPON": 290, "LATHROP": 285 },
  "HARRIS": { "RIPON": 280, "LATHROP": 275 },
  "MERWIN": { "FCG": 55 },
  "SH MERWIN": { "FCG": 55 },
  "PELICAN": { "PURINA": 90, "FCG": 30 },
  "STOKES": { "FCG": 90 },
  "STOKES FARMS": { "FCG": 90 },
  "JACQUES": { "ARDENT": 100 },
  "JACQUES BROS": { "ARDENT": 100 },
  "JAQUES": { "ARDENT": 100 },
  "COLEMAN": { "FCG": 70 },
  "COLEMAN FOLEY": { "FCG": 70 },
  "VICTORIA": { "FCG": 60 },
  "VICTORIA ISLAND": { "FCG": 60 },
  "ART SPINELLA": { "FCG": 70 },
  "SPINELLA": { "FCG": 70 },
  "PERDUE": { "DIESTEL": 120, "ASSOC": 80 },
  "ADM": { "LATHROP": 100, "RIPON": 110, "FCG": 80 },
  "ADM PORT SACTO": { "FCG": 80 },
  "SUNWEST": { "LATHROP": 220 },
  "FRC": { "LATHROP": 100, "CNP": 100 }
};
function normOriginW(s) {
  return String(s || "").toUpperCase().trim().replace(/\s+/g, " ");
}
__name(normOriginW, "normOriginW");
function laneMilesForW(origin, destination) {
  const o = normOriginW(origin);
  const d = String(destination || "").toUpperCase();
  if (!o) return null;
  const trials = [o];
  const beforeDash = o.split(" - ")[0].trim();
  if (beforeDash && beforeDash !== o) trials.push(beforeDash);
  const twoWord = o.split(/\s+/).slice(0, 2).join(" ");
  if (twoWord && trials.indexOf(twoWord) < 0) trials.push(twoWord);
  const firstWord = o.split(/\s+/)[0];
  if (firstWord && trials.indexOf(firstWord) < 0) trials.push(firstWord);
  for (const trial of trials) {
    const map = LANE_MILES[trial];
    if (!map) continue;
    for (const destKey in map) {
      if (d.indexOf(destKey) >= 0) return map[destKey];
    }
  }
  return null;
}
__name(laneMilesForW, "laneMilesForW");
function canonicalLaneKey(origin, destination) {
  const o = normOriginW(origin);
  const d = String(destination || "").toUpperCase();
  if (!o) return null;
  const trials = [o];
  const beforeDash = o.split(" - ")[0].trim();
  if (beforeDash && beforeDash !== o) trials.push(beforeDash);
  const twoWord = o.split(/\s+/).slice(0, 2).join(" ");
  if (twoWord && trials.indexOf(twoWord) < 0) trials.push(twoWord);
  const firstWord = o.split(/\s+/)[0];
  if (firstWord && trials.indexOf(firstWord) < 0) trials.push(firstWord);
  for (const trial of trials) {
    const map = LANE_MILES[trial];
    if (!map) continue;
    for (const destKey in map) {
      if (d.indexOf(destKey) >= 0) return trial + "\u2192" + destKey;
    }
  }
  return null;
}
__name(canonicalLaneKey, "canonicalLaneKey");
async function handleDispatchLogPost(env, request) {
  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_json", message: String(e && e.message || e) }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "bad_body", hint: "expected { date, rows } or { days:[{date,rows}] }" }, 400);
  }
  const days = Array.isArray(body.days) ? body.days : body.date && Array.isArray(body.rows) ? [{ date: body.date, rows: body.rows }] : null;
  if (!days) {
    return json({ error: "bad_body", hint: "expected { date, rows } or { days:[{date,rows}] }" }, 400);
  }
  const results = [];
  for (const day of days) {
    if (!day || !day.date || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Array.isArray(day.rows)) {
      results.push({ date: day && day.date, ok: false, error: "bad_day_entry" });
      continue;
    }
    const slim = day.rows.map((r) => ({
      origin: String(r && r.origin || "").trim(),
      destination: String(r && (r.destination || r.deliveryPoint) || "").trim(),
      truck: String(r && r.truck || "").trim(),
      status: String(r && r.status || "").trim()
    })).filter((r) => r.origin || r.destination || r.truck);
    const payload = { date: day.date, rows: slim, savedAt: nowIso() };
    try {
      await env.FCT_VERIZON.put(
        `dispatch_${day.date}`,
        JSON.stringify(payload),
        { expirationTtl: 60 * 60 * 24 * 35 }
      );
      results.push({ date: day.date, ok: true, rows: slim.length });
    } catch (e) {
      results.push({ date: day.date, ok: false, error: String(e && e.message || e) });
    }
  }
  try {
    await env.FCT_VERIZON.delete("calibration_v1");
  } catch (_) {
  }
  return json({ ok: true, saved: results, cacheInvalidated: true });
}
__name(handleDispatchLogPost, "handleDispatchLogPost");
async function loadDispatchDay(env, dateStr) {
  const raw = await env.FCT_VERIZON.get(`dispatch_${dateStr}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
__name(loadDispatchDay, "loadDispatchDay");
async function computeMilesRealForDate(env, dateStr) {
  const fakeUrl = new URL(`https://internal/miles-real?date=${dateStr}`);
  const res = await handleMilesReal(env, fakeUrl);
  try {
    const j = await res.json();
    return j;
  } catch (_) {
    return null;
  }
}
__name(computeMilesRealForDate, "computeMilesRealForDate");
async function handleCalibration(env, url) {
  const q = url.searchParams;
  const window = Math.max(1, Math.min(30, parseInt(q.get("window") || "7", 10) || 7));
  const force = q.get("force") === "1";
  const cacheKey = `calibration_v1`;
  if (!force) {
    const cached = await env.FCT_VERIZON.get(cacheKey);
    if (cached) {
      try {
        const j = JSON.parse(cached);
        if (j && j.expiresAt && j.expiresAt > Date.now() && j.windowDays === window) {
          return json({ ...j.data, cached: true });
        }
      } catch (_) {
      }
    }
  }
  const result = await computeCalibration(env, window);
  try {
    await env.FCT_VERIZON.put(cacheKey, JSON.stringify({
      windowDays: window,
      data: result,
      expiresAt: Date.now() + 6 * 60 * 60 * 1e3
    }), { expirationTtl: 60 * 60 * 12 });
  } catch (_) {
  }
  return json(result);
}
__name(handleCalibration, "handleCalibration");
async function computeCalibration(env, windowDays) {
  const today = fctDayKey();
  const days = [];
  const start = /* @__PURE__ */ new Date(today + "T12:00:00Z");
  for (let i = 1; i <= windowDays; i++) {
    const d = new Date(start.getTime() - i * 864e5);
    days.push(fctDayKey(d));
  }
  const perDay = await Promise.all(days.map(async (date) => {
    const [disp, milesRes] = await Promise.all([
      loadDispatchDay(env, date),
      computeMilesRealForDate(env, date)
    ]);
    return { date, disp, milesRes };
  }));
  const laneAgg = {};
  let fleetPredicted = 0, fleetActual = 0;
  let daysWithDispatch = 0, daysWithMiles = 0;
  const dayDiags = [];
  for (const d of perDay) {
    const hasDispatch = !!(d.disp && Array.isArray(d.disp.rows) && d.disp.rows.length);
    const perVehicle = d.milesRes && d.milesRes.perVehicle || {};
    const hasMiles = Object.keys(perVehicle).length > 0;
    if (hasDispatch) daysWithDispatch++;
    if (hasMiles) daysWithMiles++;
    if (!hasDispatch || !hasMiles) {
      dayDiags.push({ date: d.date, hasDispatch, hasMiles, skipped: true });
      continue;
    }
    let fleetDayPredictedRaw = 0;
    let laneMatchedLoads = 0, laneUnmatchedLoads = 0;
    const perLaneFleet = {};
    for (const r of d.disp.rows) {
      if (/PUSH/i.test(r.status || "")) continue;
      const key = canonicalLaneKey(r.origin, r.destination);
      const mi = laneMilesForW(r.origin, r.destination);
      if (!key || !mi || mi <= 0) {
        laneUnmatchedLoads++;
        continue;
      }
      const pl = perLaneFleet[key] = perLaneFleet[key] || { pred: 0, loads: 0 };
      pl.pred += mi;
      pl.loads += 1;
      fleetDayPredictedRaw += mi;
      laneMatchedLoads++;
    }
    const totalActiveLoads = laneMatchedLoads + laneUnmatchedLoads;
    const avgMiPerMatchedLoad = laneMatchedLoads > 0 ? fleetDayPredictedRaw / laneMatchedLoads : 0;
    const fleetDayPredicted = totalActiveLoads > 0 && laneMatchedLoads > 0 ? avgMiPerMatchedLoad * totalActiveLoads : fleetDayPredictedRaw;
    let fleetDayActual = 0;
    for (const tid in perVehicle) fleetDayActual += Number(perVehicle[tid] || 0);
    fleetPredicted += fleetDayPredicted;
    fleetActual += fleetDayActual;
    const perTruck = {};
    let truckMatchedLoads = 0;
    for (const r of d.disp.rows) {
      if (/PUSH/i.test(r.status || "")) continue;
      const truck = String(r.truck || "").trim();
      if (!truck) continue;
      if (!/^\d+$/.test(truck)) continue;
      const key = canonicalLaneKey(r.origin, r.destination);
      const mi = laneMilesForW(r.origin, r.destination);
      if (!key || !mi || mi <= 0) continue;
      const t = perTruck[truck] = perTruck[truck] || { totalPred: 0, byLane: {} };
      const lb = t.byLane[key] = t.byLane[key] || { pred: 0, loads: 0 };
      lb.pred += mi;
      lb.loads += 1;
      t.totalPred += mi;
      truckMatchedLoads++;
    }
    for (const truck in perTruck) {
      const t = perTruck[truck];
      const actual = Number(perVehicle[truck] || 0);
      if (t.totalPred <= 0 || actual <= 0) continue;
      for (const laneKey in t.byLane) {
        const lb = t.byLane[laneKey];
        const share = lb.pred / t.totalPred;
        const laneActual = actual * share;
        const agg = laneAgg[laneKey] = laneAgg[laneKey] || { predicted: 0, actual: 0, loads: 0 };
        agg.predicted += lb.pred;
        agg.actual += laneActual;
        agg.loads += lb.loads;
      }
    }
    dayDiags.push({
      date: d.date,
      hasDispatch,
      hasMiles,
      totalRows: d.disp.rows.length,
      laneMatchedLoads,
      laneUnmatchedLoads,
      truckMatchedLoads,
      // loads where truck field is digits (Verizon-shaped)
      trucksWithMiles: Object.keys(perVehicle).filter((k) => Number(perVehicle[k]) > 0).length,
      fleetPredictedMiRaw: Number(fleetDayPredictedRaw.toFixed(1)),
      fleetPredictedMiGrossed: Number(fleetDayPredicted.toFixed(1)),
      fleetActualMi: Number(fleetDayActual.toFixed(1)),
      dayFleetFactor: fleetDayPredicted > 0 ? Number((fleetDayActual / fleetDayPredicted).toFixed(3)) : null
    });
  }
  const lanes = {};
  const flagged = [];
  for (const key in laneAgg) {
    const a = laneAgg[key];
    const factor = a.predicted > 0 ? a.actual / a.predicted : null;
    if (!factor || !isFinite(factor)) continue;
    if (a.loads < 5) {
      continue;
    }
    if (factor > 2 || factor < 0.5) {
      flagged.push({
        lane: key,
        factor: Number(factor.toFixed(3)),
        loadsInWindow: a.loads,
        predictedMi: Number(a.predicted.toFixed(1)),
        actualMi: Number(a.actual.toFixed(1)),
        reason: factor > 2 ? "factor>2.0 (attribution suspect)" : "factor<0.5 (attribution suspect)"
      });
      continue;
    }
    lanes[key] = {
      factor: Number(factor.toFixed(3)),
      loadsInWindow: a.loads,
      predictedMi: Number(a.predicted.toFixed(1)),
      actualMi: Number(a.actual.toFixed(1))
    };
  }
  const fleetFactor = fleetPredicted > 0 ? Math.max(0.5, Math.min(2, Number((fleetActual / fleetPredicted).toFixed(3)))) : 1;
  return {
    windowDays,
    computedAt: nowIso(),
    lanes,
    fleetFactor,
    flagged,
    coverage: {
      daysRequested: windowDays,
      daysWithDispatch,
      daysWithMiles,
      daysUsed: dayDiags.filter((d) => !d.skipped).length,
      fleetPredictedMi: Number(fleetPredicted.toFixed(1)),
      fleetActualMi: Number(fleetActual.toFixed(1))
    },
    perDay: dayDiags,
    note: daysWithDispatch === 0 ? "No dispatch logs in KV \u2014 the calc needs to POST /dispatch-log for the last " + windowDays + " days." : daysWithMiles === 0 ? "No Verizon miles for the window \u2014 check /miles-real for one of these dates." : Object.keys(lanes).length === 0 ? "Fleet factor uses gross-up: fleetPredicted scaled by (all_loads/lane_matched_loads) to compensate for loads without a LANE_MILES entry (they contribute to actual but not raw predicted). Per-lane factors empty because dispatch 'truck' field carries trailer pairs / destination codes, not Verizon truck IDs \u2014 every load falls back to fleetFactor. Fix upstream: map bobtail truck ID into the truck column so per-truck actual miles can be attributed to lanes." : "Lanes with < 5 loads in window fall back to fleetFactor; flagged lanes (factor out of [0.5,2.0]) also fall back.",
    workerVersion: "v0.11-calibration-2026-08-21"
  };
}
__name(computeCalibration, "computeCalibration");
async function handleCalibrationInputs(env, url) {
  const window = Math.max(1, Math.min(30, parseInt(url.searchParams.get("window") || "7", 10) || 7));
  const today = fctDayKey();
  const days = [];
  const start = /* @__PURE__ */ new Date(today + "T12:00:00Z");
  for (let i = 1; i <= window; i++) {
    const d = new Date(start.getTime() - i * 864e5);
    days.push(fctDayKey(d));
  }
  const rows = await Promise.all(days.map(async (date) => {
    const disp = await loadDispatchDay(env, date);
    if (!disp) return { date, dispatchKV: null };
    const truckSet = {};
    (disp.rows || []).forEach((r) => {
      const t = String(r.truck || "").trim();
      if (t) truckSet[t] = (truckSet[t] || 0) + 1;
    });
    return {
      date,
      dispatchKV: {
        rows: (disp.rows || []).length,
        savedAt: disp.savedAt,
        trucks: truckSet,
        sampleRow: (disp.rows || [])[0] || null
      }
    };
  }));
  return json({ window, days: rows });
}
__name(handleCalibrationInputs, "handleCalibrationInputs");
function fctDayKey(d) {
  const dt = d instanceof Date ? d : /* @__PURE__ */ new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(dt);
}
__name(fctDayKey, "fctDayKey");
export {
  index_default as default
};
