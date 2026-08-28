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

assert.ok(/2026-08-28-fct-calc-v2\.1\.48-stable-mtd/.test(html), 'APP_VERSION is v2.1.48');
assert.ok(/v2\.1\.48-stable-mtd/.test(html), 'changelog has v2.1.48');
assert.ok(/v2\.1\.47-no-fuel-bar/.test(html), 'prior changelog kept');

/* Books gate and diesel stay locked. */
const books = html.slice(html.indexOf('function dayRowBooksRevenue'), html.indexOf('/* END COMPLETED_REVENUE */'));
assert.ok(/rowHasDriverName/.test(books) && /rowHasFreightBill/.test(books), 'books still require driver AND FB');
assert.ok(/currentDieselPricePerGal:\s*4\.50/.test(html), 'source diesel default unchanged');
assert.ok(!/Device out of sync/.test(ui), 'no Device-out-of-sync UI outside changelog');
assert.ok(!/fuelPrice/.test(html.slice(html.indexOf('/* BEGIN MTD_STABLE */'), html.indexOf('/* END MTD_STABLE */'))),
  'MTD freeze path does not touch fuelPrice');

/* Header chips read ops net from the P&L board, not runningTotals().net. */
const header = html.slice(html.indexOf('function renderDayRollup(){'), html.indexOf('function landingStripHTML(') > 0
  ? html.indexOf('h += landingStripHTML()')
  : html.length);
assert.ok(/pnlBoardView\(shown\)/.test(header) || /pnlBoardView\(shown\)/.test(html),
  'header asks pnlBoardView for the chip numbers');
assert.ok(/pnlChipOpsNet/.test(html), 'chips go through pnlChipOpsNet');
const miniStart = html.indexOf('const mini = (t,x,fullName)=>{');
const miniEnd = html.indexOf('h += \'<div class="card" id="dispDrop"', miniStart);
const mini = html.slice(miniStart, miniEnd);
assert.ok(/pnlChipOpsNet/.test(mini), 'WTD/MTD mini uses ops net');
assert.ok(!/x\.net>=0/.test(mini), 'WTD/MTD mini no longer paints after-wear net');
assert.ok(/not this chip/.test(mini), 'tooltip says after wear is not the chip');
assert.ok(/driver name AND freight bill/.test(mini), 'tooltip states the books rule');

assert.ok(/MTD is one number/.test(html), 'P&L lede names the single MTD figure');
assert.ok(/fully loaded · not the /.test(html), 'After wear labeled as not the chip');
assert.ok(/booked \(driver \+ freight bill\)/.test(html), 'MTD column subtitle states books rule');
assert.ok(/!__calInFlight\) markBootSettle\('cal'\)/.test(html),
  '8s timeout does not force-settle calibration while a fetch is in flight');
assert.ok(/markBootSettle\('rows'\)/.test(html), 'IDB row hydrate is part of boot settle');

/* ---- Ops net vs after wear (the $51k vs $34k split) ---- */
const finishStart = html.indexOf('/* BEGIN PNL_BOARD */');
const finishEnd = html.indexOf('/* END PNL_BOARD */');
assert.ok(finishStart >= 0 && finishEnd > finishStart, 'PNL_BOARD markers');
const finishBox = { console };
createContext(finishBox);
runInContext(html.slice(finishStart, finishEnd + '/* END PNL_BOARD */'.length), finishBox);
const nets = finishBox.pnlFinishLines({
  rev: 400000, driver: 280000, fuel: 52000, wearOther: 17000, fixed: 17000
});
assert.equal(nets.opsNet, 51000, 'ops net is rev − wages − fuel − fixed');
assert.equal(nets.net, 34000, 'after wear subtracts the ~$17k month wear');
assert.notEqual(nets.opsNet, nets.net, 'the two nets must not be used interchangeably');

/* ---- Fingerprint freeze ---- */
const start = html.indexOf('/* BEGIN MTD_STABLE */');
const end = html.indexOf('/* END MTD_STABLE */');
assert.ok(start >= 0 && end > start, 'MTD_STABLE markers present');

function board(opsMtd, extra){
  return Object.assign({
    todayISO:'2026-08-28', shown:'2026-08-28',
    weekStart:'2026-08-24', monthStart:'2026-08-01',
    day:{ loads:40, rev:21500, opsNet:5000, net:4100, adpDays:0, estDriverDays:1 },
    mtd:{ loads:800, rev:400000, opsNet:opsMtd, net:opsMtd-17000, wearOther:17000, adpDays:22, estDriverDays:1 },
    wtd:{ loads:120, rev:60000, opsNet:9000, net:7200, adpDays:5, estDriverDays:1 }
  }, extra||{});
}

const settings = {
  currentDieselPricePerGal:6, fleetAvgMPG:6, estDriverWageBlend:1.21, defaultDriverRate:22.28
};
const adp = { importedAt:'2026-08-24T00:00:00.000Z', dateMin:'2026-08-01', dateMax:'2026-08-23' };

let live = board(51000);
const sandbox = {
  console,
  state: { settings: Object.assign({}, settings), adpPay: Object.assign({}, adp) },
  __adpRows: new Array(50),
  estPaintPending: () => false,
  buildPnlBoard: (dateISO) => Object.assign({}, live, { shown: dateISO || live.shown })
};
createContext(sandbox);
runInContext(html.slice(start, end + '/* END MTD_STABLE */'.length), sandbox);

const {
  pnlBooksFingerprint, pnlChipOpsNet, pnlBoardView, pnlReuseFrozen
} = sandbox;
assert.equal(typeof pnlBoardView, 'function');
assert.equal(pnlChipOpsNet(live.mtd), 51000);
assert.notEqual(pnlChipOpsNet(live.mtd), live.mtd.net);

const fpA = pnlBooksFingerprint(live, settings, adp, 50);
live = board(34000); // calibration / miles restated costs, books unchanged
const fpB = pnlBooksFingerprint(live, settings, adp, 50);
assert.equal(fpA, fpB, 'fingerprint ignores ops net / calibration restatement');

const fpDiesel = pnlBooksFingerprint(live, Object.assign({}, settings, { currentDieselPricePerGal:6.5 }), adp, 50);
assert.notEqual(fpA, fpDiesel, 'operator diesel change is a real input');
const fpBooks = pnlBooksFingerprint(board(51000, { mtd: { loads:801, rev:401000, opsNet:51000, net:34000 } }), settings, adp, 50);
assert.notEqual(fpA, fpBooks, 'another booked load changes the fingerprint');

live = board(51000);
const first = pnlBoardView('2026-08-28');
assert.equal(first.pending, false);
assert.equal(first.frozen, false);
assert.equal(first.board.mtd.opsNet, 51000);

live = board(34000);
const second = pnlBoardView('2026-08-28');
assert.equal(second.frozen, true, 'same books keep the committed MTD');
assert.equal(second.board.mtd.opsNet, 51000, 'MTD does not follow the calibration restatement');

const picked = pnlBoardView('2026-08-01');
assert.equal(picked.board.shown, '2026-08-01');
assert.equal(picked.board.mtd.opsNet, 51000, 'day picker does not restate MTD');

sandbox.state.settings.currentDieselPricePerGal = 6.5;
live = board(49900);
const diesel = pnlBoardView('2026-08-28');
assert.equal(diesel.frozen, false, 'diesel edit recomputes');
assert.equal(diesel.board.mtd.opsNet, 49900);

sandbox.estPaintPending = () => true;
sandbox.__stablePnl = null;
live = board(12000);
const held = pnlBoardView('2026-08-28');
assert.equal(held.pending, true);
assert.equal(held.board, null, 'do not invent MTD dollars before settle');

assert.equal(typeof pnlReuseFrozen, 'function');

console.log('mtd-stable.test.mjs: ok');
