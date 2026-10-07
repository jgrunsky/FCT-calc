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

assert.ok(/2026-10-07-fct-calc-v2\.1\.55-calibration-retry/.test(html), 'APP_VERSION is v2.1.55');
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
  keepLastGoodCalibration, estPaintPending, estPaintUseFrozen, estChipView, markBootSettle,
  interpretCalibrationPayload, calibrationFailureState, laneCalibrationBootSlot,
  calibrationWriteAllowed, calibrationTileView
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
assert.ok(/out\.laneCalibration = laneCalibrationBootSlot\(/.test(html), 'calibration is not persisted');
assert.ok(/state\.laneCalibration = laneCalibrationBootSlot\(/.test(html), 'loadState drops saved calibration');
assert.ok(/never restore a saved calibration/.test(html), 'loadState drops saved calibration');

/* Live server shape from 2026-10-06: fleetFactor 0.872, lanes {}, 7 days,
   16116 actual / 18483 predicted. That must clear a stuck ok:false error
   and paint ↓0.87× — not "unavailable". */
const stuck = { ok:false, lanes:{}, fleetFactor:1.0, windowDays:0, computedAt:null, error:'Load failed' };
const liveBody = {
  lanes: {},
  fleetFactor: 0.872,
  windowDays: 7,
  cached: true,
  computedAt: '2026-10-07T03:00:00.000Z',
  coverage: { daysUsed: 7, fleetActualMi: 16116, fleetPredictedMi: 18483 }
};
const recovered = interpretCalibrationPayload(liveBody, stuck);
assert.equal(recovered.retry, false);
assert.equal(recovered.state.ok, true);
assert.equal(recovered.state.error, null);
assert.equal(recovered.state.fleetFactor, 0.872);
assert.equal(recovered.state.coverage.daysUsed, 7);
const tile = calibrationTileView(recovered.state);
assert.equal(tile.big, '↓0.87×');
assert.equal(tile.sub, '7-day window');

/* An error field must not veto a real factor. */
const withErr = interpretCalibrationPayload(
  { lanes:{}, fleetFactor:0.872, windowDays:7, error:'stale note' },
  stuck
);
assert.equal(withErr.state.ok, true);
assert.equal(withErr.state.error, null);
assert.equal(withErr.state.fleetFactor, 0.872);

/* v2.1.46: transient empty must not drop last-good, and EST stays put
   because the factor the day math reads does not change. */
const lastGood = { ok:true, fleetFactor:1.15, lanes:{ 'PNG→LATHROP': { factor:1.2 } }, windowDays:7, error:null };
const empty = interpretCalibrationPayload({ lanes:{}, fleetFactor:1 }, lastGood);
assert.equal(empty.retry, true, 'empty response retries');
assert.equal(empty.state.ok, true);
assert.equal(empty.state.fleetFactor, 1.15);
assert.equal(empty.state.stale, true);
assert.ok(empty.state.lanes['PNG→LATHROP']);
assert.equal(calibrationTileView(empty.state).big, '↑1.15×');

/* Empty with no last-good stays failed and retries — it does not adopt 1.0 as live. */
const stillStuck = interpretCalibrationPayload({ lanes:{}, fleetFactor:1 }, stuck);
assert.equal(stillStuck.retry, true);
assert.equal(stillStuck.state.ok, false);
assert.equal(stillStuck.state.error, 'empty');
assert.equal(calibrationTileView(stillStuck.state).big, '—');
assert.equal(calibrationTileView(stillStuck.state).sub, 'unavailable');

/* Failure reads whatever is in state NOW. A slow abort must not wipe a
   factor that landed while the request was in flight. A stale seq must
   not write that failure at all. */
const afterLive = calibrationFailureState(recovered.state, 'The operation was aborted.');
assert.equal(afterLive.state.ok, true);
assert.equal(afterLive.state.fleetFactor, 0.872);
assert.equal(afterLive.retry, true);
assert.equal(calibrationWriteAllowed(1, 2), false);
assert.equal(calibrationWriteAllowed(2, 2), true);
const freshFail = calibrationFailureState(stuck, 'Load failed');
assert.equal(freshFail.state.ok, false);
assert.equal(freshFail.state.error, 'Load failed');
assert.equal(calibrationTileView(freshFail.state).sub, 'unavailable');

/* Boot never restores a persisted error or a persisted good factor. */
const bootedErr = laneCalibrationBootSlot({ ok:false, fleetFactor:0.5, error:'Load failed', lanes:{ a:1 } });
assert.equal(bootedErr.ok, false);
assert.equal(bootedErr.error, null);
assert.equal(bootedErr.fleetFactor, 1.0);
assert.equal(JSON.stringify(bootedErr.lanes), '{}');
const bootedGood = laneCalibrationBootSlot({ ok:true, fleetFactor:1.15, error:null, lanes:{ a:{ factor:1.2 } } });
assert.equal(bootedGood.ok, false);
assert.equal(bootedGood.fleetFactor, 1.0);
assert.equal(bootedGood.error, null);
assert.equal(calibrationTileView(bootedErr).sub, 'awaiting data');

assert.ok(/CAL_RETRY_BACKOFF_MS = \[4000, 12000, 30000, 60000\]/.test(html), 'failed/empty fetch backs off');
assert.ok(/refreshLaneCalibration\(\{reason:'refresh'\}\)/.test(html), 'Refresh button refetches calibration');
assert.ok(/CAL_SYNC_REFETCH/.test(html) && /refreshLaneCalibration\(\{reason:'sync'\}\)/.test(html),
  'successful nothing-newer sync refetches calibration');
assert.ok(/visibilitychange/.test(html) && /scheduleCalibrationForeground\('visible'\)/.test(html),
  'resume refetches calibration');
assert.ok(/pageshow/.test(html), 'bfcache pageshow refetches calibration');
assert.ok(/addEventListener\('online'/.test(html), 'coming back online refetches calibration');
assert.ok(/v2\.1\.55-calibration-retry/.test(html), 'changelog has v2.1.55');

assert.ok(/Driver plus bill is the way/.test(html), 'books copy unchanged');
assert.ok(/Twilio \/ SMS \/ PR #11 not touched/.test(html), 'changelog leaves Twilio alone');

console.log('device-diesel-est.test.mjs: ok');
