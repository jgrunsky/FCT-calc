/* Power Automate → Worker ingest.
 * Accepts JSON rows (Excel List rows) or file bytes from consumer
 * OneDrive Get file content ($content / raw xlsx). Auth is INGEST_KEY
 * via X-FCT-Key. The calc still parses through parseDispatchRows /
 * ingestWorkbook. */

export const KV_LATEST = 'latest';
export const KV_LATEST_XLSX = 'latest-xlsx';

export function ingestKeyFrom(request, env){
  const header = (request.headers.get('X-FCT-Key')
    || request.headers.get('X-Ingest-Key')
    || '').trim();
  const expected = String((env && env.INGEST_KEY) || '').trim();
  return { ok: !!(expected && header && header === expected) };
}

export function decodeBase64(b64){
  const clean = String(b64||'').replace(/\s+/g,'').replace(/^data:[^;]+;base64,/i,'');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function looksLikeZipXlsx(bytes){
  if(!bytes || bytes.length < 4) return false;
  return bytes[0]===0x50 && bytes[1]===0x4b; // PK
}

function asRows(raw){
  if(Array.isArray(raw)) return raw;
  return null;
}

export function normalizeIngestJson(body){
  if(body==null) return { kind:'bad', error:'bad_json' };

  const b64 = body.fileBase64 || body.file_content || body.$content
    || (body.body && (body.body.fileBase64 || body.body.$content));
  const fileName = body.fileName || body.name || body.file_name
    || (body.body && body.body.fileName) || 'dispatch.xlsx';
  if(typeof b64 === 'string' && b64.replace(/\s+/g,'').length > 4){
    return { kind:'xlsx', fileName, bytes: decodeBase64(b64) };
  }

  const rows = asRows(body.rows) || asRows(body.value)
    || (body.body && (asRows(body.body.rows) || asRows(body.body.value)))
    || (Array.isArray(body) ? body : null);
  if(rows){
    return { kind:'rows', rows, fileName: body.fileName || 'worker · /latest' };
  }
  return { kind:'bad', error:'no_rows_or_file' };
}

export async function readIngestRequest(request){
  const ct = String(request.headers.get('Content-Type') || '').toLowerCase();
  if(ct.includes('json')){
    let body;
    try { body = await request.json(); }
    catch(_){ return { kind:'bad', error:'bad_json' }; }
    return normalizeIngestJson(body);
  }
  const buf = new Uint8Array(await request.arrayBuffer());
  if(looksLikeZipXlsx(buf)){
    const cd = request.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const fileName = (m && m[1]) ? decodeURIComponent(m[1].replace(/"/g,'')) : 'dispatch.xlsx';
    return { kind:'xlsx', fileName, bytes: buf };
  }
  try {
    const text = new TextDecoder().decode(buf);
    const trimmed = text.trim();
    if(trimmed.startsWith('{') || trimmed.startsWith('[')){
      return normalizeIngestJson(JSON.parse(trimmed));
    }
  } catch(_){}
  return { kind:'bad', error:'unsupported_content_type' };
}

export function latestPayloadFromRows(rows, extra){
  const list = Array.isArray(rows) ? rows : [];
  return {
    format: 'rows',
    rows: list,
    ingestedAt: new Date().toISOString(),
    rowCount: list.length,
    ...(extra || {})
  };
}

export function latestPayloadFromXlsx(fileName, extra){
  return {
    format: 'xlsx',
    rows: [],
    fileName: fileName || 'dispatch.xlsx',
    ingestedAt: new Date().toISOString(),
    rowCount: 0,
    ...(extra || {})
  };
}

export function isHttpsUrl(u){
  try {
    const x = new URL(String(u||''));
    return x.protocol === 'https:';
  } catch(_){ return false; }
}
