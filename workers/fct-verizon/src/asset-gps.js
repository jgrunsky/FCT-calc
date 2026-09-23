/* Fleet asset class + Verizon RAD location keys.
 * Location paths use the Reveal vehicle number, not the display name.
 * Probed 2026-09-23 against the live account:
 *   GET /rad/v1/vehicles/105/segments        → 200 (Name "Van 105")
 *   GET /rad/v1/vehicles/Van%20105/segments  → 404 Unable to locate vehicle
 *   GET /rad/v1/vehicles/212448/segments     → 200 (Name "448")
 *   GET /rad/v1/vehicles/448/segments        → 404
 *   GET /rad/v1/vehicles/{VehicleId}/…       → 404 (internal id is not a RAD key)
 *   A vehicle number that contains "/" is rejected by the gateway when it
 *   is placed in the URL path (HTML 404). Those keys are tried via
 *   POST /rad/v1/vehicles/locations instead.
 */

export const ASSET_TRUCK = "truck";
export const ASSET_TRAILER = "trailer";
export const ASSET_PENDING = "pending";

const PENDING_NAME = /^\d{6,}_20\d{6}T\d{2}:\d{2}:\d{2}$/;
const PAIR_ID = /^\d+\s*\/\s*\d+$/;
const TRAILER_WORD = /\b(van|flat|trailer|hopper)\b/i;

export function classifyFleetAsset(v) {
  const stamped = v && v._assetClass;
  if (stamped === ASSET_TRUCK || stamped === ASSET_TRAILER || stamped === ASSET_PENDING) {
    return stamped;
  }
  const name = String((v && v.Name) || "").trim();
  const num = v && v.VehicleNumber != null ? String(v.VehicleNumber).trim() : "";
  const reg = String((v && v.RegistrationNumber) || "").trim();
  const make = String((v && v.Make) || "").trim();
  if (PENDING_NAME.test(name)) return ASSET_PENDING;
  if (TRAILER_WORD.test(name)) return ASSET_TRAILER;
  if (PAIR_ID.test(name) || PAIR_ID.test(num)) return ASSET_TRAILER;
  if (/^not\s*available/i.test(reg)) return ASSET_TRAILER;
  if (make) return ASSET_TRUCK;
  if (/^\d{1,2}$/.test(name) && (!num || num === name)) return ASSET_TRUCK;
  return ASSET_TRAILER;
}

/** Truck odometer / yard signals only. Trailer GPS must not double-count miles. */
export function countsTowardTruckMiles(v) {
  return classifyFleetAsset(v) === ASSET_TRUCK;
}

export function radPathSafe(key) {
  const s = String(key ?? "").trim();
  if (!s) return false;
  return !/[\/\\?#]/.test(s);
}

/** VehicleNumber, then Name, then VehicleId. Duplicates dropped. */
export function locationCandidates(v) {
  const raw = [
    v && v.VehicleNumber != null ? String(v.VehicleNumber).trim() : "",
    v && v.Name != null ? String(v.Name).trim() : "",
    v && v.VehicleId != null ? String(v.VehicleId).trim() : ""
  ];
  const out = [];
  for (const key of raw) {
    if (!key || out.indexOf(key) !== -1) continue;
    out.push(key);
  }
  return out;
}

export function pathLocationCandidates(v) {
  return locationCandidates(v).filter(radPathSafe);
}

export function slashLocationCandidates(v) {
  return locationCandidates(v).filter((key) => String(key).indexOf("/") !== -1);
}

export function gpsFromLocationBody(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "empty" };
  if (data.Message || data.message || data.ExceptionMessage) return { kind: "miss" };
  if (data.Latitude == null || data.Longitude == null) return { kind: "empty" };
  const lat = Number(data.Latitude);
  const lng = Number(data.Longitude);
  if (!isFinite(lat) || !isFinite(lng)) return { kind: "empty" };
  return { kind: "live", location: data };
}

/**
 * A 200/204 from the vehicle's own key settles the lookup (live fix, or
 * the vehicle exists and has not reported coordinates). Any other status
 * means "try the next key".
 */
export function judgeLocationResponse(status, data) {
  const code = Number(status);
  if (code === 200 || code === 204) {
    const parsed = gpsFromLocationBody(data);
    if (parsed.kind === "live") {
      return { done: true, gps: "live", location: parsed.location, status: code };
    }
    if (parsed.kind === "miss") {
      return { done: false, gps: null, location: null, status: code };
    }
    return { done: true, gps: "no_gps", location: null, status: code };
  }
  return { done: false, gps: null, location: null, status: Number.isFinite(code) ? code : null };
}

export function pickBulkLocationItem(payload, vehicleNumber) {
  const rows = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.Items)
      ? payload.Items
      : payload && Array.isArray(payload.items)
        ? payload.items
        : null;
  if (!rows || !rows.length) return null;
  const want = String(vehicleNumber);
  const hit = rows.find((row) => String((row && (row.VehicleNumber || row.vehicleNumber)) || "") === want);
  if (hit) return hit;
  return rows.length === 1 ? rows[0] : null;
}

export function unwrapBulkLocationItem(item) {
  if (!item || typeof item !== "object") return { status: null, data: null };
  const status = item.StatusCode != null ? item.StatusCode : item.statusCode != null ? item.statusCode : null;
  const resource = item.ContentResource || item.contentResource;
  let data = null;
  if (resource && typeof resource === "object") {
    data = resource.Value || resource.value || resource;
  }
  if ((!data || data.Latitude == null) && item.Latitude != null) data = item;
  return { status, data };
}

export function summarizeAssets(vehicles) {
  const counts = {
    truck: 0,
    trailer: 0,
    pending: 0,
    truckWithGps: 0,
    trailerWithGps: 0,
    trailerNoGps: 0
  };
  const list = Array.isArray(vehicles) ? vehicles : [];
  for (const v of list) {
    const cls = classifyFleetAsset(v);
    if (counts[cls] != null) counts[cls] += 1;
    const live = !!(v && v._location && v._location.Latitude != null && v._location.Longitude != null)
      || (v && v._gps === "live");
    if (cls === ASSET_TRUCK && live) counts.truckWithGps += 1;
    if (cls === ASSET_TRAILER && live) counts.trailerWithGps += 1;
    if (cls === ASSET_TRAILER && !live) counts.trailerNoGps += 1;
  }
  return counts;
}
