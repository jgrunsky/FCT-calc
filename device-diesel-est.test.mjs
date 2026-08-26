import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');

assert.ok(/2026-08-26-fct-calc-v2\.1\.46-device-diesel/.test(html), 'APP_VERSION is v2.1.46');
assert.ok(/v2\.1\.46-device-diesel/.test(html), 'changelog has v2.1.46');
assert.ok(/v2\.1\.45-driver-fb/.test(html), 'driver+bill changelog kept');

/* Books gate is still driver + freight bill — do not revert PR #13. */
const books = html.slice(html.indexOf('function dayRowBooksRevenue'), html.indexOf('/* END COMPLETED_REVENUE */'));
assert.ok(/rowHasDriverName/.test(books) && /rowHasFreightBill/.test(books), 'books still require driver AND FB');
assert.ok(!/kind==='preload'/.test(books), 'PRELOADED with driver+FB still books');
assert.ok(!/rowDate < asOf/.test(books), 'calendar-close gate stays gone');

/* Shipped default may still be $4.50 — it must not nag or overwrite the device. */
assert.ok(/currentDieselPricePerGal:\s*4\.50/.test(html), 'source default can stay $4.50');
assert.ok(/This device only — canonical \$4\.50 cannot overwrite it/.test(html),
  'Settings diesel copy says this device owns the price');

/* Drift banner never compares fuelPrice. */
const drift = html.slice(html.indexOf('async function __checkDeviceDrift'), html.indexOf('function __showDriftBanner'));
assert.ok(!/\['fuelPricePerGal'/.test(drift), 'drift fields omit fuelPricePerGal');
assert.ok(/\['fleetAvgMPG'/.test(drift) && /\['defaultDriverRate'/.test(drift),
  'MPG and driver rate can still drift-check');
assert.ok(!/s\.currentDieselPricePerGal/.test(drift), 'drift compare does not read local diesel');

const apply = html.slice(html.indexOf('diffs.forEach(d=>{'), html.indexOf("toast('Pulled canonical settings"));
assert.ok(/d\.settingsKey === 'fuelPricePerGal'/.test(apply)
  && /return;/.test(apply.slice(apply.indexOf("d.settingsKey === 'fuelPricePerGal'"),
    apply.indexOf("d.settingsKey === 'fuelPricePerGal'") + 120)),
  'tap-to-pull returns without writing diesel');
assert.ok(!/currentDieselPricePerGal = Number\(d\.canonical\)/.test(html),
  'tap-to-pull never assigns canonical diesel onto the device');

assert.ok(/Device out of sync/.test(html), 'non-fuel drift banner still exists for MPG/rate');
assert.ok(!/fuelPrice differs/.test(drift), 'drift function does not format fuelPrice differs');

/* Calibration sticky + EST hold helpers. */
const start = html.indexOf('/* BEGIN DEVICE_DIESEL_EST */');
const end = html.indexOf('/* END DEVICE_DIESEL_EST */');
assert.ok(start >= 0 && end > start, 'DEVICE_DIESEL_EST markers present');

const sandbox = { console };
createContext(sandbox);
runInContext(html.slice(start, end + '/* END DEVICE_DIESEL_EST */'.length), sandbox);

const {
  keepLastGoodCalibration, estPaintPending, estPaintUseFrozen, estChipView, markBootSettle
} = sandbox;
assert.equal(typeof keepLastGoodCalibration, 'function');

assert.equal(keepLastGoodCalibration(null), null);
assert.equal(keepLastGoodCalibration({ ok:false, fleetFactor:1.15 }), null);
const kept = keepLastGoodCalibration({ ok:true, fleetFactor:1.15, lanes:{ 'PNG→LATHROP': { factor:1.2 } } });
assert.equal(kept.ok, true);
assert.equal(kept.fleetFactor, 1.15);
assert.ok(kept.lanes['PNG→LATHROP']);

assert.equal(estPaintPending(), true, 'first paint holds EST chips');
assert.equal(estChipView({ cm: 9967 }).pending, true, 'do not invent EST dollars before settle');

markBootSettle('cal');
markBootSettle('miles');
markBootSettle('adp');
assert.equal(estPaintPending(), false);
const painted = estChipView({ cm: 9967, dayNet: 4094 });
assert.equal(painted.pending, false);
assert.equal(painted.cm, 9967);
assert.equal(painted.dayNet, 4094);

sandbox.__calInFlight = true;
assert.equal(estPaintUseFrozen(), true);
const frozen = estChipView({ cm: 11000, dayNet: 5088 });
assert.equal(frozen.cm, 9967, 'in-flight refresh keeps last stable EST');
assert.equal(frozen.dayNet, 4094);
sandbox.__calInFlight = false;

assert.ok(/keepLastGoodCalibration/.test(html), 'calibration refetch uses last-good');
assert.ok(/Do NOT GET in the/.test(html) && /setTimeout\(res, 2500\)/.test(html),
  'POST /dispatch-log delays calibration refetch');
assert.ok(/out\.laneCalibration = \{ ok:false/.test(html), 'calibration is not persisted');
assert.ok(/never restore a saved calibration/.test(html), 'loadState drops saved calibration');

assert.ok(/Driver plus bill is the way/.test(html), 'books copy unchanged');
assert.ok(/Twilio \/ SMS \/ PR #11 not touched/.test(html), 'changelog leaves Twilio alone');

console.log('device-diesel-est.test.mjs: ok');
