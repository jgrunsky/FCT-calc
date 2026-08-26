/* POST /ingest body → { rows } for GET /latest.
 *
 * Accepts:
 *   1. Office Script JSON  { rows: [...] } or { value: [...] } (or a top-level array)
 *   2. Power Automate / OneDrive Get file content envelopes
 *      ($content / fileContent / body base64 xlsx)
 *   3. Raw xlsx bytes (PK zip magic)
 *
 * Never log or return the ingest key.
 */
import { xlsxBytesToRows, DEFAULT_XLSX_NAME } from './xlsx-rows.js';

export const KV_LATEST = 'latest';

export function ingestKeyOk(request, env){
  const key = request.headers.get('X-FCT-Key');
  const expected = env && env.INGEST_KEY;
  return !!(expected && key === expected);
}

export function looksLikeZipXlsx(bytes){
  if(!bytes || bytes.length < 4) return false;
  return bytes[0] === 0x50 && bytes[1] === 0x4b; // PK
}

export function decodeBase64(b64){
  const clean = String(b64 || '').replace(/\s+/g, '').replace(/^data:[^;]+;base64,/i, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asObj(v){
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function longString(v){
  return (typeof v === 'string' && v.replace(/\s+/g, '').length > 20) ? v : '';
}

/* OneDrive Get file content / HTTP body wrappers used by Flow 1. */
export function extractBase64FromEnvelope(body){
  if(typeof body === 'string') return longString(body);
  const o = asObj(body);
  if(!o) return '';
  const fileContent = o.fileContent;
  const inner = asObj(o.body);
  const nestedFile = asObj(fileContent);
  return longString(o.$content)
    || longString(o.fileBase64)
    || longString(o.file_content)
    || longString(o.contentBytes)
    || longString(typeof fileContent === 'string' ? fileContent : '')
    || longString(nestedFile && nestedFile.$content)
    || longString(nestedFile && nestedFile.contentBytes)
    || longString(typeof o.body === 'string' ? o.body : '')
    || longString(inner && inner.$content)
    || longString(inner && inner.fileBase64)
    || longString(inner && inner.contentBytes)
    || longString(inner && typeof inner.fileContent === 'string' ? inner.fileContent : '')
    || longString(asObj(inner && inner.fileContent) && asObj(inner.fileContent).$content)
    || '';
}

export function envelopeFileName(body){
  const o = asObj(body) || {};
  const inner = asObj(o.body) || {};
  const fileContent = asObj(o.fileContent) || {};
  return o.fileName || o.name || o.file_name
    || fileContent.fileName
    || inner.fileName
    || DEFAULT_XLSX_NAME;
}

function asRows(raw){
  return Array.isArray(raw) ? raw : null;
}

export function rowsFromXlsxBytes(bytes, fileName){
  const parsed = xlsxBytesToRows(bytes);
  return {
    kind: 'rows',
    source: 'xlsx',
    rows: parsed.rows,
    fileName: fileName || parsed.fileName,
    sheet: parsed.sheetName
  };
}

export function normalizeIngestJson(body){
  if(typeof body === 'string'){
    const b64 = longString(body);
    if(!b64) return { kind: 'bad', error: 'bad_json' };
    try {
      const bytes = decodeBase64(b64);
      if(!looksLikeZipXlsx(bytes)) return { kind: 'bad', error: 'bad_xlsx' };
      return rowsFromXlsxBytes(bytes, DEFAULT_XLSX_NAME);
    } catch(_){
      return { kind: 'bad', error: 'bad_xlsx' };
    }
  }
  if(body == null) return { kind: 'bad', error: 'bad_json' };

  const b64 = extractBase64FromEnvelope(body);
  if(b64){
    try {
      const bytes = decodeBase64(b64);
      if(!looksLikeZipXlsx(bytes)) return { kind: 'bad', error: 'bad_xlsx' };
      return rowsFromXlsxBytes(bytes, envelopeFileName(body));
    } catch(_){
      return { kind: 'bad', error: 'bad_xlsx' };
    }
  }

  const rows = asRows(body.rows)
    || asRows(body.value)
    || (asObj(body.body) && (asRows(body.body.rows) || asRows(body.body.value)))
    || (Array.isArray(body) ? body : null);
  if(rows){
    return {
      kind: 'rows',
      source: 'json',
      rows,
      fileName: (asObj(body) && (body.fileName || body.name)) || 'worker · /latest'
    };
  }
  return { kind: 'bad', error: 'no_rows_or_file' };
}

export async function readIngestRequest(request){
  const buf = new Uint8Array(await request.arrayBuffer());
  if(looksLikeZipXlsx(buf)){
    try {
      const cd = request.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      const fileName = (m && m[1])
        ? decodeURIComponent(m[1].replace(/"/g, ''))
        : DEFAULT_XLSX_NAME;
      return rowsFromXlsxBytes(buf, fileName);
    } catch(_){
      return { kind: 'bad', error: 'bad_xlsx' };
    }
  }
  let text;
  try {
    text = new TextDecoder().decode(buf).replace(/^\uFEFF/, '').trim();
  } catch(_){
    return { kind: 'bad', error: 'bad_json' };
  }
  if(!text) return { kind: 'bad', error: 'bad_json' };
  let body;
  try {
    body = JSON.parse(text);
  } catch(_){
    return { kind: 'bad', error: 'bad_json' };
  }
  return normalizeIngestJson(body);
}

export function latestPayloadFromRows(rows){
  const list = Array.isArray(rows) ? rows : [];
  return {
    rows: list,
    ingestedAt: new Date().toISOString(),
    rowCount: list.length
  };
}
