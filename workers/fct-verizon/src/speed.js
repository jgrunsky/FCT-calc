// Verizon Reveal RAD Speed is kilometers per hour (GET location and GET status).
// 0.621371 matches milesFromSegmentsResponse / OdometerInKM on this worker.
// Raw Speed stays kph. SpeedMph is miles per hour — do not convert it again.
export const KPH_TO_MPH = 0.621371;
// Worker cron is every 10 minutes. A fix older than 15 is not current speed.
// The Oct 30 2026 Fleet screenshot fixes were 4 minutes old and still current.
export const SPEED_FRESH_MINUTES = 15;
export const MOVING_MPH = 1;

export function kphToMph(kph) {
  if (kph == null || kph === "") return null;
  const n = Number(kph);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * KPH_TO_MPH;
}

export function gpsAgeMinutes(loc, nowMs) {
  const raw = loc && loc.UpdateUTC;
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const ms = Date.parse(hasZone ? s : s + "Z");
  if (!Number.isFinite(ms)) return null;
  const now = nowMs == null || nowMs === "" ? Date.now() : Number(nowMs);
  const age = Math.floor((now - ms) / 60000);
  if (!Number.isFinite(age)) return null;
  if (age < 0) return 0;
  return age;
}

function normalizeDisplayState(loc) {
  const raw = loc && loc.DisplayState != null ? String(loc.DisplayState).trim().toLowerCase() : "";
  if (raw === "1" || raw === "moving") return "moving";
  if (raw === "2" || raw === "stop" || raw === "stopped" || raw === "park" || raw === "parked") return "stop";
  if (raw === "3" || raw === "towing") return "towing";
  if (raw === "0" || raw === "coverage") return "coverage";
  if (raw === "5" || raw === "panic") return "panic";
  if (raw === "6" || raw === "privacy") return "privacy";
  if (raw === "idle" || raw === "idling") return "idle";
  return raw;
}

export function ignitionIsOff(loc) {
  if (!loc || typeof loc !== "object") return false;
  if (loc.IgnitionOn === false || loc.IgnitionOn === 0 || loc.IgnitionOn === "0" || loc.IgnitionOn === "false") return true;
  if (loc.EngineOn === false || loc.EngineOn === 0 || loc.EngineOn === "0" || loc.EngineOn === "false") return true;
  if (loc.KeyOn === false || loc.KeyOn === 0 || loc.KeyOn === "0" || loc.KeyOn === "false") return true;
  for (const key of ["Ignition", "IgnitionStatus", "EngineStatus"]) {
    if (loc[key] == null || loc[key] === "") continue;
    const s = String(loc[key]).trim().toLowerCase();
    if (s === "off" || s === "false" || s === "0" || s === "ignition off" || s === "engine off") return true;
  }
  return false;
}

export function speedMphFromLocation(loc) {
  if (!loc || typeof loc !== "object") return null;
  if (loc.SpeedMph != null && loc.SpeedMph !== "") {
    const stamped = Number(loc.SpeedMph);
    if (Number.isFinite(stamped) && stamped >= 0) return stamped;
  }
  const kph = loc.SpeedKph != null && loc.SpeedKph !== "" ? loc.SpeedKph : loc.Speed;
  return kphToMph(kph);
}

export function annotateLocationSpeed(loc) {
  if (!loc || typeof loc !== "object" || Array.isArray(loc)) return loc;
  const kph = loc.SpeedKph != null && loc.SpeedKph !== "" ? loc.SpeedKph : loc.Speed;
  const mph = kphToMph(kph);
  if (mph == null) return loc;
  return { ...loc, SpeedKph: Number(kph), SpeedMph: mph };
}

export function fleetMotion(loc, nowMs) {
  const ageMin = gpsAgeMinutes(loc, nowMs);
  const mph = speedMphFromLocation(loc);
  const state = normalizeDisplayState(loc);
  const heading = loc && loc.Heading != null ? String(loc.Heading).trim() : "";
  const fresh = ageMin != null && ageMin <= SPEED_FRESH_MINUTES;
  const base = { ageMin, heading: "", mph: null, isMoving: false };

  if (!fresh || state === "coverage") {
    return { ...base, kind: "stale" };
  }
  if (ignitionIsOff(loc)) {
    return { ...base, kind: "ignition-off" };
  }
  if (state === "stop" || state === "privacy") {
    return { ...base, kind: "parked" };
  }
  if (state === "idle") {
    return { ...base, kind: "idle" };
  }
  if (state === "panic") {
    return { ...base, kind: "stopped" };
  }
  const driving = state === "moving" || state === "towing" || state === "";
  if (driving && mph != null && mph >= MOVING_MPH) {
    return { kind: "moving", isMoving: true, mph, heading, ageMin };
  }
  return { ...base, kind: "stopped" };
}

export function fleetSpeedText(loc, nowMs) {
  const m = fleetMotion(loc, nowMs);
  if (m.kind === "moving") {
    const rounded = Math.round(m.mph);
    return m.heading ? rounded + " mph " + m.heading : rounded + " mph";
  }
  if (m.kind === "idle") return "idling";
  if (m.kind === "parked") return "parked";
  if (m.kind === "ignition-off") return "ignition off";
  if (m.kind === "stale") return "stale GPS";
  return "stopped";
}
