/* Pure Workers runtime: no Buffer, TextDecoder utf-8 only, no nodejs_compat.
 * Parent process builds the 785k PA envelope with Node/xlsx, then a child
 * deletes Buffer and restricts TextDecoder before importing the worker. */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const DISPATCH_SHEET = '2026';
const INGEST_KEY = 'test-ingest-key-not-for-prod';
const ORIGIN = 'https://fct-dispatch.jamesgrunsky.workers.dev';

if(process.env.FCT_WEB_RUNTIME === '1'){
  await runPureWorkersRuntime();
} else {
  await runParent();
}

async function buildPaEnvelope(targetLen){
  const XLSX = await import('xlsx');
  const aoa = [
    ['Time', 'PO / Rel #', 'Driver', 'Grower / Origin', 'FB #', 'Commodity', 'Truck', 'Status', 'Extra'],
    ['', '', '', 46023, '', '', '', '', ''],
    ['', '', '', 'D.P. LATHROP', '', '', '', '', ''],
    ['9am', '75811-49', 'SAL', 'PNG', '192563', 'Barley-1850', '64/65', 'DELIVERED', ''],
    ['0.25', '75575-106', 'RAFA', 'PNG', '192886', 'Fava Beans-1623', '49/50', 'DELIVERED', '346-14']
  ];
  const blob = 'Z'.repeat(4000);
  let b64 = '';
  for(let n = 0; n < 8000; n++){
    aoa.push(['9am', 'P' + n, 'SAL', 'PNG', '1', blob, '64/65', 'DELIVERED', 'x']);
    if(n % 10 !== 9) continue;
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, DISPATCH_SHEET);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    b64 = Buffer.from(buf).toString('base64');
    if(b64.length >= targetLen) break;
  }
  assert.ok(b64.length >= targetLen, 'need ~785k-char $content, got ' + b64.length);
  assert.equal(b64.slice(0, 6), 'UEsDBB');
  return '{"$content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","$content":"'
    + b64 + '"}';
}

async function runParent(){
  const paBody = await buildPaEnvelope(785008);
  const dir = mkdtempSync(join(tmpdir(), 'fct-web-'));
  const bodyPath = join(dir, 'envelope.json');
  writeFileSync(bodyPath, paBody);
  const child = spawnSync(process.execPath, [here], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, FCT_WEB_RUNTIME: '1', FCT_ENVELOPE_PATH: bodyPath },
    cwd: join(dirname(here), '..')
  });
  rmSync(dir, { recursive: true, force: true });
  if(child.status !== 0){
    process.stderr.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    process.exit(child.status || 1);
  }
  process.stdout.write(child.stdout);
}

async function runPureWorkersRuntime(){
  const OrigTD = globalThis.TextDecoder;
  globalThis.TextDecoder = class RestrictedTextDecoder {
    constructor(label, options){
      const l = String(label == null ? 'utf-8' : label).toLowerCase().replace(/_/g, '-');
      if(l && l !== 'utf-8' && l !== 'utf8' && l !== 'unicode-1-1-utf-8'){
        throw new RangeError('The encoding label provided (\'' + label + '\') is invalid.');
      }
      this.encoding = 'utf-8';
      this.fatal = false;
      this.ignoreBOM = false;
      this._inner = new OrigTD('utf-8', options);
    }
    decode(input, options){
      return this._inner.decode(input, options);
    }
  };
  delete globalThis.Buffer;
  assert.equal(typeof globalThis.Buffer, 'undefined');

  /* Node's Request/Response pull in undici, which needs Buffer. Workers do not. */
  globalThis.Response = class {
    constructor(body, init){
      this.status = (init && init.status) || 200;
      this.headers = {
        _m: Object.create(null),
        get(k){ return this._m[String(k).toLowerCase()] ?? null; },
        set(k, v){ this._m[String(k).toLowerCase()] = String(v); }
      };
      if(init && init.headers){
        for(const [k, v] of Object.entries(init.headers)) this.headers.set(k, v);
      }
      this._body = body == null ? '' : String(body);
    }
    async text(){ return this._body; }
  };

  const { default: worker } = await import('./index.js');
  const paBody = readFileSync(process.env.FCT_ENVELOPE_PATH, 'utf8');
  assert.ok(paBody.includes('"$content"'));
  assert.ok(paBody.includes('UEsDBB'));
  const parsed = JSON.parse(paBody);
  assert.ok(parsed.$content.length >= 785008);
  assert.equal(parsed.$content.slice(0, 6), 'UEsDBB');

  const store = new Map();
  const env = {
    INGEST_KEY,
    DISPATCH: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => { store.set(k, v); }
    }
  };

  const u8 = new TextEncoder().encode(paBody);
  const raw = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const req = {
    method: 'POST',
    url: ORIGIN + '/ingest',
    headers: {
      get(name){
        return String(name).toLowerCase() === 'x-fct-key' ? INGEST_KEY : null;
      }
    },
    async arrayBuffer(){ return raw.slice(0); }
  };
  assert.equal(req.headers.get('Content-Type'), null);

  const res = await worker.fetch(req, env);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch(_){}
  assert.equal(res.status, 200, text);
  assert.notEqual(json && json.error, 'bad_json', text);
  assert.notEqual(json && json.error, 'bad_xlsx', text);
  assert.equal(json.ok, true);
  assert.ok(json.rowCount >= 4, 'rowCount ' + json.rowCount);
  console.log('ingest.web.test.mjs ok (pure Workers, 785k envelope, no Content-Type)');
}
