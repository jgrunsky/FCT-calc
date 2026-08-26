import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('/* BEGIN COMPLETED_REVENUE */');
const end = html.indexOf('/* END COMPLETED_REVENUE */');
assert.ok(start >= 0 && end > start, 'COMPLETED_REVENUE markers missing from index.html');

const prelude = `
function isoLocal(d){
  const p2 = n => (n<10?'0':'')+n;
  return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate());
}
`;

const sandbox = { console };
createContext(sandbox);
runInContext(prelude + html.slice(start, end + '/* END COMPLETED_REVENUE */'.length), sandbox);

const {
  dayRowActive, dispatchStatusKind, dayRowBooksRevenue,
  rowHasDriverName, rowHasFreightBill
} = sandbox;
assert.equal(typeof dayRowBooksRevenue, 'function');
assert.equal(typeof rowHasDriverName, 'function');
assert.equal(typeof rowHasFreightBill, 'function');

const TODAY = '2026-08-26';
const YDAY = '2026-08-25';

function row(extra){
  return Object.assign({
    date:TODAY, lbs:54000, miles:30, hours:5,
    status:'', driver:'', driverRaw:'', fb:'', h:''
  }, extra);
}

assert.equal(dayRowActive(row({ status:'DISPATCHED', driver:'GREG', fb:'200334' })), true);
assert.equal(dayRowActive(row({ status:'', driver:'' })), true);
assert.equal(dayRowActive(row({ status:'PUSH', driver:'GREG', fb:'200334' })), false);

assert.equal(rowHasDriverName(row({ driver:'MUNOZ' })), true);
assert.equal(rowHasDriverName(row({ driver:'—' })), false);
assert.equal(rowHasDriverName(row({ driver:'-' })), false);
assert.equal(rowHasFreightBill(row({ fb:'200334' })), true);
assert.equal(rowHasFreightBill(row({ fb:'-' })), false);
assert.equal(rowHasFreightBill(row({ fb:'' })), false);

/* James: driver AND FB required. FCGE projection rows (no driver, no FB) never book. */
assert.equal(dayRowBooksRevenue(row({
  origin:'FCGE', truck:'ARDENT', status:'', driver:'', fb:'', po:'183-18'
}), TODAY), false, 'FCGE Ardent projection (no driver, no FB) does not book');
assert.equal(dayRowBooksRevenue(row({
  date:YDAY, status:'55/56', driver:'MUNOZ', fb:''
}), TODAY), false, 'driver without FB does not book');
assert.equal(dayRowBooksRevenue(row({
  date:YDAY, status:'55/56', driver:'', fb:'200334'
}), TODAY), false, 'FB without driver does not book');
assert.equal(dayRowBooksRevenue(row({
  status:'DELIVERED', driver:'GREG', fb:''
}), TODAY), false, 'DELIVERED without FB does not book');

assert.equal(dayRowBooksRevenue(row({
  status:'DELIVERED', driver:'GREG', fb:'192564'
}), TODAY), true, 'DELIVERED with driver+FB books today');
assert.equal(dayRowBooksRevenue(row({
  date:YDAY, status:'55/56', driver:'MUNOZ', fb:'200334'
}), TODAY), true, 'yesterday POC with driver+FB+trailer-in-status books');
assert.equal(dayRowBooksRevenue(row({
  date:YDAY, status:'DISPATCHED', driver:'GREG', fb:'192564'
}), TODAY), true);
assert.equal(dayRowBooksRevenue(row({
  status:'DISPATCHED', driver:'GREG', fb:'192564'
}), TODAY), false, 'today DISPATCHED with driver+FB still does not book');

/* Money loops still filter on booked. */
const computeDayFn = html.slice(html.indexOf('function computeDay(){'), html.indexOf('function dayTotalsHTML('));
assert.ok(/rows\.filter\(r=>r\.booked\)/.test(computeDayFn), 'computeDay totals booked rows');
assert.ok(/activeLoads/.test(computeDayFn), 'computeDay keeps an active count');
assert.ok(/planLoads/.test(computeDayFn) && /planRevenue/.test(computeDayFn),
  'computeDay keeps a projection total for unbooked planned rows');
assert.ok(/act\.filter\(r=>!r\.booked\)/.test(computeDayFn),
  'projection is active rows that do not book');

const runFn = html.slice(html.indexOf('function runningTotals(refDate){'), html.indexOf('function verizonFuelDollarsForDate('));
assert.ok(/if\(!c\.booked\) return/.test(runFn), 'WTD/MTD runningTotals uses booked');

const accumFn = html.slice(html.indexOf('function accumulatePnlByDay(){'), html.indexOf('function pnlSumRange('));
assert.ok(/if\(!r\.booked\) return/.test(accumFn), 'P&L accumulate uses booked');
assert.ok(/verizonFuelDollarsForDate/.test(accumFn), 'Verizon fuel overwrite still on P&L accumulate');

/* ---- Ardent rate: dest from Truck, 52k × $0.00425 × 1.32 FSC ---- */
assert.ok(/function pocDestHint\(r\)/.test(html), 'pocDestHint exists');
assert.ok(/customerLabelFrom\(r\.truck\)/.test(html), 'dest hint reads Truck column');
assert.ok(/rec\.destLabel = cls\.destLabel/.test(html), 'parse copies destLabel');

const ratePrelude = `
function normOrigin(v){
  return String(v==null?'':v).toUpperCase().replace(/\\s+/g,' ').trim().replace(/[.'\`]/g,'');
}
function laneRateOverrideFor(){ return null; }
`;
const rateStart = html.indexOf('const POC_MIN_WEIGHT');
const rateEnd = html.indexOf('function laneOverrideKey(');
assert.ok(rateStart >= 0 && rateEnd > rateStart, 'POC rate block found');
const rateBox = { console };
createContext(rateBox);
runInContext(ratePrelude + html.slice(rateStart, rateEnd), rateBox);

const ardent = rateBox.pocLaneRevenue('FCGE', 'ARDENT', 48000, 'WHT');
assert.ok(ardent, 'FCGE→ARDENT lane matches');
const expected = 52000 * 0.00425 * 1.32;
assert.equal(Math.round(ardent.amount * 100) / 100, Math.round(expected * 100) / 100,
  'FCGE→Ardent is $291.72 (52k floor × $0.00425 × 32% FSC), not $241 or $425');
assert.equal(ardent.minWeightApplied, true, '48k default hits the 52k POC floor');

const ardentFcg = rateBox.pocLaneRevenue('FCG', 'ARDENT', 54000, 'WHT');
assert.ok(ardentFcg);
assert.equal(Math.round(ardentFcg.amount * 100) / 100, Math.round(54000 * 0.00425 * 1.32 * 100) / 100,
  'FCG→Ardent at 54k bills actual weight × $0.00425 × 32% FSC');

assert.equal(rateBox.pocLaneRevenue('FCGE', "Phil O'Connell Grain", 48000, 'WHT'), null,
  'customer label is not a dest — that miss was the $425 fallback');

/* $241 is 43,000 lb × $0.00425 × 1.32 with NO 52k floor. That is not how
   POC bills and is not stored. Default sheet lbs is 48k, which still floors. */
const noFloor = 43000 * 0.00425 * 1.32;
assert.equal(Math.round(noFloor * 100) / 100, 241.23);
const light = rateBox.pocLaneRevenue('FCGE', 'ARDENT', 43000, 'WHT');
assert.equal(Math.round(light.amount * 100) / 100, Math.round(expected * 100) / 100,
  '43k still bills the 52k floor ($291.72), not $241');

assert.ok(/'ARDENT':\s*\{\s*ratePerLb:\s*0\.00425,\s*fscPct:\s*32/.test(html),
  'stored Ardent short-haul rate is still $0.00425/lb + 32% FSC');
assert.ok(/avgRevenue:\s*425/.test(html), 'POC blended fallback stays $425 when no lane matches');
assert.ok(!/\b241\b/.test(html.slice(html.indexOf('const POC_LANE_RATES'), html.indexOf('function pocLaneRateFor'))),
  'POC_LANE_RATES does not store $241');

assert.ok(/currentDieselPricePerGal:\s*4\.50/.test(html), 'diesel unchanged');
assert.ok(/fleetAvgMPG:\s*6\.0/.test(html), 'MPG unchanged');
assert.ok(/estDriverWageBlend:\s*1\.21/.test(html), 'ADP blend default unchanged');
assert.ok(/sheetPlanRow/.test(html) && /not in TOTAL/.test(html),
  'sheet footer has a PLAN row that is not in books');
assert.ok(/2026-08-26-fct-calc-v2\.1\.44-plan-line/.test(html), 'APP_VERSION is v2.1.44');
assert.ok(/v2\.1\.44-plan-line/.test(html), 'changelog has v2.1.44');

console.log('completed-revenue.test.mjs: ok');
