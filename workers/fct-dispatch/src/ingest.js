/* POST /ingest body → { rows } for GET /latest.
 *
 * Accepts:
 *   1. Office Script JSON  { rows: [...] } or { value: [...] } (or a top-level array)
 *   2. Power Automate / OneDrive Get file content envelopes
 *      ($content / fileContent / body base64 xlsx) — including the PA HTTP
 *      body `{"$content-type":"...spreadsheetml.sheet","$content":"UEs..."}`
 *      even when that JSON is malformed (unescaped newlines) or too large
 *      to JSON.parse before extracting $content
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

export function looksLikeSpreadsheetContentType(ct){
  const s = String(ct || '').toLowerCase();
  return s.includes('spreadsheet')
    || s.includes('excel')
    || s.includes('officedocument.spreadsheetml')
    || /\bxlsx\b/.test(s);
}

export function decodeBase64(b64){
  let clean = String(b64 || '').replace(/\s+/g, '').replace(/^data:[^;]+;base64,/i, '');
  clean = clean.replace(/-/g, '+').replace(/_/g, '/');
  while(clean.length % 4) clean += '=';
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

function coerceJson(v){
  if(typeof v !== 'string') return v;
  const s = v.trim();
  if((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))){
    try { return JSON.parse(s); } catch(_){}
  }
  return v;
}

export function latin1ToBytes(s){
  const str = String(s || '');
  const out = new Uint8Array(str.length);
  for(let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255;
  return out;
}

/* $content may be base64 xlsx, double-encoded base64, or a latin1/binary PK string. */
export function bytesFromContentString(s){
  if(typeof s !== 'string' || !s) return null;
  if(s.length >= 4 && s.charCodeAt(0) === 0x50 && s.charCodeAt(1) === 0x4b){
    const raw = latin1ToBytes(s);
    return looksLikeZipXlsx(raw) ? raw : null;
  }
  try {
    let bytes = decodeBase64(s);
    if(!looksLikeZipXlsx(bytes)){
      try {
        const inner = new TextDecoder().decode(bytes).replace(/\s+/g, '');
        if(inner.length > 20){
          const twice = decodeBase64(inner);
          if(looksLikeZipXlsx(twice)) bytes = twice;
        }
      } catch(_){}
    }
    return looksLikeZipXlsx(bytes) ? bytes : null;
  } catch(_){
    return null;
  }
}

function bufferDataBytes(v){
  const o = asObj(v);
  const data = o && Array.isArray(o.data) ? o.data : Array.isArray(v) ? v : null;
  if(!data || data.length < 4) return null;
  if(typeof data[0] !== 'number') return null;
  const out = new Uint8Array(data.length);
  for(let i = 0; i < data.length; i++) out[i] = data[i] & 255;
  return looksLikeZipXlsx(out) ? out : null;
}

/* Pull base64 xlsx out of broken JSON / XML without JSON.parse. */
export function extractBase64FromMalformed(text){
  const s = String(text || '');
  const xml = s.match(/<\$content>([\s\S]*?)<\/\$content>/i);
  if(xml) return longString(xml[1]);

  let i = s.search(/"\$content"\s*:/);
  if(i < 0) i = s.search(/(?:^|[,{\s])\$content\s*:/);
  if(i < 0) return '';
  const colon = s.indexOf(':', i);
  if(colon < 0) return '';
  let j = colon + 1;
  while(j < s.length && /\s/.test(s[j])) j++;
  if(s[j] === '"'){
    j++;
    let out2 = '';
    for(; j < s.length; j++){
      const c = s[j];
      if(c === '\\'){
        const n = s[j + 1];
        if(n === 'n' || n === 'r' || n === 't'){ j++; continue; }
        if(n){ out2 += n; j++; }
        continue;
      }
      if(c === '"') break;
      if(c === '\n' || c === '\r') continue;
      out2 += c;
    }
    return longString(out2);
  }
  let out = '';
  for(; j < s.length; j++){
    const c = s[j];
    if(c === ',' || c === '}' || c === '<' || c === '\n' || c === '\r') break;
    out += c;
  }
  return longString(out);
}

/* PK zip as base64 always starts UEsDBB (PK\x03\x04). Scan even if keys are missing. */
export function extractBase64ZipFromText(text){
  const s = String(text || '');
  const needle = 'UEsDBB';
  const i = s.indexOf(needle);
  if(i < 0) return '';
  let out = '';
  for(let j = i; j < s.length; j++){
    const c = s[j];
    if(/[A-Za-z0-9+/=_-]/.test(c)) out += c;
    else if(/\s/.test(c)) continue;
    else break;
  }
  return longString(out);
}

function decodeRequestText(buf){
  if(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe){
    try {
      return new TextDecoder('utf-16le').decode(buf).replace(/^\uFEFF/, '').trim();
    } catch(_){}
  }
  /* `{ \0 " \0 $ \0 c \0 …` — UTF-16LE JSON without BOM. Do this before
     UTF-8: a UTF-16LE `{` still decodes as `{` plus NULs under UTF-8. */
  if(buf.length >= 4 && buf[0] === 0x7b && buf[1] === 0x00 && buf[3] === 0x00){
    try {
      return new TextDecoder('utf-16le').decode(buf).replace(/^\uFEFF/, '').trim();
    } catch(_){}
  }
  try {
    return new TextDecoder().decode(buf).replace(/^\uFEFF/, '').trim();
  } catch(_){
    return '';
  }
}

function findZipOffset(buf){
  if(!buf || buf.length < 4) return -1;
  for(let i = 0; i <= buf.length - 4; i++){
    if(buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04){
      return i;
    }
  }
  return -1;
}

/* OneDrive Get file content / HTTP body wrappers used by Flow 1. */
export function extractBase64FromEnvelope(body, depth){
  depth = depth || 0;
  if(depth > 6) return '';
  body = coerceJson(body);
  if(typeof body === 'string') return longString(body);
  const o = asObj(body);
  if(!o) return '';
  if(asObj(o.$content) || Array.isArray(o.$content)){
    const nested = extractBase64FromEnvelope(o.$content, depth + 1);
    if(nested) return nested;
  }
  const fileContent = o.fileContent;
  const inner = asObj(o.body) || (typeof o.body === 'string' ? asObj(coerceJson(o.body)) : null);
  const nestedFile = asObj(fileContent);
  const bodyJson = typeof o.body === 'string' ? coerceJson(o.body) : o.body;
  return longString(o.$content)
    || longString(o.fileBase64)
    || longString(o.file_content)
    || longString(o.contentBytes)
    || longString(o.content)
    || longString(typeof fileContent === 'string' ? fileContent : '')
    || longString(nestedFile && nestedFile.$content)
    || longString(nestedFile && nestedFile.contentBytes)
    || (typeof bodyJson === 'string' ? longString(bodyJson) : '')
    || (asObj(bodyJson) ? extractBase64FromEnvelope(bodyJson, depth + 1) : '')
    || longString(inner && inner.$content)
    || longString(inner && inner.fileBase64)
    || longString(inner && inner.contentBytes)
    || longString(inner && typeof inner.fileContent === 'string' ? inner.fileContent : '')
    || longString(asObj(inner && inner.fileContent) && asObj(inner.fileContent).$content)
    || '';
}

export function envelopeFileName(body){
  const o = asObj(coerceJson(body)) || {};
  const inner = asObj(o.body) || asObj(coerceJson(o.body)) || {};
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

export function rowsFromXlsxB64(b64, fileName){
  if(!b64) return null;
  const bytes = bytesFromContentString(b64);
  if(!bytes) return { kind: 'bad', error: 'bad_xlsx' };
  try {
    return rowsFromXlsxBytes(bytes, fileName || DEFAULT_XLSX_NAME);
  } catch(_){
    return { kind: 'bad', error: 'bad_xlsx' };
  }
}

function envelopeContentType(body){
  const o = asObj(coerceJson(body));
  if(!o) return '';
  return o['$content-type'] || o.contentType || o.content_type || '';
}

function base64ToZipBytes(b64){
  if(!b64) return null;
  try {
    const bytes = decodeBase64(b64);
    return looksLikeZipXlsx(bytes) ? bytes : null;
  } catch(_){
    return null;
  }
}

/* Raw POST text → xlsx rows for a PA $content / UEsDBB envelope.
 * Only base64→zip here (not latin1 PK): JSON-escaped binary $content must
 * JSON.parse first. Returns null so the caller can parse or fall through. */
export function rowsFromRawEnvelopeText(text){
  const s = String(text || '').trim();
  if(!s) return null;
  const b64 = extractBase64FromMalformed(s) || extractBase64ZipFromText(s);
  const bytes = base64ToZipBytes(b64);
  if(!bytes) return null;
  try {
    return rowsFromXlsxBytes(bytes, DEFAULT_XLSX_NAME);
  } catch(_){
    return null;
  }
}

export function normalizeIngestJson(body, depth){
  depth = depth || 0;
  if(depth > 6) return { kind: 'bad', error: 'bad_json' };
  if(typeof body === 'string'){
    const coerced = coerceJson(body);
    if(coerced !== body) return normalizeIngestJson(coerced, depth + 1);
    const fromRaw = rowsFromRawEnvelopeText(body);
    if(fromRaw) return fromRaw;
    const b64 = longString(body);
    if(!b64) return { kind: 'bad', error: 'bad_json' };
    return rowsFromXlsxB64(b64, DEFAULT_XLSX_NAME);
  }
  if(body == null) return { kind: 'bad', error: 'bad_json' };

  const fromBuf = bufferDataBytes(body.$content) || bufferDataBytes(body);
  if(fromBuf) return rowsFromXlsxBytes(fromBuf, envelopeFileName(body));

  const raw = extractBase64FromEnvelope(body);
  if(raw){
    const bytes = bytesFromContentString(raw);
    if(bytes) return rowsFromXlsxBytes(bytes, envelopeFileName(body));
    if(looksLikeSpreadsheetContentType(envelopeContentType(body)) || body.$content != null){
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
  const zipAt = findZipOffset(buf);
  if(zipAt === 0){
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
    text = decodeRequestText(buf);
  } catch(_){
    return { kind: 'bad', error: 'bad_json' };
  }
  if(!text) return { kind: 'bad', error: 'bad_json' };

  /* Extract $content / UEsDBB before JSON.parse so a huge or slightly
     invalid PA envelope cannot fail as bad_json. */
  const fromRaw = rowsFromRawEnvelopeText(text);
  if(fromRaw && fromRaw.kind === 'rows') return fromRaw;

  if(zipAt > 0){
    try {
      return rowsFromXlsxBytes(buf.slice(zipAt), DEFAULT_XLSX_NAME);
    } catch(_){}
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch(_){
    if(fromRaw && fromRaw.kind === 'bad') return fromRaw;
    const broken = extractBase64FromMalformed(text) || extractBase64ZipFromText(text);
    if(broken){
      const got = rowsFromXlsxB64(broken, DEFAULT_XLSX_NAME);
      if(got) return got;
    }
    const b64 = longString(text);
    if(b64){
      const got = rowsFromXlsxB64(b64, DEFAULT_XLSX_NAME);
      if(got && got.kind === 'rows') return got;
    }
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
