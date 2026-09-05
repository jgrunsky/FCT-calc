import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');

assert.ok(/2026-09-05-fct-calc-v2\.1\.48-pnl-today/.test(html), 'APP_VERSION is v2.1.48-pnl-today');
assert.ok(/v2\.1\.48-pnl-today/.test(html), 'changelog has v2.1.48-pnl-today');
assert.ok(/currentDieselPricePerGal:\s*4\.50/.test(html), 'diesel default unchanged');
assert.ok(/cellDates:false/.test(html) && !/XLSX\.read\([^)]*cellDates:true/.test(html),
  'file-drop workbook stays on serials, not Date objects');
assert.ok(/pickBoardDate\(res\.dates, di\.filterDate\)/.test(html),
  'applyParse lands with pickBoardDate, not UTC toISOString');
assert.ok(/function refreshVerizonMilesToday\(\)\{[\s\S]*isoLocal\(new Date\(\)\)/.test(html),
  'Verizon miles fallback is local today');
assert.ok(/pnlChipOpsNet/.test(html) && /ops net through today/.test(html),
  'header WTD/MTD chips paint ops net');
assert.ok(/DAY ops net \(same as P&L Day\)/.test(html),
  'header DAY chip is labeled as the P&L Day number');
assert.ok(/rowHasDriverName/.test(html) && /rowHasFreightBill/.test(html),
  'books still require driver AND freight bill');

const dateStart = html.indexOf('function isoLocal(d)');
const dateEnd = html.indexOf('function parseDPBanner');
assert.ok(dateStart >= 0 && dateEnd > dateStart, 'date helpers found');

const helperStart = html.indexOf('/* BEGIN PNL_TODAY */');
const helperEnd = html.indexOf('/* END PNL_TODAY */');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'PNL_TODAY markers present');

const prelude = `
function p2(n){ return (n<10?'0':'')+n; }
`;
const sandbox = { console };
createContext(sandbox);
runInContext(
  prelude
    + html.slice(dateStart, dateEnd)
    + html.slice(helperStart, helperEnd + '/* END PNL_TODAY */'.length),
  sandbox
);

const { parseCellDate, excelSerialToDate, isoLocal, pickBoardDate, pnlChipOpsNet } = sandbox;
assert.equal(typeof parseCellDate, 'function');
assert.equal(typeof pickBoardDate, 'function');
assert.equal(typeof pnlChipOpsNet, 'function');

/* Aug 1 2026 serial from ADP fixtures; Sep 2 = +32 days. */
const AUG1 = 46235;
const SEP2 = AUG1 + 32;
const SEP3 = AUG1 + 33;
assert.equal(parseCellDate(SEP2), '2026-09-02', 'Excel serial Sep 2 stays Sep 2');
assert.equal(parseCellDate(SEP3), '2026-09-03', 'Excel serial Sep 3 stays Sep 3');
assert.equal(parseCellDate('09/02/2026'), '2026-09-02');
assert.equal(parseCellDate(String(SEP2)), '2026-09-02', 'text serial from the worker stays Sep 2');

/* UTC-midnight Date is what SheetJS cellDates:true used to emit.
   isoLocal() in Pacific time would have returned 2026-09-01.
   Build the Date inside the vm so instanceof Date matches. */
runInContext(`
  __wed = parseCellDate(new Date(Date.UTC(2026, 8, 2, 0, 0, 0)));
  __thu = parseCellDate(new Date(Date.UTC(2026, 8, 3, 0, 0, 0)));
`, sandbox);
assert.equal(sandbox.__wed, '2026-09-02',
  'Wed 9/2 00:00 UTC stays Wednesday — not Tuesday');
assert.equal(sandbox.__thu, '2026-09-03',
  'Thu 9/3 00:00 UTC stays Thursday — not Wednesday');

/* Evening PT: local Friday 7pm. File already has Saturday's preload banner.
   Old UTC today would have been Saturday. */
const dates = [{ date:'2026-09-04' }, { date:'2026-09-05' }];
const friEve = new Date(2026, 8, 4, 19, 0, 0);
assert.equal(pickBoardDate(dates, '', friEve), '2026-09-04',
  'evening refresh lands on local Friday, not Saturday');
assert.equal(pickBoardDate(dates, '2026-09-05', friEve), '2026-09-04',
  'leftover UTC-tomorrow filterDate snaps back to Friday');
assert.equal(pickBoardDate(
  [{ date:'2026-09-02' }, { date:'2026-09-04' }],
  '2026-09-02',
  friEve
), '2026-09-02', 'refresh while viewing an earlier day stays there');
assert.equal(pickBoardDate(dates, '2026-09-04', friEve), '2026-09-04');

assert.equal(pnlChipOpsNet({ opsNet: 51000, net: 34000, wearOther: 17000 }), 51000);
assert.equal(pnlChipOpsNet({ net: 34000, wearOther: 17000 }), 51000,
  'if opsNet is missing, add wear back so the chip matches the board');
assert.equal(pnlChipOpsNet(null), 0);

console.log('pnl-today.test.mjs: ok');
