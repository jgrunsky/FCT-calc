import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');

function extractMarked(html, begin, end){
  const start = html.indexOf(begin);
  const stop = html.indexOf(end);
  assert.ok(start >= 0 && stop > start, begin + ' / ' + end + ' markers missing');
  return html.slice(start + begin.length, stop);
}

const prelude = `
function p2(n){ return (n<10?'0':'')+n; }
function isoLocal(d){ return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
const DOW_LONG = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dateFromISO(iso){
  if(!iso) return null;
  const d = new Date(iso+'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}
function shortNameFor(fullName){ return String(fullName||''); }
function nextRowId(){ return 'T'+(++__rowSeq); }
let __rowSeq = 0;
function blankDayRow(){
  return { id:nextRowId(), source:'import', date:'',
           customer:'', deliveryPoint:'', origin:'', driver:'', driverRaw:'', time:'',
           lbs:'', miles:'', hours:'', revenueOverride:'', varCostOverride:'',
           po:'', fb:'', commodity:'', truck:'', status:'', notes:'', rawCells:[] };
}
function matchDriver(raw){ return String(raw||'').trim(); }
function laneDefaultsFor(){ return { lbs:52000, miles:40, hours:5, est:true, key:'' }; }
function classifyLoad(){ return { bucket:'diamond', label:'', why:'', destLabel:'' }; }
const HEADER_WORDS = /^(time|po|po ?\\/ ?rel|rel ?#|driver|grower|origin|fb ?#|commodity|truck|trailer|status|date|customer|weight|lbs|hours|revenue|notes)/i;
function defaultColumnMap(){
  return { time:0, po:1, driver:2, origin:3, fb:4, commodity:5, truck:6, status:7, trailer2:8,
           bannerCol:3, date:null, destination:null, lbs:null, hours:null, revenue:null, notes:null };
}
function excelSerialToDate(serial){
  const ms = (Number(serial) - 25569) * 86400 * 1000;
  return new Date(ms);
}
function parseCellDate(v){
  if(v==null || v==='') return null;
  if(v instanceof Date){
    if(isNaN(v.getTime())) return null;
    const y=v.getFullYear();
    return (y>=1990 && y<=2100) ? isoLocal(v) : null;
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
  if(/^\\d{5}(\\.\\d+)?$/.test(s)){
    const n = Number(s);
    if(n>32874 && n<73415){
      const d = excelSerialToDate(n);
      if(!isNaN(d.getTime())) return d.getUTCFullYear()+'-'+p2(d.getUTCMonth()+1)+'-'+p2(d.getUTCDate());
    }
    return null;
  }
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
function parseDPBanner(v, requireMarker){
  const s = String(v==null?'':v).toUpperCase().trim();
  if(!s) return null;
  const hasMarker = /\\bD\\.?\\s*P\\.?\\b/.test(s);
  const bare = /^(LATHROP|RIPON)$/.test(s);
  if(!hasMarker && !bare) return null;
  if(!hasMarker && requireMarker) return null;
  if(/LATHROP/.test(s)) return 'LATHROP';
  if(/RIPON/.test(s))   return 'RIPON';
  const rest = s.replace(/\\bD\\.?\\s*P\\.?\\b/,'').replace(/[^A-Z ]/g,'').trim();
  return rest || null;
}
function splitDriverCell(v){
  const s = String(v==null?'':v).trim();
  if(!s) return {raw:'', delivery:'', preloader:''};
  const parts = s.split(/\\s*[\\/|]\\s*/).filter(Boolean);
  if(parts.length>=2) return {raw:s, preloader:parts[0], delivery:parts[parts.length-1]};
  return {raw:s, preloader:'', delivery:s};
}
function fmtSheetTime(v){
  if(v==null || v==='') return '';
  return String(v).trim();
}
`;

const ioSrc = extractMarked(html, '/* BEGIN DISPATCH_SHEET_IO */', '/* END DISPATCH_SHEET_IO */');
const parseSrc = extractMarked(html, '/* BEGIN DISPATCH_PARSER */', '/* END DISPATCH_PARSER */');

const sandbox = createContext({ console });
runInContext(prelude + ioSrc + parseSrc, sandbox, { filename: 'dispatch-sheet-xlsx.test.mjs' });

const {
  DISPATCH_XLSX_HEADERS,
  dispatchDateBannerText,
  dispatchDpBannerText,
  dispatchLoadAoaRow,
  buildDispatchSheetAoa,
  parseDispatchRows
} = sandbox;

assert.ok(Array.isArray(DISPATCH_XLSX_HEADERS) && DISPATCH_XLSX_HEADERS.length >= 8);
assert.equal(DISPATCH_XLSX_HEADERS[2], 'Driver');
assert.equal(DISPATCH_XLSX_HEADERS[3], 'Grower / Origin');

{
  const label = dispatchDateBannerText('2026-08-25');
  assert.match(label, /8\/25\/2026/);
  assert.match(label, /TUESDAY/i);
}

assert.equal(dispatchDpBannerText('LATHROP'), 'D.P. LATHROP');
assert.equal(dispatchDpBannerText('RIPON'), 'D.P. RIPON');

const todayRow = {
  time:'6am', po:'75811-49', driver:'Gregorio Martinez', driverRaw:'GREG',
  origin:'PNG', fb:'192563', commodity:'CORN', truck:'55/56', status:'DISPATCHED',
  deliveryPoint:'LATHROP', date:'2026-08-25'
};
const pushRow = {
  time:'9am', po:'PUSH-1', driver:'', driverRaw:'',
  origin:'FCGE', fb:'', commodity:'WHT', truck:'', status:'PUSH',
  deliveryPoint:'RIPON', date:'2026-08-25'
};
const aboveRow = {
  time:'10am', po:'161-9', driver:'Hugo Valencia', driverRaw:'HUGO',
  origin:'PNG', fb:'', commodity:'BEEF', truck:'12/13', status:'',
  deliveryPoint:'', date:'2026-08-25'
};
const tomRow = {
  time:'2am', po:'78674-5', driver:'Felix', driverRaw:'FELIX',
  origin:'ARA', fb:'', commodity:'YEAST', truck:'70/71', status:'',
  deliveryPoint:'LATHROP', date:'2026-08-26'
};

const aoa = buildDispatchSheetAoa({
  dateISO: '2026-08-25',
  above: [aboveRow],
  lathrop: [todayRow],
  ripon: [pushRow],
  other: [],
  manual: [],
  tomorrowISO: '2026-08-26',
  tomAbove: [],
  tomLathrop: [tomRow],
  tomRipon: [],
  tomOther: []
});

assert.equal(aoa[0][0], 'Time');
assert.equal(aoa[0][2], 'Driver');
assert.ok(aoa.some(r => /8\/25\/2026/.test(String(r[3]||''))));
assert.ok(aoa.some(r => String(r[3]) === 'D.P. LATHROP'));
assert.ok(aoa.some(r => String(r[3]) === 'D.P. RIPON'));
assert.ok(aoa.some(r => String(r[2]) === 'GREG' && String(r[1]) === '75811-49'));
assert.ok(aoa.some(r => String(r[7]) === 'PUSH'));

const parsed = parseDispatchRows(aoa, sandbox.defaultColumnMap(), 0);
assert.ok(parsed.rows.length >= 4, 'expected today + push + above + tomorrow preload');

const byPo = Object.fromEntries(parsed.rows.map(r => [r.po, r]));
assert.equal(byPo['75811-49'].date, '2026-08-25');
assert.equal(byPo['75811-49'].deliveryPoint, 'LATHROP');
assert.equal(byPo['75811-49'].driverRaw, 'GREG');
assert.equal(byPo['75811-49'].origin, 'PNG');
assert.equal(byPo['75811-49'].status, 'DISPATCHED');
assert.equal(byPo['75811-49'].commodity, 'CORN');
assert.equal(byPo['75811-49'].truck, '55/56');

assert.equal(byPo['PUSH-1'].date, '2026-08-25');
assert.equal(byPo['PUSH-1'].deliveryPoint, 'RIPON');
assert.equal(String(byPo['PUSH-1'].status).toUpperCase(), 'PUSH');

assert.equal(byPo['161-9'].date, '2026-08-25');
assert.equal(byPo['161-9'].deliveryPoint, '');
assert.equal(byPo['161-9'].driverRaw, 'HUGO');

assert.equal(byPo['78674-5'].date, '2026-08-26');
assert.equal(byPo['78674-5'].deliveryPoint, 'LATHROP');
assert.equal(byPo['78674-5'].driverRaw, 'FELIX');
assert.equal(byPo['78674-5'].origin, 'ARA');

const load = dispatchLoadAoaRow(todayRow);
assert.equal(load[2], 'GREG');
assert.equal(load[3], 'PNG');
assert.doesNotMatch(JSON.stringify(load), /\$/);

assert.ok(/function sendDispatch\(/.test(html), 'Queue and Today share sendDispatch');
assert.ok(/sendDispatch\(id, name/.test(html) && /sendDispatch\(row\.id, target\.name/.test(html),
  'Queue Send and Today Send both call sendDispatch');
assert.ok(/qDownloadXlsx/.test(html) && /dispXlsx/.test(html), 'xlsx download on Queue and Today');
assert.ok(/dispatchSmsUrl/.test(html) && /fct-dispatch\.jamesgrunsky\.workers\.dev/.test(html),
  'SMS hops through the dispatch Worker');
assert.ok(/no cell on file/.test(html), 'missing cell still assigns');
assert.ok(/SMS not configured/.test(html), 'missing Twilio does not fail assignment');
assert.ok(/stubExcelWriteback/.test(html) && /excelWebUrl/.test(html),
  'OneDrive import URL kept; write-back stubbed');
assert.doesNotMatch(html, /TWILIO_AUTH_TOKEN\s*=\s*['\"][^'\"]+['\"]/, 'no Twilio secrets in the page');

console.log('dispatch-sheet-xlsx round-trip ok — '+parsed.rows.length+' rows');
