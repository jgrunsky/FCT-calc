import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const changelogStart = html.indexOf('const SHADOW_CHANGELOG');
assert.ok(changelogStart >= 0, 'SHADOW_CHANGELOG present');
const ui = html.slice(0, changelogStart);

assert.ok(/2026-09-05-fct-calc-v2\.1\.48-pnl-today/.test(html), 'APP_VERSION is v2.1.48');
assert.ok(/v2\.1\.47-no-fuel-bar/.test(html), 'changelog has v2.1.47');
assert.ok(/v2\.1\.46-device-diesel/.test(html), 'prior diesel changelog kept');
assert.ok(/v2\.1\.45-driver-fb/.test(html), 'driver+bill changelog kept');

/* Books gate is still driver + freight bill — do not revert PR #13. */
const books = html.slice(html.indexOf('function dayRowBooksRevenue'), html.indexOf('/* END COMPLETED_REVENUE */'));
assert.ok(/rowHasDriverName/.test(books) && /rowHasFreightBill/.test(books), 'books still require driver AND FB');
assert.ok(!/kind==='preload'/.test(books), 'PRELOADED with driver+FB still books');
assert.ok(!/rowDate < asOf/.test(books), 'calendar-close gate stays gone');

/* Shipped default may still be $4.50 — it must not nag or overwrite the device. */
assert.ok(/currentDieselPricePerGal:\s*4\.50/.test(html), 'source default can stay $4.50');

/* v2.1.47: Device-out-of-sync red bar is gone for good. Changelog history may
   still mention the old bar. */
assert.ok(!/Device out of sync/.test(ui), 'no Device-out-of-sync UI outside changelog');
assert.ok(!/__driftBanner/.test(ui), 'no __driftBanner');
assert.ok(!/__showDriftBanner/.test(ui), 'no __showDriftBanner');
assert.ok(!/__checkDeviceDrift/.test(ui), 'no __checkDeviceDrift');
assert.ok(!/Tap to pull latest/.test(html), 'no tap-to-pull overlay');
assert.ok(!/Pulled canonical settings/.test(html), 'no tap-to-pull toast');
assert.ok(!/currentDieselPricePerGal = Number\(d\.canonical\)/.test(html),
  'never assigns canonical diesel onto the device');

/* Canonical-settings is POST-only from Settings. No GET overwrite of diesel. */
const pushFn = html.slice(html.indexOf('function pushCanonicalSettings'), html.indexOf('async function pushDispatchLog'));
assert.ok(/method: 'POST'/.test(pushFn), 'Settings still POSTs canonical settings');
assert.ok(!/method:\s*'GET'/.test(pushFn), 'push is not a GET');
assert.ok(!/currentDieselPricePerGal\s*=/.test(pushFn), 'POST path does not write local diesel from canonical');
assert.equal((html.match(/VERIZON_CANONICAL_SETTINGS_URL/g) || []).length, 2,
  'canonical URL is declared once and fetched once (POST)');

/* Diesel-default nags deleted. */
assert.ok(!/Diesel price never confirmed/.test(html), 'no never-confirmed nag');
assert.ok(!/Diesel price is a default/.test(html), 'no default-diesel nag');
assert.ok(!/shipped default of/.test(html), 'no shipped-default $4.50 lecture');
assert.ok(!/canonical \$4\.50 cannot overwrite/.test(html), 'no Settings $4.50 lecture');
assert.ok(!/⚑ shipped default/.test(html), 'no ⚑ shipped default chip');
assert.ok(!/\?'DEFAULT'/.test(html), 'fuelStaleTag never paints DEFAULT');
assert.ok(!/fuelPriceUnconfirmed\(\)\?'DEFAULT'/.test(html), 'unconfirmed does not drive DEFAULT chip');
assert.ok(!/if\(fuelPriceUnconfirmed\(\)\) return true/.test(html),
  'fuelPriceStale does not treat unconfirmed as stale');
assert.ok(/id="dieselCard"/.test(html) && /Diesel price \$\/gallon/.test(html),
  'Settings still has a plain diesel price field');

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
markBootSettle('rows');
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
