import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');

assert.ok(/2026-09-14-fct-calc-v2\.1\.50-qbo-mixed-rates/.test(html), 'APP_VERSION is v2.1.50');
assert.ok(/v2\.1\.50-qbo-mixed-rates/.test(html), 'changelog has mixed-rates');
assert.ok(!/Device out of sync/.test(html.slice(0, html.indexOf('const SHADOW_CHANGELOG'))),
  'no Device-out-of-sync UI outside changelog');
assert.ok(/currentDieselPricePerGal:\s*4\.50/.test(html), 'diesel default left at $4.50 source value');
assert.ok(!/currentDieselPricePerGal = Number\(d\.canonical\)/.test(html),
  'never assigns canonical diesel onto the device');

assert.ok(/'V&A Lagoria'/.test(html) && /ratePerLb:0\.012/.test(html), 'Lagoria card $0.012/lb');
assert.ok(/'French Camp Grain'/.test(html) && /ratePerLb:0\.004/.test(html), 'French Camp Grain card $0.004/lb');
assert.ok(/ratePerLb:0\.0094/.test(html) && /fscPct:43/.test(html), 'CNP ~$0.0094 + 43% FSC');
assert.ok(/ratePerLb:0\.0075/.test(html), 'Perdue $0.0075/lb on the card');
assert.ok(/POC_CURRENT_FSC_PCT = 43/.test(html), 'POC FSC clause is 43%');
assert.ok(/Each row is priced on its own/.test(html), 'revenueForRow documents per-row isolation');
assert.ok(/customerCardRevenueForRow/.test(html), 'customer card lookup exists');
assert.ok(/CNP.*CAL NATURAL are California Natural Products/s.test(html)
       || /CNP \/ CAL NATURAL are California Natural Products/.test(html),
  'CNP dest is not classified as POC');
assert.ok(!/POC_DESTINATIONS = \[[^\]]*CNP/.test(html), 'CNP is not a POC destination');

assert.ok(/function scanMissingRates/.test(html), 'missing-rates scanner still present');
assert.ok(/placeholder — no verified rate/.test(html) && /blended avg/.test(html),
  'missing-rates still flags placeholder and POC blend');
assert.ok(/data-mr-lb/.test(html) && /data-mr-fsc/.test(html) && /data-infofscm/.test(html),
  'Settings/Info still expose per-lb and % vs $/ton FSC');

const mixStart = html.indexOf('/* BEGIN MIXED_RATES */');
const mixEnd = html.indexOf('/* END MIXED_RATES */');
assert.ok(mixStart >= 0 && mixEnd > mixStart, 'MIXED_RATES markers present');

const fscStart = html.indexOf('function fscAmount(method, value, ctx){');
const fscEnd = html.indexOf('function fscRuleText(rule){');
assert.ok(fscStart >= 0 && fscEnd > fscStart, 'fscAmount found');

const cardStart = html.indexOf('const CUSTOMER_RATES_ASOF');
const cardEnd = html.indexOf('const EXTRA_CUSTOMERS');
assert.ok(cardStart >= 0 && cardEnd > cardStart, 'customer rate defaults found');

const pngStart = html.indexOf('const PNG_ORIGINS');
const pngEnd = html.indexOf('/* What v1.2');
assert.ok(pngStart >= 0 && pngEnd > pngStart, 'PNG lane block found');

const pocStart = html.indexOf('const POC_CURRENT_FSC_PCT');
const pocEnd = html.indexOf('function laneOverrideKey(');
assert.ok(pocStart >= 0 && pocEnd > pocStart, 'POC lane block found');

const prelude = `
function normOrigin(v){
  return String(v==null?'':v).toUpperCase().replace(/\\s+/g,' ').trim().replace(/[.'\`]/g,'');
}
function normLabel(v){
  return String(v==null?'':v).toUpperCase().replace(/\\s+/g,' ').trim();
}
function customerLabelFrom(truckCell){
  const g = normLabel(truckCell);
  if(!g) return '';
  if(g==='FCG' || g==='FCGE' || g==='PNG') return '';
  return g;
}
function laneRateOverrideFor(){ return null; }
function money2(n){ return '$'+(Number(n)||0).toFixed(2); }
const FSC_METHODS = [
  { id:'percent_of_linehaul', suffix:'% of linehaul' },
  { id:'per_ton', suffix:'/ton' }
];
`;

const sandbox = { console, state: { customerRates: {}, laneRateOverrides: {} } };
createContext(sandbox);
runInContext(
  prelude
  + html.slice(cardStart, cardEnd)
  + html.slice(fscStart, fscEnd)
  + html.slice(mixStart, mixEnd + '/* END MIXED_RATES */'.length)
  + html.slice(pngStart, pngEnd)
  + html.slice(pocStart, pocEnd),
  sandbox
);

sandbox.state.customerRates = sandbox.defaultCustomerRates();

const cents = n => Math.round(n * 100) / 100;
const lbs = 54000;

const pn = sandbox.pngLaneRevenue('PNG', 'RIPON', 'YC', lbs);
assert.ok(pn, 'PNG→Ripon YC matches Penny Newman lane');
assert.equal(cents(pn.amount), cents(sandbox.qboMixLinehaulFsc(lbs, 0.0072, 'per_ton', 2)),
  'PN majority rate is qty × $0.0072 + $2/ton');

const pnAlt = sandbox.qboMixLinehaulFsc(lbs, 0.0135, 'per_ton', 2);
assert.ok(pnAlt > pn.amount, 'PN $0.0135 loads bill more than the Ripon $0.0072 lane');

const poc = sandbox.pocLaneRevenue('FCGE', 'ARDENT', lbs, 'WHT');
assert.ok(poc, 'POC Ardent lane matches');
assert.equal(cents(poc.amount), cents(lbs * 0.00425 * 1.43),
  'POC Ardent is qty × $0.00425 × 1.43 FSC');

const perdue = sandbox.pocLaneRevenue('PNG', 'ASSOC', lbs, 'ORG CORN');
assert.ok(perdue, 'Perdue ORG CORN lane matches');
assert.equal(cents(perdue.amount), cents(lbs * 0.0075),
  'Perdue ORG CORN is qty × $0.0075 with no FSC');

const cnp = sandbox.customerCardLinehaulFsc('California Natural Products', lbs);
assert.ok(cnp, 'CNP card prices per lb');
assert.equal(cents(cnp.amount), cents(lbs * 0.0094 * 1.43),
  'CNP is qty × $0.0094 + 43% FSC');

const lagoria = sandbox.customerCardLinehaulFsc('V&A Lagoria', lbs);
assert.ok(lagoria);
assert.equal(cents(lagoria.amount), cents(lbs * 0.012),
  'Lagoria is qty × $0.012, no FSC');

const fcg = sandbox.customerCardLinehaulFsc('French Camp Grain', lbs);
assert.ok(fcg);
assert.equal(cents(fcg.amount), cents(lbs * 0.004 * 1.43),
  'French Camp Grain is qty × $0.004 + 43% FSC');

/* Mixed day = sum of each load's own math — not one flat rate. */
const mixed = pn.amount + poc.amount + perdue.amount + cnp.amount + lagoria.amount + fcg.amount;
const expectedMix = sandbox.qboMixLinehaulFsc(lbs, 0.0072, 'per_ton', 2)
  + (lbs * 0.00425 * 1.43)
  + (lbs * 0.0075)
  + (lbs * 0.0094 * 1.43)
  + (lbs * 0.012)
  + (lbs * 0.004 * 1.43);
assert.equal(cents(mixed), cents(expectedMix), 'mixed-day revenue is the sum of per-load QBO math');
assert.notEqual(cents(mixed), cents(6 * 425), 'mixed day is not 6× the $425 POC blend');
assert.notEqual(cents(mixed), cents(6 * pn.amount), 'mixed day is not 6× the Penny Newman rate');

assert.equal(sandbox.resolveCustomerRateName('CNP'), 'California Natural Products');
assert.equal(sandbox.resolveCustomerRateName('LAGORIA'), 'V&A Lagoria');
assert.equal(sandbox.resolveCustomerRateName("VA LAGORIA"), 'V&A Lagoria');
assert.equal(sandbox.resolveCustomerRateName('FRENCH CAMP GRAIN'), 'French Camp Grain');
assert.equal(sandbox.resolveCustomerRateName('PERDUE'), 'Perdue Farms Inc');

const cnpRow = { destLabel:'CNP', custLabel:"Phil O'Connell Grain", customer:"Phil O'Connell Grain",
                 lbs:lbs, origin:'FCG', bucket:'steady' };
const cnpRev = sandbox.customerCardRevenueForRow(cnpRow);
assert.ok(cnpRev, 'CNP dest on a POC-classified row still hits the CNP card');
assert.equal(cents(cnpRev.amount), cents(cnp.amount));

const lagRow = { destLabel:'LAGORIA', custLabel:'LAGORIA', lbs:lbs, origin:'FCGE', bucket:'spot' };
const lagRev = sandbox.customerCardRevenueForRow(lagRow);
assert.ok(lagRev);
assert.equal(cents(lagRev.amount), cents(lagoria.amount));

const fcgRow = { destLabel:'FRENCH CAMP GRAIN', custLabel:'FRENCH CAMP GRAIN', lbs:lbs, origin:'STOKES', bucket:'steady' };
const fcgRev = sandbox.customerCardRevenueForRow(fcgRow);
assert.ok(fcgRev);
assert.equal(cents(fcgRev.amount), cents(fcg.amount));

/* Completing / editing one load must not mutate another load's rate fields. */
const a = { lbs:54000, destLabel:'CNP', status:'DISPATCHED' };
const b = { lbs:52000, destLabel:'LAGORIA', status:'DISPATCHED' };
const a1 = sandbox.customerCardRevenueForRow(a).amount;
const b1 = sandbox.customerCardRevenueForRow(b).amount;
a.status = 'DELIVERED';
a.revenueOverride = '';
const a2 = sandbox.customerCardRevenueForRow(a).amount;
const b2 = sandbox.customerCardRevenueForRow(b).amount;
assert.equal(a2, a1, 'completing load A does not change A\'s card math');
assert.equal(b2, b1, 'completing load A does not change load B\'s rate');
assert.notEqual(cents(a1), cents(b1), 'CNP and Lagoria stay different rates');

const pnCard = sandbox.customerCardRevenueForRow({ customer:'Penny Newman', destLabel:'RIPON', lbs:lbs });
assert.equal(pnCard, null, 'Penny Newman does not flatten onto a single card $/lb');
const pocCard = sandbox.customerCardRevenueForRow({ customer:"Phil O'Connell Grain", destLabel:'ARDENT', lbs:lbs });
assert.equal(pocCard, null, 'POC does not flatten onto a single card $/lb');

const unknown = sandbox.customerCardRevenueForRow({ destLabel:'UNKNOWN MILL', custLabel:'UNKNOWN MILL', lbs:lbs });
assert.equal(unknown, null, 'unknown dest has no card — missing-rates path stays open');

assert.equal(sandbox.state.customerRates["Phil O'Connell Grain"].fscValue, 43,
  'POC customer card FSC is 43%');
assert.equal(sandbox.state.customerRates['California Natural Products'].fscMethod, 'percent_of_linehaul');
assert.equal(sandbox.state.customerRates['Penny Newman'].fscMethod, 'per_ton');
assert.equal(sandbox.state.customerRates['Penny Newman'].fscValue, 2);
assert.equal(sandbox.state.customerRates['V&A Lagoria'].fscMethod, 'none');
assert.equal(sandbox.state.customerRates['Perdue Farms Inc'].fscMethod, 'none');

console.log('mixed-rates.test.mjs: ok');
