import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('/* BEGIN ADP_ACTUALS */');
const end = html.indexOf('/* END ADP_ACTUALS */');
assert.ok(start >= 0 && end > start, 'ADP_ACTUALS markers missing from index.html');

const datePrelude = `
function p2(n){ return (n<10?'0':'')+n; }
function excelSerialToDate(serial){
  return new Date((Number(serial) - 25569) * 86400 * 1000);
}
function parseCellDate(v){
  if(v==null || v==='') return null;
  if(v instanceof Date){
    if(isNaN(v.getTime())) return null;
    const y=v.getFullYear();
    return (y>=1990 && y<=2100) ? (v.getFullYear()+'-'+p2(v.getMonth()+1)+'-'+p2(v.getDate())) : null;
  }
  if(typeof v==='number'){
    if(v>32874 && v<73415){
      const d = excelSerialToDate(v);
      if(isNaN(d.getTime())) return null;
      return d.getUTCFullYear()+'-'+p2(d.getUTCMonth()+1)+'-'+p2(d.getUTCDate());
    }
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/(\\d{4})-(\\d{1,2})-(\\d{1,2})/);
  if(m){ const y=+m[1]; if(y>=1990&&y<=2100) return y+'-'+p2(+m[2])+'-'+p2(+m[3]); }
  m = s.match(/(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{2,4})/);
  if(m){
    const mo=+m[1], da=+m[2]; let yr=+m[3];
    if(yr<100) yr += 2000;
    if(mo>=1&&mo<=12 && da>=1&&da<=31 && yr>=1990&&yr<=2100) return yr+'-'+p2(mo)+'-'+p2(da);
  }
  return null;
}
function defaultAdpPay(){
  return { fileName:'', importedAt:'', dateMin:'', dateMax:'',
    fieldDollars:0, fieldHours:0, officeDollars:0, officeHours:0,
    fieldPeople:0, officePeople:0, unmatchedPeople:0, payRows:0,
    openDate:'', endOfDay:false, _rowsInIDB:false };
}
function isoLocal(d){ return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
`;

const rosters = {
  drivers: [
    { name:'Gregorio Martinez' }, { name:'Ramon Carriedo' }, { name:'Fabian Vega' },
    { name:'Jesus Estrada' }, { name:'Jesus Flores' }, { name:'Carlos Prado' },
    { name:'Prabhkirat Singh' }, { name:'Hugo Valencia' }, { name:'Silvino Ochoa' },
    { name:'Orlando Villeda' }, { name:'Genaro Felix' }, { name:'Manuel Munoz' },
    { name:'Rodolfo Segura' }, { name:'Joseph Maimone' }, { name:'Jose Manuel Saucedo' },
    { name:'Albert Racoma' }, { name:'Felipe Paez Villasenor' }, { name:'Juan Morales' },
    { name:'Francisco Delgado' }, { name:'Rafael Lopez' }, { name:'Joel Sosa Ruiz' },
    { name:'Juan Castillo' }, { name:'Marcos Andrade' }, { name:'Victor Solorzano Navarro' }
  ],
  office: [
    { name:'Kelly Kearns' }, { name:'Leah Kearns' }, { name:'Jeremy Turner' },
    { name:'Vincent Maimone' }, { name:'Rene Casias' }, { name:'James Grunsky' }
  ]
};

const sandbox = {
  console,
  state: { settings: { drivers: rosters.drivers, office: rosters.office } },
  matchDriver: () => '',
  save() {},
  idbPut() { return Promise.resolve(true); },
  idbGet() { return Promise.resolve(null); },
  idbDel() { return Promise.resolve(true); },
  showStorageError() {},
  IDB_ADP_KEY: 'fct-calc:adpPayRows'
};
const ctx = createContext(sandbox);
runInContext(datePrelude + html.slice(start, end), ctx);

const {
  parseAdpDailyTotals, matchAdpPerson, applyAdpToModeled,
  looksLikeAdpAoa, mergeAdpRowsForRange, summarizeAdpRows,
  adpAppliesToDate, adpFileIsEndOfDay, adpFieldDriversForDate,
  rebuildAdpIndex, pnlDriverSource
} = sandbox;

function blank(n){ return Array(n).fill(''); }
function rowAt(map){
  const r = blank(18);
  Object.keys(map).forEach(k => { r[+k] = map[k]; });
  return r;
}

const nameHdr = rowAt({ 0:'Last Name', 5:'First Name', 6:'Position ID' });
const payHdr  = rowAt({ 0:'Pay Date', 5:'Pay Code', 14:'Hours', 17:'Dollars' });

function emp(last, first, zct){
  return rowAt({ 0:last, 5:first, 6:zct });
}
function pay(serial, code, hours, dollars){
  return rowAt({ 0:serial, 5:code, 14:hours, 17:dollars });
}
function wrap(code, hours, dollars){
  return rowAt({ 5:code, 14:hours==null?'':hours, 17:dollars==null?'':dollars });
}

const AUG1 = 46235; // 2026-08-01
const AUG2 = 46236;

const fixture = [
  ['Employee Daily Totals Report'],
  ['Company Code', 'ZCT'],
  ['Date Range', '08/01/2026 - 08/31/2026'],
  nameHdr,
  payHdr,
  emp('Andrade', 'Marcos', 'ZCT000053'),
  pay(AUG1, 'REGULAR-Regular', 8, 188),
  pay(AUG1, 'OVERTIME-Overtime', 1.5, 52.88),
  pay(AUG1, 'PAID MEAL-Paid Meal Award', 0, 12),
  wrap('30min', '', ''),
  pay(AUG1, 'California Meal Plan-California', 0, 8.5),
  wrap('Meal Plan 5th Hour', '', ''),
  emp('Villeda.', 'Orlando', 'ZCT000010'),
  pay(AUG1, 'REGULAR-Regular', 10, 240),
  emp('Saucedo', 'Jose', 'ZCT000015'),
  pay(AUG1, 'REGULAR-Regular', 8, 176),
  emp('Kearns', 'Kelly', 'ZCT000099'),
  pay(AUG1, 'REGULAR-Regular', 8, 208),
  emp('Maimone', 'Vincent', 'ZCT000098'),
  pay(AUG1, 'REGULAR-Regular', 8, 192),
  emp('Martinez', 'Gregorio', 'ZCT000001'),
  pay(AUG2, 'REGULAR-Regular', 8, 172)
];

assert.equal(looksLikeAdpAoa(fixture), true);
assert.equal(looksLikeAdpAoa([['Date','Driver','Grower','FB','Commodity']]), false);

{
  const jose = matchAdpPerson('Jose', 'Saucedo', rosters);
  assert.equal(jose.role, 'field');
  assert.equal(jose.name, 'Jose Manuel Saucedo');
  const vil = matchAdpPerson('Orlando', 'Villeda.', rosters);
  assert.equal(vil.role, 'field');
  assert.equal(vil.name, 'Orlando Villeda');
  const vin = matchAdpPerson('Vincent', 'Maimone', rosters);
  assert.equal(vin.role, 'office');
  assert.equal(vin.name, 'Vincent Maimone');
  const joe = matchAdpPerson('Joseph', 'Maimone', rosters);
  assert.equal(joe.role, 'field');
  assert.equal(joe.name, 'Joseph Maimone');
  const kelly = matchAdpPerson('Kelly', 'Kearns', rosters);
  assert.equal(kelly.role, 'office');
}

{
  const parsed = parseAdpDailyTotals(fixture, { rosters:rosters, matchPerson: matchAdpPerson });
  assert.equal(parsed.kind, 'adp');
  assert.equal(parsed.dateMin, '2026-08-01');
  assert.equal(parsed.dateMax, '2026-08-02');

  const andradeCodes = parsed.rows.filter(r => r.rosterName==='Marcos Andrade').map(r => r.payCode);
  assert.ok(andradeCodes.some(c => /PAID MEAL/i.test(c) && /30min/i.test(c)),
    'wrapped meal award should concatenate onto previous pay code, got '+JSON.stringify(andradeCodes));
  assert.ok(andradeCodes.some(c => /California Meal Plan/i.test(c) && /5th Hour/i.test(c)),
    'wrapped California Meal Plan should concatenate, got '+JSON.stringify(andradeCodes));

  const vil = parsed.rows.find(r => r.last.replace(/[^A-Za-z]/g,'') === 'Villeda');
  assert.ok(vil, 'Villeda. employee block should parse');
  assert.equal(vil.role, 'field');
  assert.equal(vil.rosterName, 'Orlando Villeda');

  const jose = parsed.rows.find(r => r.last==='Saucedo');
  assert.equal(jose.role, 'field');
  assert.equal(jose.rosterName, 'Jose Manuel Saucedo');

  const kelly = parsed.rows.find(r => r.last==='Kearns');
  assert.equal(kelly.role, 'office');
  const vince = parsed.rows.find(r => r.first==='Vincent');
  assert.equal(vince.role, 'office');

  const sum = summarizeAdpRows(parsed.rows);
  const aug1Field = parsed.rows.filter(r => r.date==='2026-08-01' && r.role==='field')
    .reduce((a,r)=>a+(Number(r.dollars)||0),0);
  // Andrade 188+52.88+12+8.5 + Villeda 240 + Saucedo 176 = 677.38
  assert.equal(Math.round(aug1Field*100)/100, 677.38);
  assert.ok(sum.officeDollars >= 208+192, 'office dollars should include Kelly + Vincent');
  assert.equal(sum.fieldPeople, 4); // Andrade, Villeda, Saucedo, Martinez
  assert.ok(kelly.dollars + vince.dollars === sum.officeDollars || sum.officeDollars === 400);
}

{
  // Modelled: $400 var of which $144 is driver. ADP field $677.38 → var = 400-144+677.38
  const next = applyAdpToModeled(400, 144, 677.38);
  assert.equal(Math.round(next*100)/100, 933.38);
  assert.equal(applyAdpToModeled(400, 144, null), 400);
}

{
  const kept = mergeAdpRowsForRange(
    [{date:'2026-07-31', dollars:1}, {date:'2026-08-15', dollars:2}, {date:'2026-09-01', dollars:3}],
    [{date:'2026-08-01', dollars:9}],
    '2026-08-01', '2026-08-31'
  );
  assert.deepEqual(kept.map(r=>r.date).sort(), ['2026-07-31','2026-08-01','2026-09-01']);
}

{
  /* Closed-day gate: a 2pm pull must not become today's P&L, and must not
     silently become "yesterday's actuals" overnight without a new import. */
  assert.equal(adpAppliesToDate('2026-08-23', { openDate:'2026-08-24', endOfDay:false }), true);
  assert.equal(adpAppliesToDate('2026-08-24', { openDate:'2026-08-24', endOfDay:false }), false);
  assert.equal(adpAppliesToDate('2026-08-24', { openDate:'2026-08-24', endOfDay:true }), true,
    're-drop after close may apply ADP to today');
  assert.equal(adpAppliesToDate('2026-08-24', { openDate:'2026-08-25', endOfDay:false }), true,
    'next-morning import: yesterday is closed');
  assert.equal(adpAppliesToDate('2026-08-25', { openDate:'2026-08-25', endOfDay:false }), false);
  assert.equal(adpFileIsEndOfDay('2026-08-24T14:00:00', '2026-08-24'), false,
    '2pm local is not end of day');
  assert.equal(adpFileIsEndOfDay('2026-08-24T20:00:00', '2026-08-24'), true,
    '8pm local re-drop counts as end of day');
}

{
  /* P&L board helpers: by-driver rollup (not pay-code rows) + mixed source chip. */
  const parsed = parseAdpDailyTotals(fixture, { rosters:rosters, matchPerson: matchAdpPerson });
  rebuildAdpIndex(parsed.rows);
  const day1 = adpFieldDriversForDate('2026-08-01', parsed.rows);
  assert.equal(day1.length, 3, 'Andrade, Villeda, Saucedo — not Kelly/Vincent, not pay-code rows');
  const andrade = day1.find(d => d.name === 'Marcos Andrade');
  assert.ok(andrade);
  assert.equal(Math.round(andrade.dollars*100)/100, 188+52.88+12+8.5);
  assert.equal(andrade.hours, 8+1.5);
  assert.equal(day1[0].dollars >= day1[1].dollars, true, 'sorted by dollars');
  assert.equal(pnlDriverSource(20, 1), 'ADP+EST');
  assert.equal(pnlDriverSource(21, 0), 'ADP');
  assert.equal(pnlDriverSource(0, 21), 'EST');
}

console.log('adp-daily-totals.test.mjs: ok');
