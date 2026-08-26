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
const ctx = createContext(sandbox);
runInContext(prelude + html.slice(start, end + '/* END COMPLETED_REVENUE */'.length), ctx);

const { dayRowActive, dispatchStatusKind, dayRowBooksRevenue } = sandbox;
assert.equal(typeof dayRowActive, 'function');
assert.equal(typeof dispatchStatusKind, 'function');
assert.equal(typeof dayRowBooksRevenue, 'function');

const TODAY = '2026-08-26';
const YDAY = '2026-08-25';

function row(extra){
  return Object.assign({ date:TODAY, lbs:54000, miles:30, hours:5, status:'', driver:'', driverRaw:'', h:'' }, extra);
}

/* Operational active still counts unfinished rows (board / Queue). */
assert.equal(dayRowActive(row({ status:'DISPATCHED', driver:'GREG' })), true);
assert.equal(dayRowActive(row({ status:'', driver:'' })), true);
assert.equal(dayRowActive(row({ status:'PUSH', driver:'GREG' })), false);
assert.equal(dayRowActive(row({ lbs:0, miles:0, hours:0 })), false);

assert.equal(dispatchStatusKind(row({ status:'DELIVERED', driver:'GREG' })), 'delivered');
assert.equal(dispatchStatusKind(row({ status:'dispatched 4 delivery', driver:'GREG' })), 'dispatched');
assert.equal(dispatchStatusKind(row({ status:'DISPATCHED', driver:'GREG' })), 'dispatched');
assert.equal(dispatchStatusKind(row({ status:'PRE', driver:'GREG' })), 'preload');
assert.equal(dispatchStatusKind(row({ status:'PRE LOADED' })), 'preload');
assert.equal(dispatchStatusKind(row({ status:'', driver:'' })), 'unassigned');
assert.equal(dispatchStatusKind(row({ status:'55/56', driver:'MUNOZ' })), 'assigned'); // POC grain
assert.equal(dispatchStatusKind(row({ status:'REJECTED' })), 'cancelled');
assert.equal(dispatchStatusKind(row({ status:'PUSH TO 8/13' })), 'push');

/* Today: only DELIVERED books. Assigned / DISPATCHED / unassigned / preload do not. */
assert.equal(dayRowBooksRevenue(row({ status:'DELIVERED', driver:'GREG' }), TODAY), true);
assert.equal(dayRowBooksRevenue(row({ status:'D', driver:'GREG' }), TODAY), true);
assert.equal(dayRowBooksRevenue(row({ status:'DISPATCHED', driver:'GREG' }), TODAY), false);
assert.equal(dayRowBooksRevenue(row({ status:'dispatched 4 delivery', driver:'GREG' }), TODAY), false);
assert.equal(dayRowBooksRevenue(row({ status:'PRE', driver:'GREG' }), TODAY), false);
assert.equal(dayRowBooksRevenue(row({ status:'', driver:'' }), TODAY), false);
assert.equal(dayRowBooksRevenue(row({ status:'55/56', driver:'MUNOZ' }), TODAY), false, 'POC in-progress today does not book');
assert.equal(dayRowBooksRevenue(row({ origin:'FCGE', status:'', driver:'', truck:'ARDENT' }), TODAY), false, 'today Ardent unassigned does not book');

/* Past day: assigned / DISPATCHED book (sheet rarely types DELIVERED, POC uses trailer-in-status). */
assert.equal(dayRowBooksRevenue(row({ date:YDAY, status:'DISPATCHED', driver:'GREG' }), TODAY), true);
assert.equal(dayRowBooksRevenue(row({ date:YDAY, status:'55/56', driver:'MUNOZ' }), TODAY), true, 'yesterday POC with trailer in Status books');
assert.equal(dayRowBooksRevenue(row({ date:YDAY, status:'DELIVERED', driver:'GREG' }), TODAY), true);
assert.equal(dayRowBooksRevenue(row({ date:YDAY, status:'', driver:'' }), TODAY), false, 'unassigned leftover does not book');
assert.equal(dayRowBooksRevenue(row({ date:YDAY, status:'PRE', driver:'GREG' }), TODAY), false);
assert.equal(dayRowBooksRevenue(row({ date:YDAY, status:'REJECTED', driver:'GREG' }), TODAY), false);
assert.equal(dayRowBooksRevenue(row({ date:YDAY, status:'PUSH', driver:'GREG' }), TODAY), false);

/* Money loops filter on booked, not active. */
const computeDayFn = html.slice(html.indexOf('function computeDay(){'), html.indexOf('function dayTotalsHTML('));
assert.ok(/rows\.filter\(r=>r\.booked\)/.test(computeDayFn), 'computeDay totals booked rows');
assert.ok(/activeLoads/.test(computeDayFn), 'computeDay keeps an active count');
assert.ok(/IN PROGRESS/.test(computeDayFn), 'open day with no completed loads is IN PROGRESS, not fake revenue');

const runFn = html.slice(html.indexOf('function runningTotals(refDate){'), html.indexOf('function verizonFuelDollarsForDate('));
assert.ok(/if\(!c\.booked\) return/.test(runFn), 'WTD/MTD runningTotals uses booked');
assert.ok(!/if\(!c\.active\) return/.test(runFn), 'runningTotals no longer sums all active rows');

const accumFn = html.slice(html.indexOf('function accumulatePnlByDay(){'), html.indexOf('function pnlSumRange('));
assert.ok(/if\(!r\.booked\) return/.test(accumFn), 'P&L accumulate uses booked');
assert.ok(/adpFieldActualsForDate/.test(accumFn), 'ADP actuals path still on P&L accumulate');
assert.ok(/blendEstDriverWages/.test(accumFn), 'EST blend still on P&L accumulate');
assert.ok(/verizonFuelDollarsForDate/.test(accumFn), 'Verizon fuel overwrite still on P&L accumulate');

assert.ok(/completed ·/.test(html) && /active/.test(html), 'UI shows completed vs active');
assert.ok(/0 completed · 65 active/.test(html) || /completed ·.*active/.test(html),
  'landing / P&amp;L copy mentions completed vs active');

/* Do not regress rates / fuel / ADP / Twilio. */
assert.ok(/'ARDENT':\s*\{\s*ratePerLb:\s*0\.00425,\s*fscPct:\s*32/.test(html), 'FCG Ardent short-haul rate unchanged');
assert.ok(/FCGE-origin twin of FCG→ARDENT/.test(html), 'FCGE→Ardent twin unchanged');
assert.ok(/'JACQUES BROS':\s*\{\s*'ARDENT':\s*\{\s*ratePerLb:\s*0\.00775,\s*fscPct:\s*33/.test(html),
  'Jacques→Ardent long-haul unchanged');
assert.ok(/avgRevenue:\s*425/.test(html), 'POC blended fallback stays $425');
assert.ok(/currentDieselPricePerGal:\s*4\.50/.test(html), 'diesel unchanged');
assert.ok(/fleetAvgMPG:\s*6\.0/.test(html), 'MPG unchanged');
assert.ok(/estDriverWageBlend:\s*1\.21/.test(html), 'ADP blend default unchanged');
assert.ok(/wearPerMile:\s*0\.498\b/.test(html), 'wear unchanged');
assert.ok(/otherVariablePerLoad:\s*0\b/.test(html), 'other stays 0');
assert.ok(/2026-08-26-fct-calc-v2\.1\.42-completed-rev/.test(html), 'APP_VERSION is v2.1.42');
assert.ok(/v2\.1\.42-completed-rev/.test(html), 'changelog has v2.1.42');

console.log('completed-revenue.test.mjs: ok');
