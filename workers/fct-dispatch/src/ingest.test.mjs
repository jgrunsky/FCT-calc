import { strict as assert } from 'node:assert';
import * as XLSX from 'xlsx';
import worker from './index.js';
import {
  ingestKeyOk,
  looksLikeZipXlsx,
  decodeBase64,
  extractBase64FromEnvelope,
  extractBase64FromMalformed,
  extractBase64ZipFromText,
  extractBase64ZipFromBytes,
  collapseUtf16Ascii,
  normalizeIngestJson,
  latestPayloadFromRows,
  rowsFromRawEnvelopeText
} from './ingest.js';
import { WORKER_FIELDS, DISPATCH_SHEET, aoaToWorkerRows } from './xlsx-rows.js';

const INGEST_KEY = 'test-ingest-key-not-for-prod';
const ORIGIN = 'https://fct-dispatch.jamesgrunsky.workers.dev';

function mockEnv(){
  const store = new Map();
  return {
    INGEST_KEY,
    DISPATCH: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); }
    },
    _store: store
  };
}

function buildDispatchXlsx(){
  const aoa = [
    ['Time', 'PO / Rel #', 'Driver', 'Grower / Origin', 'FB #', 'Commodity', 'Truck', 'Status', 'Extra'],
    ['', '', '', 46023, '', '', '', '', ''],
    ['', '', '', 'D.P. LATHROP', '', '', '', '', ''],
    ['9am', '75811-49', 'SAL', 'PNG', '192563', 'Barley-1850', '64/65', 'DELIVERED', ''],
    ['0.25', '75575-106', 'RAFA', 'PNG', '192886', 'Fava Beans-1623', '49/50', 'DELIVERED', '346-14']
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, DISPATCH_SHEET);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ignore']]), 'Other');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(buf);
}

async function call(env, path, opts){
  const res = await worker.fetch(new Request(ORIGIN + path, opts || { method: 'GET' }), env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch(_){}
  return { status: res.status, text, json, headers: res.headers };
}

async function postIngest(env, body, extraHeaders){
  const headers = { 'X-FCT-Key': INGEST_KEY, ...(extraHeaders || {}) };
  const req = new Request(ORIGIN + '/ingest', { method: 'POST', headers, body });
  if(!extraHeaders || !Object.keys(extraHeaders).some(k => k.toLowerCase() === 'content-type')){
    req.headers.delete('Content-Type');
  }
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch(_){}
  return { status: res.status, text, json, headers: res.headers };
}

function buildXlsxOnSheet(sheetName){
  const aoa = [
    ['Time', 'PO / Rel #', 'Driver', 'Grower / Origin', 'FB #', 'Commodity', 'Truck', 'Status', 'Extra'],
    ['', '', '', 46023, '', '', '', '', ''],
    ['9am', '75811-49', 'SAL', 'PNG', '192563', 'Barley-1850', '64/65', 'DELIVERED', '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

function buildXlsxNearBase64Len(targetLen){
  const aoa = [
    ['Time', 'PO / Rel #', 'Driver', 'Grower / Origin', 'FB #', 'Commodity', 'Truck', 'Status', 'Extra'],
    ['', '', '', 46023, '', '', '', '', ''],
    ['', '', '', 'D.P. LATHROP', '', '', '', '', ''],
    ['9am', '75811-49', 'SAL', 'PNG', '192563', 'Barley-1850', '64/65', 'DELIVERED', ''],
    ['0.25', '75575-106', 'RAFA', 'PNG', '192886', 'Fava Beans-1623', '49/50', 'DELIVERED', '346-14']
  ];
  const blob = 'Z'.repeat(4000);
  let buf = buildDispatchXlsx();
  for(let n = 0; n < 8000; n++){
    aoa.push(['9am', 'P' + n, 'SAL', 'PNG', '1', blob, '64/65', 'DELIVERED', 'x']);
    if(n % 10 !== 9) continue;
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, DISPATCH_SHEET);
    buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    if(buf.toString('base64').length >= targetLen) return buf;
  }
  return buf;
}

{
  assert.equal(WORKER_FIELDS.join(','), 'time,po,driver,origin,fb,commodity,truck,status,extra');
  const mapped = aoaToWorkerRows([['9am', '1', 'SAL', 'PNG', '192563', 'Barley', '64/65', 'DELIVERED', 'x']]);
  assert.equal(mapped[0].po, '1');
  assert.equal(mapped[0].extra, 'x');
}

{
  const req = { headers: { get: k => k === 'X-FCT-Key' ? INGEST_KEY : null } };
  assert.equal(ingestKeyOk(req, { INGEST_KEY }), true);
  assert.equal(ingestKeyOk({ headers: { get: () => null } }, { INGEST_KEY }), false);
  assert.equal(ingestKeyOk(req, { INGEST_KEY: '' }), false);
  assert.equal(ingestKeyOk({ headers: { get: () => 'nope' } }, { INGEST_KEY }), false);
}

{
  const rows = [{ time: '6am', po: '1', driver: 'HUGO', origin: 'PNG', fb: '1', commodity: 'Corn', truck: '1', status: 'DELIVERED', extra: '' }];
  const a = normalizeIngestJson({ rows });
  assert.equal(a.kind, 'rows');
  assert.equal(a.source, 'json');
  assert.equal(a.rows.length, 1);
  const b = normalizeIngestJson({ value: rows });
  assert.equal(b.kind, 'rows');
  assert.equal(b.rows[0].po, '1');
  const c = normalizeIngestJson(rows);
  assert.equal(c.kind, 'rows');
}

{
  assert.equal(normalizeIngestJson({ hello: 1 }).kind, 'bad');
  assert.equal(normalizeIngestJson(null).kind, 'bad');
  assert.equal(normalizeIngestJson({ hello: 1 }).error, 'no_rows_or_file');
}

{
  const p = latestPayloadFromRows([{ po: '1' }, { po: '2' }]);
  assert.equal(p.rowCount, 2);
  assert.ok(p.ingestedAt);
  assert.equal(p.rows[1].po, '2');
  assert.equal(Object.prototype.hasOwnProperty.call(p, 'format'), false);
}

{
  const xlsx = buildDispatchXlsx();
  assert.ok(looksLikeZipXlsx(xlsx));
  const b64 = xlsx.toString('base64');
  assert.ok(extractBase64FromEnvelope({ $content: b64 }).length > 20);
  assert.ok(extractBase64FromEnvelope({ fileContent: b64 }).length > 20);
  assert.ok(extractBase64FromEnvelope({ body: { $content: b64 } }).length > 20);
  assert.ok(extractBase64FromEnvelope({ fileContent: { $content: b64, '$content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }).length > 20);

  const n = normalizeIngestJson({
    '$content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    $content: b64,
    fileName: '2026 FCT Dispatch Log.xlsx'
  });
  assert.equal(n.kind, 'rows');
  assert.equal(n.source, 'xlsx');
  assert.equal(n.sheet, '2026');
  assert.ok(n.rows.length >= 4);
  assert.equal(n.rows[0].time, 'Time');
  assert.equal(n.rows[1].origin, '46023');
  assert.equal(n.rows[2].origin, 'D.P. LATHROP');
  assert.equal(n.rows[3].driver, 'SAL');
  assert.equal(n.rows[3].fb, '192563');
  assert.equal(n.rows[4].time, '0.25');
  assert.equal(n.rows[4].extra, '346-14');

  const decoded = decodeBase64(b64);
  assert.ok(looksLikeZipXlsx(decoded));
}

{
  const env = mockEnv();
  const rows = [
    { time: 'Time', po: 'PO / Rel #', driver: 'Driver', origin: 'Grower / Origin', fb: 'FB #', commodity: 'x', truck: '', status: '', extra: '' },
    { time: '', po: '', driver: '', origin: '46023', fb: '', commodity: '', truck: '', status: '', extra: '' },
    { time: '9am', po: '75811-49', driver: 'SAL', origin: 'PNG', fb: '192563', commodity: 'Barley-1850', truck: '64/65', status: 'DELIVERED', extra: '' }
  ];
  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: JSON.stringify({ rows })
  });
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.json.ok, true);
  assert.equal(posted.json.rowCount, 3);
  assert.ok(posted.json.ingestedAt);
  assert.equal(JSON.stringify(posted.json).includes(INGEST_KEY), false);

  const latest = await call(env, '/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.json.rowCount, 3);
  assert.equal(latest.json.rows[2].driver, 'SAL');
  assert.ok(latest.headers.get('Access-Control-Allow-Origin') === '*');
}

{
  const env = mockEnv();
  const valueRows = [{ time: '1pm', po: '2', driver: 'JOEL', origin: 'PNG', fb: '9', commodity: 'Barley', truck: '', status: '', extra: '' }];
  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: JSON.stringify({ value: valueRows })
  });
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.json.rowCount, 1);
}

{
  const env = mockEnv();
  const xlsx = buildDispatchXlsx();
  const envelope = {
    '$content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    $content: xlsx.toString('base64')
  };
  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: JSON.stringify(envelope)
  });
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.json.ok, true);
  assert.ok(posted.json.rowCount >= 4, 'xlsx ingest should return rowCount');
  assert.equal(JSON.stringify(posted.json).includes(INGEST_KEY), false);

  const latest = await call(env, '/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.json.rows[3].po, '75811-49');
  assert.equal(latest.json.rows[1].origin, '46023');
}

{
  const env = mockEnv();
  const xlsx = buildDispatchXlsx();
  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'X-FCT-Key': INGEST_KEY
    },
    body: xlsx
  });
  assert.equal(posted.status, 200, posted.text);
  assert.ok(posted.json.rowCount >= 4);
}

{
  const env = mockEnv();
  const xlsx = buildDispatchXlsx();
  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: JSON.stringify({ body: { $content: xlsx.toString('base64'), fileName: '2026 FCT Dispatch Log.xlsx' } })
  });
  assert.equal(posted.status, 200, posted.text);
  assert.ok(posted.json.rowCount >= 4);
}

{
  const env = mockEnv();
  const bad = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: '{not json'
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_json');
  assert.equal(JSON.stringify(bad.json).includes(INGEST_KEY), false);
}

{
  const env = mockEnv();
  const unauth = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [{ po: '1' }] })
  });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.json.error, 'unauthorized');
}

{
  const env = mockEnv();
  const latest = await call(env, '/latest');
  assert.equal(latest.status, 404);
  const health = await call(env, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  const opt = await call(env, '/ingest', { method: 'OPTIONS' });
  assert.ok(opt.status === 200 || opt.status === 204);
  assert.equal(opt.headers.get('Access-Control-Allow-Origin'), '*');
}

{
  const env = mockEnv();
  const junk = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: JSON.stringify({ hello: 1 })
  });
  assert.equal(junk.status, 400);

  const notXlsx = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: JSON.stringify({
      '$content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      $content: Buffer.from('this is not an xlsx file at all!!').toString('base64')
    })
  });
  assert.equal(notXlsx.status, 400);
  assert.equal(notXlsx.json.error, 'bad_xlsx');
}

{
  const xlsx = buildDispatchXlsx();
  const b64 = xlsx.toString('base64');
  const paBody = '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","$content":"' + b64 + '"}';
  assert.equal(JSON.parse(paBody).$content.slice(0, 6), 'UEsDBB');
  const fromRaw = rowsFromRawEnvelopeText(paBody);
  assert.equal(fromRaw.kind, 'rows');
  assert.equal(fromRaw.source, 'xlsx');
  assert.ok(fromRaw.rows.length >= 4);
}

{
  const env = mockEnv();
  const xlsx = buildDispatchXlsx();
  const b64 = xlsx.toString('base64');
  const mid = Math.max(8, Math.floor(b64.length / 2));
  const broken = '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","$content":"'
    + b64.slice(0, mid) + '\n' + b64.slice(mid) + '"}';
  let parseFailed = false;
  try { JSON.parse(broken); } catch(_){ parseFailed = true; }
  assert.equal(parseFailed, true, 'fixture must be invalid JSON (unescaped newline in $content)');
  assert.ok(extractBase64FromMalformed(broken).replace(/\s+/g, '').length > 20);
  assert.ok(extractBase64ZipFromText(broken).startsWith('UEsDBB'));

  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: broken
  });
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.json.ok, true);
  assert.ok(posted.json.rowCount >= 4);

  const latest = await call(env, '/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.json.rows[3].po, '75811-49');
  assert.ok(latest.json.ingestedAt);
  assert.equal(Object.prototype.hasOwnProperty.call(latest.json, 'format'), false);
}

{
  const env = mockEnv();
  const xlsx = buildDispatchXlsx();
  const envelope = JSON.stringify({
    '$content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    $content: xlsx.toString('base64')
  });
  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-16', 'X-FCT-Key': INGEST_KEY },
    body: Buffer.from(envelope, 'utf16le')
  });
  assert.equal(posted.status, 200, posted.text);
  assert.ok(posted.json.rowCount >= 4);
}

{
  const env = mockEnv();
  const xlsx = buildDispatchXlsx();
  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FCT-Key': INGEST_KEY },
    body: JSON.stringify({
      '$content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      $content: xlsx.toString('latin1')
    })
  });
  assert.equal(posted.status, 200, posted.text);
  assert.ok(posted.json.rowCount >= 4);
  const latest = await call(env, '/latest');
  assert.equal(latest.json.rows[3].driver, 'SAL');
}

{
  const env = mockEnv();
  const xlsx = buildDispatchXlsx();
  const posted = await call(env, '/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-FCT-Key': INGEST_KEY },
    body: xlsx.toString('base64')
  });
  assert.equal(posted.status, 200, posted.text);
  assert.ok(posted.json.rowCount >= 4);
}

{
  const typeOnly = '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}';
  assert.equal(extractBase64FromMalformed(typeOnly), '');
  const b64 = buildDispatchXlsx().toString('base64');
  const pa = '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","$content":"' + b64 + '"}';
  const extracted = extractBase64FromMalformed(pa);
  assert.equal(extracted, b64);
  assert.equal(extracted.slice(0, 6), 'UEsDBB');
  assert.ok(!extracted.includes('spreadsheet'));
}

{
  const env = mockEnv();
  const xlsx = buildXlsxOnSheet('2026 New');
  const posted = await postIngest(env, JSON.stringify({
    '$content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    $content: xlsx.toString('base64')
  }));
  assert.equal(posted.status, 200, posted.text);
  assert.ok(posted.json.rowCount >= 3);
  const latest = await call(env, '/latest');
  assert.equal(latest.json.rows[2].po, '75811-49');
}

{
  const env = mockEnv();
  const xlsx = buildXlsxNearBase64Len(785008);
  const b64 = xlsx.toString('base64');
  assert.ok(b64.length >= 785008, 'need ~785k-char $content, got ' + b64.length);
  assert.equal(b64.slice(0, 6), 'UEsDBB');
  const decoded = decodeBase64(b64);
  assert.ok(looksLikeZipXlsx(decoded));
  assert.equal(decoded[2], 0x03);
  assert.equal(decoded[3], 0x04);

  const paBody = '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","$content":"' + b64 + '"}';
  assert.ok(Math.abs(JSON.parse(paBody).$content.length - b64.length) < 1);
  const fromBytes = extractBase64ZipFromBytes(Buffer.from(paBody, 'utf8'));
  assert.equal(fromBytes.slice(0, 6), 'UEsDBB');
  assert.equal(fromBytes.length, b64.length);

  const req = new Request(ORIGIN + '/ingest', {
    method: 'POST',
    headers: { 'X-FCT-Key': INGEST_KEY },
    body: paBody
  });
  req.headers.delete('Content-Type');
  assert.equal(req.headers.get('Content-Type'), null);

  const posted = await postIngest(env, paBody);
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.json.ok, true);
  assert.ok(posted.json.rowCount >= 4, 'rowCount ' + posted.json.rowCount);

  const latest = await call(env, '/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.json.rows[3].po, '75811-49');
  assert.ok(latest.json.ingestedAt);
  assert.equal(Object.prototype.hasOwnProperty.call(latest.json, 'format'), false);
}

{
  const env = mockEnv();
  const xlsx = buildXlsxNearBase64Len(785008);
  const b64 = xlsx.toString('base64');
  assert.ok(b64.length >= 785008, 'need ~785k-char $content, got ' + b64.length);
  assert.equal(b64.slice(0, 6), 'UEsDBB');
  const paBody = '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","$content":"' + b64 + '"}';
  const utf16 = Buffer.from(paBody, 'utf16le');
  assert.equal(utf16[0], 0x7b);
  assert.equal(utf16[1], 0x00);
  assert.ok(!utf16.includes(Buffer.from('UEsDBB')));
  const collapsed = collapseUtf16Ascii(utf16);
  assert.ok(collapsed.startsWith('{"$content-type"'));
  assert.ok(collapsed.includes('UEsDBB'));
  const fromBytes = extractBase64ZipFromBytes(utf16);
  assert.equal(fromBytes.slice(0, 6), 'UEsDBB');
  assert.equal(fromBytes.length, b64.length);

  const req = new Request(ORIGIN + '/ingest', {
    method: 'POST',
    headers: { 'X-FCT-Key': INGEST_KEY },
    body: utf16
  });
  req.headers.delete('Content-Type');
  assert.equal(req.headers.get('Content-Type'), null);

  const posted = await postIngest(env, utf16);
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.json.ok, true);
  assert.ok(posted.json.rowCount >= 4, 'rowCount ' + posted.json.rowCount);

  const latest = await call(env, '/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.json.rows[3].po, '75811-49');
}

{
  const env = mockEnv();
  const xlsx = buildDispatchXlsx();
  const paBody = '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","$content":"'
    + xlsx.toString('base64') + '"}';
  const utf16 = Buffer.from(paBody, 'utf16le');
  const posted = await postIngest(env, utf16, { 'Content-Type': 'application/json; charset=utf-16' });
  assert.equal(posted.status, 200, posted.text);
  assert.ok(posted.json.rowCount >= 4);
}

{
  const env = mockEnv();
  const paBody = '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","$content":"'
    + Buffer.from('this is not an xlsx file at all!!').toString('base64') + '"}';
  const posted = await postIngest(env, Buffer.from(paBody, 'utf16le'));
  assert.equal(posted.status, 400, posted.text);
  assert.equal(posted.json.error, 'bad_xlsx');
}

console.log('ingest.test.mjs ok');
