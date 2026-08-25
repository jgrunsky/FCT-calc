import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('/* BEGIN DISPATCH_XLSX');
const end = html.indexOf('/* END DISPATCH_XLSX */');
assert.ok(start >= 0 && end > start, 'DISPATCH_XLSX markers missing from index.html');
const src = html.slice(start, end + '/* END DISPATCH_XLSX */'.length);

const sandbox = {};
runInContext(src, createContext(sandbox));

const {
  dateBannerText, dispatchHeaderRow, bannerAoaRow, loadAoaRow,
  groupDispatchAoaRows, buildDispatchLogAoa
} = sandbox;

assert.equal(dispatchHeaderRow()[2], 'Driver');
assert.equal(dispatchHeaderRow()[3], 'Origin');
assert.match(dateBannerText('2026-08-25'), /8\/25\/2026/);
assert.match(dateBannerText('2026-08-25'), /TUESDAY/);

const today = [
  { source:'import', date:'2026-08-25', time:'6am', po:'100', driverRaw:'HUGO', origin:'PNG',
    commodity:'CHICKEN MEAL', truck:'12/13', status:'P', deliveryPoint:'LATHROP', fb:'FB1' },
  { source:'import', date:'2026-08-25', time:'2am', po:'101', driverRaw:'GREG', origin:'ARA',
    commodity:'YEAST', truck:'1/2', status:'PUSH', deliveryPoint:'RIPON', fb:'' },
  { source:'import', date:'2026-08-25', time:'9am', po:'102', driverRaw:'', origin:'FCGE',
    commodity:'SOY', truck:'', status:'', deliveryPoint:'', fb:'' },
  { source:'manual', date:'2026-08-25', time:'noon', po:'WHATIF', origin:'X' }
];
const tom = [
  { source:'import', date:'2026-08-26', time:'4am', po:'200', driverRaw:'RAMON', origin:'PNG',
    commodity:'PMX', truck:'8/9', status:'PRE', deliveryPoint:'LATHROP', fb:'' }
];

const aoa = buildDispatchLogAoa('2026-08-25', today, tom);
assert.deepEqual(aoa[0], dispatchHeaderRow());
assert.equal(aoa[1][3], dateBannerText('2026-08-25'));
assert.ok(!aoa.some(r => r[1]==='WHATIF'), 'what-if rows stay off the Excel log');

function parseCellDate(v){
  const s = String(v==null?'':v).trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return m[1]+'-'+String(m[2]).padStart(2,'0')+'-'+String(m[3]).padStart(2,'0');
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if(m){
    let yr=+m[3]; if(yr<100) yr += 2000;
    return yr+'-'+String(+m[1]).padStart(2,'0')+'-'+String(+m[2]).padStart(2,'0');
  }
  return null;
}
function parseDPBanner(v){
  const s = String(v==null?'':v).toUpperCase().trim();
  if(!/\bD\.?\s*P\.?\b/.test(s)) return null;
  if(/LATHROP/.test(s)) return 'LATHROP';
  if(/RIPON/.test(s)) return 'RIPON';
  const rest = s.replace(/\bD\.?\s*P\.?\b/,'').replace(/[^A-Z ]/g,'').trim();
  return rest || null;
}

function walk(aoaIn){
  const loads=[];
  let curDate='', curDP='';
  for(const row of aoaIn){
    const filled = (row||[]).filter(c=>c!=null && String(c).trim()!=='');
    if(!filled.length) continue;
    if(String(row[0]).toUpperCase()==='TIME' && /driver/i.test(String(row[2]))) continue;
    const bcell = row[3];
    const bDate = parseCellDate(bcell);
    if(bDate && filled.length<=2){ curDate=bDate; curDP=''; continue; }
    const bDP = parseDPBanner(bcell);
    if(bDP && filled.length<=2){ curDP=bDP; continue; }
    loads.push({ date:curDate, dp:curDP, time:row[0], po:row[1], driver:row[2], origin:row[3], status:row[7] });
  }
  return loads;
}

const loads = walk(aoa);
assert.equal(loads.length, 4);
const hugo = loads.find(l=>l.po==='100');
assert.equal(hugo.date, '2026-08-25');
assert.equal(hugo.dp, 'LATHROP');
assert.equal(hugo.driver, 'HUGO');
assert.equal(hugo.origin, 'PNG');
const greg = loads.find(l=>l.po==='101');
assert.equal(greg.dp, 'RIPON');
assert.equal(greg.status, 'PUSH');
const above = loads.find(l=>l.po==='102');
assert.equal(above.dp, '');
assert.equal(above.date, '2026-08-25');
const ramon = loads.find(l=>l.po==='200');
assert.equal(ramon.date, '2026-08-26');
assert.equal(ramon.dp, 'LATHROP');
assert.equal(ramon.status, 'PRE');

const g = groupDispatchAoaRows(today);
assert.equal(g.lathrop.length, 1);
assert.equal(g.ripon.length, 1);
assert.equal(g.above.length, 1);

const assigned = Object.assign({}, hugo, { driverRaw:'HUGO', driver:'Hugo Valencia', status:'DISPATCHED' });
assert.equal(loadAoaRow(assigned)[2], 'HUGO');
assert.equal(loadAoaRow(assigned)[7], 'DISPATCHED');

console.log('dispatch-xlsx.test.mjs ok');
