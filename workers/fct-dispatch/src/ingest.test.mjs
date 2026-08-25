import { strict as assert } from 'node:assert';
import {
  ingestKeyFrom, normalizeIngestJson, decodeBase64, looksLikeZipXlsx,
  latestPayloadFromRows, latestPayloadFromXlsx, isHttpsUrl, readIngestRequest
} from './ingest.js';

function fakeRequest(headers){
  return { headers: { get: k => headers[k] || headers[k.toLowerCase()] || null } };
}

{
  const env = { INGEST_KEY: 'secret-pa' };
  assert.equal(ingestKeyFrom(fakeRequest({ 'X-FCT-Key': 'secret-pa' }), env).ok, true);
  assert.equal(ingestKeyFrom(fakeRequest({ 'X-Ingest-Key': 'secret-pa' }), env).ok, true);
  assert.equal(ingestKeyFrom(fakeRequest({ 'X-FCT-Key': 'nope' }), env).ok, false);
  assert.equal(ingestKeyFrom(fakeRequest({}), env).ok, false);
  assert.equal(ingestKeyFrom(fakeRequest({ 'X-FCT-Key': 'secret-pa' }), {}).ok, false);
  assert.equal(ingestKeyFrom(fakeRequest({ 'X-FCT-Key': 'secret-pa' }), { INGEST_KEY: '' }).ok, false);
}

{
  const rows = [{ time:'6am', po:'1', driver:'HUGO', origin:'PNG' }];
  const a = normalizeIngestJson({ rows });
  assert.equal(a.kind, 'rows');
  assert.equal(a.rows.length, 1);
  const b = normalizeIngestJson({ value: rows });
  assert.equal(b.kind, 'rows');
  assert.equal(b.rows[0].po, '1');
  const c = normalizeIngestJson(rows);
  assert.equal(c.kind, 'rows');
}

{
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);
  let b64 = '';
  bytes.forEach(n => { b64 += String.fromCharCode(n); });
  b64 = Buffer.from(bytes).toString('base64');
  const n = normalizeIngestJson({ $content: b64, fileName: '2026 FCT Dispatch Log.xlsx' });
  assert.equal(n.kind, 'xlsx');
  assert.equal(n.fileName, '2026 FCT Dispatch Log.xlsx');
  assert.ok(looksLikeZipXlsx(n.bytes));
  const n2 = normalizeIngestJson({ fileBase64: b64 });
  assert.equal(n2.kind, 'xlsx');
  const n3 = normalizeIngestJson({ body: { $content: b64, fileName: 'log.xlsx' } });
  assert.equal(n3.kind, 'xlsx');
  assert.equal(n3.fileName, 'log.xlsx');
}

{
  assert.equal(normalizeIngestJson({ hello: 1 }).kind, 'bad');
  assert.equal(normalizeIngestJson(null).kind, 'bad');
}

{
  const p = latestPayloadFromRows([{ po:'1' }, { po:'2' }]);
  assert.equal(p.format, 'rows');
  assert.equal(p.rowCount, 2);
  assert.ok(p.ingestedAt);
  const x = latestPayloadFromXlsx('2026 FCT Dispatch Log.xlsx');
  assert.equal(x.format, 'xlsx');
  assert.equal(x.rows.length, 0);
  assert.equal(x.fileName, '2026 FCT Dispatch Log.xlsx');
}

{
  assert.equal(isHttpsUrl('https://prod-12.westus.logic.azure.com/workflows/abc'), true);
  assert.equal(isHttpsUrl('http://evil.example/'), false);
  assert.equal(isHttpsUrl('not-a-url'), false);
}

{
  const raw = Buffer.from('PK\x03\x04hello-xlsx');
  const req = {
    headers: { get: k => k.toLowerCase()==='content-type' ? 'application/octet-stream' : null },
    arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  };
  const parsed = await readIngestRequest(req);
  assert.equal(parsed.kind, 'xlsx');
  assert.ok(looksLikeZipXlsx(parsed.bytes));
}

{
  const decoded = decodeBase64(Buffer.from('hello').toString('base64'));
  assert.equal(Buffer.from(decoded).toString(), 'hello');
}

console.log('ingest.test.mjs ok');
