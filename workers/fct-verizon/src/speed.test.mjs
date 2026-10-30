import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import {
  KPH_TO_MPH,
  SPEED_FRESH_MINUTES,
  annotateLocationSpeed,
  fleetMotion,
  fleetSpeedText,
  kphToMph,
  speedMphFromLocation
} from "./speed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

// Oct 30 2026 ~6:53 AM PT Fleet screenshot. Verizon Speed on the location
// record is kph. These four trucks all showed "GPS 4 min ago".
const NOW = Date.parse("2026-10-30T13:53:00Z");
const FRESH = "2026-10-30T13:49:00";
const STALE = "2026-10-30T13:30:00";

function plot(speed, extra) {
  return {
    Speed: speed,
    Heading: "South",
    DisplayState: "Moving",
    UpdateUTC: FRESH,
    Address: { AddressLine1: "2381 Los Banos Hwy, Merced, CA 95341, USA" },
    ...extra
  };
}

assert.equal(KPH_TO_MPH, 0.621371);
assert.equal(SPEED_FRESH_MINUTES, 15);

// Screenshot trucks: 91 / 77 / 69 / 14 kph labeled as mph.
assert.equal(Math.round(kphToMph(91)), 57);
assert.equal(Math.round(kphToMph(77)), 48);
assert.equal(Math.round(kphToMph(69)), 43);
assert.equal(Math.round(kphToMph(14)), 9);
assert.equal(kphToMph(0), 0);
assert.equal(kphToMph(null), null);
assert.equal(kphToMph(""), null);
assert.equal(kphToMph(-5), null);
assert.ok(Math.abs(kphToMph(91) - 91 * 0.621371) < 1e-9);

const truck20 = plot(91);
assert.equal(fleetSpeedText(truck20, NOW), "57 mph South");
assert.equal(fleetMotion(truck20, NOW).kind, "moving");
assert.equal(fleetMotion(truck20, NOW).isMoving, true);
assert.equal(fleetMotion(truck20, NOW).ageMin, 4);

assert.equal(fleetSpeedText(plot(77, { Heading: "North West" }), NOW), "48 mph North West");
assert.equal(fleetSpeedText(plot(69, {
  Heading: "West",
  Address: { AddressLine1: "2424 W Mathews Rd, French Camp, CA 95231, USA" }
}), NOW), "43 mph West");
assert.equal(fleetSpeedText(plot(14, { Heading: "North" }), NOW), "9 mph North");

const stamped = annotateLocationSpeed(truck20);
assert.equal(stamped.Speed, 91, "raw Verizon Speed stays kph");
assert.equal(stamped.SpeedKph, 91);
assert.ok(Math.abs(stamped.SpeedMph - 91 * 0.621371) < 1e-9);
assert.equal(fleetSpeedText(stamped, NOW), "57 mph South");
assert.ok(Math.abs(speedMphFromLocation(stamped) - stamped.SpeedMph) < 1e-12);
assert.notEqual(Math.round(speedMphFromLocation(stamped)), Math.round(91 * 0.621371 * 0.621371));

const twice = annotateLocationSpeed(stamped);
assert.equal(twice.SpeedKph, 91);
assert.ok(Math.abs(twice.SpeedMph - stamped.SpeedMph) < 1e-12);

assert.equal(fleetSpeedText(plot(91, { UpdateUTC: STALE }), NOW), "stale GPS");
assert.equal(fleetMotion(plot(91, { UpdateUTC: STALE }), NOW).isMoving, false);
assert.equal(fleetSpeedText(plot(91, { UpdateUTC: null }), NOW), "stale GPS");

assert.equal(fleetSpeedText(plot(91, { DisplayState: "Stop" }), NOW), "parked");
assert.equal(fleetSpeedText(plot(91, { DisplayState: "Idle" }), NOW), "idling");
assert.equal(fleetSpeedText(plot(91, { IgnitionOn: false }), NOW), "ignition off");
assert.equal(fleetSpeedText(plot(91, { EngineStatus: "Off" }), NOW), "ignition off");
assert.equal(fleetSpeedText(plot(0, { DisplayState: "Moving" }), NOW), "stopped");
assert.equal(fleetSpeedText(plot(91, { DisplayState: "Stop", IgnitionOn: false }), NOW), "ignition off");

const recent = new Date(Date.now() - 4 * 60 * 1000).toISOString().slice(0, 19);
assert.equal(fleetMotion(plot(91, { UpdateUTC: recent })).isMoving, true);
assert.equal(fleetSpeedText(plot(91, { UpdateUTC: recent })), "57 mph South");

const worker = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
assert.match(worker, /annotateLocationSpeed\(resolved\.location\)/);
assert.match(worker, /KPH_TO_MPH|annotateLocationSpeed/);

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const startMark = "/* FLEET_SPEED_START */";
const endMark = "/* FLEET_SPEED_END */";
const start = html.indexOf(startMark);
const end = html.indexOf(endMark);
assert.ok(start !== -1 && end > start, "fleet speed block is in index.html");
const htmlBlock = html.slice(start + startMark.length, end).trim();
const moduleBlock = fs.readFileSync(path.join(__dirname, "speed.js"), "utf8")
  .replace(/export /g, "")
  .trim();
assert.equal(htmlBlock, moduleBlock, "page copy of the conversion matches speed.js");
assert.equal((html.match(/Math\.round\(loc\.Speed\)/g) || []).length, 0);

const ui = {};
runInContext(
  htmlBlock + "\nglobalThis.__fleet = { kphToMph, speedMphFromLocation, fleetMotion, fleetSpeedText, annotateLocationSpeed };",
  createContext(ui)
);
assert.equal(ui.__fleet.fleetSpeedText(truck20, NOW), "57 mph South");
assert.equal(ui.__fleet.fleetSpeedText(plot(69, { Heading: "West" }), NOW), "43 mph West");
assert.equal(ui.__fleet.fleetSpeedText(plot(91, { DisplayState: "Stop" }), NOW), "parked");
assert.equal(Math.round(ui.__fleet.kphToMph(14)), 9);
