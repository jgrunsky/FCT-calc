import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFleetAsset,
  countsTowardTruckMiles,
  locationCandidates,
  pathLocationCandidates,
  slashLocationCandidates,
  judgeLocationResponse,
  pickBulkLocationItem,
  unwrapBulkLocationItem,
  summarizeAssets
} from "./asset-gps.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const truck3 = { Name: "3", VehicleNumber: "3", VehicleId: 4588447, Make: "mack ", RegistrationNumber: "9F12816", Year: 2014 };
const truck448 = { Name: "448", VehicleNumber: "212448", VehicleId: 4588440, Make: "INTERNATIONAL", RegistrationNumber: "9G13780", Year: 2021 };
const van105 = { Name: "Van 105", VehicleNumber: "105", VehicleId: 6684401, Make: null, RegistrationNumber: "NotAvailable 688425" };
const flat37 = { Name: "Flat 37", VehicleNumber: "37/38", VehicleId: 6684388, Make: null, RegistrationNumber: "NotAvailable 689993" };
const pair = { Name: "88/89", VehicleNumber: null, VehicleId: 6684386, Make: null, RegistrationNumber: "NotAvailable 690002", Year: 0 };
const trl102 = { Name: "102", VehicleNumber: "102", VehicleId: 6684413, Make: null, RegistrationNumber: "NotAvailable 688473", Year: 0 };
const serial = { Name: "2400251635_20260821T21:51:58", VehicleNumber: null, VehicleId: 6684355, RegistrationNumber: null, Make: null };
const concatPair = { Name: "4344", VehicleNumber: "43/44", VehicleId: 6684424, RegistrationNumber: "NotAvailable 688487", Make: null };

assert.equal(classifyFleetAsset(truck3), "truck");
assert.equal(classifyFleetAsset(truck448), "truck");
assert.equal(classifyFleetAsset(van105), "trailer");
assert.equal(classifyFleetAsset(flat37), "trailer");
assert.equal(classifyFleetAsset(pair), "trailer");
assert.equal(classifyFleetAsset(trl102), "trailer");
assert.equal(classifyFleetAsset(concatPair), "trailer");
assert.equal(classifyFleetAsset(serial), "pending");
assert.equal(classifyFleetAsset({ ...van105, _assetClass: "truck" }), "truck");
assert.equal(countsTowardTruckMiles(truck3), true);
assert.equal(countsTowardTruckMiles(van105), false);
assert.equal(countsTowardTruckMiles(serial), false);
assert.equal(countsTowardTruckMiles(trl102), false);

assert.deepEqual(locationCandidates(truck3), ["3", "4588447"]);
assert.deepEqual(pathLocationCandidates(truck3), ["3", "4588447"]);
assert.deepEqual(locationCandidates(van105), ["105", "Van 105", "6684401"]);
assert.deepEqual(pathLocationCandidates(flat37), ["Flat 37", "6684388"]);
assert.deepEqual(slashLocationCandidates(flat37), ["37/38"]);
assert.deepEqual(slashLocationCandidates(pair), ["88/89"]);
assert.equal(pathLocationCandidates(pair).includes("88/89"), false);

const live = { Latitude: 37.87, Longitude: -121.27, Speed: 0 };
assert.deepEqual(judgeLocationResponse(200, live).gps, "live");
assert.equal(judgeLocationResponse(200, live).done, true);
assert.equal(judgeLocationResponse(200, { Message: "Unable to locate vehicle 105" }).done, false);
assert.equal(judgeLocationResponse(404, { Message: "Unable to locate vehicle Van 105" }).done, false);
assert.equal(judgeLocationResponse(200, {}).gps, "no_gps");
assert.equal(judgeLocationResponse(200, {}).location, null);

const bulk = [{
  VehicleNumber: "37/38",
  StatusCode: 200,
  ContentResource: { Value: live }
}];
const item = pickBulkLocationItem(bulk, "37/38");
const unwrapped = unwrapBulkLocationItem(item);
assert.equal(unwrapped.status, 200);
assert.equal(judgeLocationResponse(unwrapped.status, unwrapped.data).gps, "live");
assert.equal(pickBulkLocationItem([{ StatusCode: 404, Message: "nope" }], "37/38").StatusCode, 404);

const summary = summarizeAssets([
  { ...truck3, _assetClass: "truck", _location: live },
  { ...van105, _assetClass: "trailer", _location: null, _gps: "no_gps" },
  { ...trl102, _assetClass: "trailer", _location: live },
  { ...serial, _assetClass: "pending" }
]);
assert.deepEqual(summary, {
  truck: 1,
  trailer: 2,
  pending: 1,
  truckWithGps: 1,
  trailerWithGps: 1,
  trailerNoGps: 1
});

const htmlPath = path.resolve(__dirname, "../../../index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const marked = html.match(/\/\* FLEET_ASSET_CLASSIFY_START \*\/([\s\S]*?)\/\* FLEET_ASSET_CLASSIFY_END \*\//);
assert.ok(marked, "index.html is missing the fleet asset classifier block");
const pageApi = new Function(marked[1] + "\nreturn classifyFleetAsset;")();
for (const sample of [truck3, truck448, van105, flat37, pair, trl102, serial, concatPair]) {
  assert.equal(pageApi(sample), classifyFleetAsset(sample), "page classifier drifted for " + (sample.Name || "?"));
}
assert.match(html, /no GPS yet/);
assert.match(html, /fct-trl-pin/);

console.log("asset-gps tests ok");
