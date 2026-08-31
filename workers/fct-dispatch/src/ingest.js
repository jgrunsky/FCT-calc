/* POST /ingest body → { rows } for GET /latest.
 *
 * Accepts:
 *   1. Office Script JSON  { rows: [...] } or { value: [...] } (or a top-level array)
 *   2. Power Automate / OneDrive Get file content envelopes
 *      ($content / fileContent / body base64 xlsx) — including the PA HTTP
 *      body `{"$content-type":"...spreadsheetml.sheet","$content":"UEs..."}`
 *      (~785k-char $content, Content-Type header omitted). Scans raw bytes
 *      for UEsDBB / "$content" before JSON.parse. `"$content-type"` is not
 *      treated as `"$content"`.
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
  /* nodejs_compat Buffer handles 785k $content; atob of that size can throw
     in some Worker isolates. Split atob on a 4-char boundary if needed. */
  if(typeof Buffer !== 'undefined' && typeof Buffer.from === 'function'){
    const buf = Buffer.from(clean, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const CHUNK = 32768;
  const pieces = [];
  let total = 0;
  for(let i = 0; i < clean.length; i += CHUNK){
    const bin = atob(clean.slice(i, i + CHUNK));
    const out = new Uint8Array(bin.length);
    for(let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
    pieces.push(out);
    total += out.length;
  }
  const all = new Uint8Array(total);
  let off = 0;
  for(const p of pieces){ all.set(p, off); off += p.length; }
  return all;
}

function asObj(v){
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function longString(v){
  /* Do not \s+-strip 785k $content just to test length. */
  return (typeof v === 'string' && v.trim().length > 20) ? v : '';
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

function isB64CharCode(c){
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
    || c === 43 || c === 47 || c === 61 || c === 45 || c === 95;
}

function asciiFromCharCodes(codes){
  if(!codes || !codes.length) return '';
  const u8 = codes instanceof Uint8Array ? codes : Uint8Array.from(codes);
  return longString(new TextDecoder('latin1').decode(u8));
}

function charsetOf(contentType){
  const m = String(contentType || '').match(/charset\s*=\s*["']?([^"';\s]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function utf16Mode(buf, contentType){
  const cs = charsetOf(contentType);
  if(cs === 'utf-16be') return 'be';
  if(cs === 'utf-16le' || cs === 'utf-16' || cs === 'unicode') return 'le';
  if(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'le';
  if(buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'be';
  if(buf.length >= 4 && buf[0] === 0x7b && buf[1] === 0x00) return 'le';
  if(buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x7b) return 'be';
  let nuls = 0;
  const n = Math.min(buf.length, 80);
  for(let i = 0; i < n; i++) if(buf[i] === 0) nuls++;
  if(nuls >= n / 4) return buf[0] === 0 ? 'be' : 'le';
  return '';
}

/* ASCII JSON with a NUL between every char (UTF-16LE/BE of the PA envelope). */
export function collapseUtf16Ascii(buf, contentType){
  const mode = utf16Mode(buf, contentType);
  if(!mode || !buf || buf.length < 4) return '';
  const bom = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  const start = bom ? 2 : 0;
  const out = new Uint8Array(Math.ceil((buf.length - start) / 2));
  let k = 0;
  if(mode === 'le'){
    for(let i = start; i + 1 < buf.length; i += 2) out[k++] = buf[i];
  } else {
    for(let i = start; i + 1 < buf.length; i += 2) out[k++] = buf[i + 1];
  }
  return new TextDecoder('latin1').decode(out.subarray(0, k)).replace(/^\uFEFF/, '').trim();
}

function nextNonNul(buf, i){
  while(i < buf.length && buf[i] === 0) i++;
  return i;
}

function findAsciiSkipNuls(buf, ascii){
  const needle = [];
  for(let n = 0; n < ascii.length; n++) needle.push(ascii.charCodeAt(n));
  for(let i = 0; i < buf.length; i++){
    let p = i;
    let ok = true;
    for(let n = 0; n < needle.length; n++){
      p = nextNonNul(buf, p);
      if(p >= buf.length || buf[p] !== needle[n]){ ok = false; break; }
      p++;
    }
    if(ok) return nextNonNul(buf, i);
  }
  return -1;
}

function collectB64SkipNuls(buf, start){
  const codes = [];
  for(let j = start; j < buf.length; j++){
    const c = buf[j];
    if(c === 0) continue;
    if(isB64CharCode(c)) codes.push(c);
    else if(c === 32 || c === 10 || c === 13 || c === 9) continue;
    else break;
  }
  return asciiFromCharCodes(codes);
}

function readJsonStringValue(s, quoteAt){
  /* quoteAt points at the opening `"`. Collect without quadratic +=. */
  const parts = [];
  let acc = '';
  for(let j = quoteAt + 1; j < s.length; j++){
    const c = s[j];
    if(c === '\\'){
      const n = s[j + 1];
      if(n === 'n' || n === 'r' || n === 't'){ j++; continue; }
      if(n === 'u' && j + 5 < s.length){
        const code = parseInt(s.slice(j + 2, j + 6), 16);
        if(code === 10 || code === 13 || code === 9){ j += 5; continue; }
        if(Number.isFinite(code)) acc += String.fromCharCode(code);
        j += 5;
        continue;
      }
      if(n){ acc += n; j++; }
      continue;
    }
    if(c === '"') break;
    if(c === '\n' || c === '\r') continue;
    acc += c;
    if(acc.length >= 8192){ parts.push(acc); acc = ''; }
  }
  if(acc) parts.push(acc);
  return longString(parts.join(''));
}

/* `"$content"` only — never `"$content-type"` (indexOf of the quoted key). */
function extractDollarContentQuoted(s){
  const needle = '"$content"';
  let from = 0;
  while(from < s.length){
    const i = s.indexOf(needle, from);
    if(i < 0) return '';
    let k = i + needle.length;
    while(k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
    if(s[k] === ':'){
      k++;
      while(k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
      if(s[k] === '"') return readJsonStringValue(s, k);
      const codes = [];
      for(; k < s.length; k++){
        const c = s[k];
        if(c === ',' || c === '}' || c === '<' || c === '\n' || c === '\r') break;
        codes.push(c.charCodeAt(0));
      }
      return asciiFromCharCodes(codes);
    }
    from = i + 1;
  }
  return '';
}

/* Pull base64 xlsx out of broken JSON / XML without JSON.parse. */
export function extractBase64FromMalformed(text){
  const s = String(text || '').replace(/\0/g, '');
  const xml = s.match(/<\$content>([\s\S]*?)<\/\$content>/i);
  if(xml) return longString(xml[1]);
  const quoted = extractDollarContentQuoted(s);
  if(quoted) return quoted;
  /* Unquoted $content: — skip $content-type: (next char after $content is '-'). */
  let from = 0;
  while(from < s.length){
    const i = s.indexOf('$content', from);
    if(i < 0) return '';
    const prev = i === 0 ? '' : s[i - 1];
    if(prev && prev !== '{' && prev !== ',' && prev !== ' ' && prev !== '\n' && prev !== '\r' && prev !== '\t' && prev !== '"'){
      from = i + 1;
      continue;
    }
    let k = i + 8; /* length of $content */
    if(s[k] === '-'){ from = i + 1; continue; } /* $content-type */
    while(k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if(s[k] !== ':'){ from = i + 1; continue; }
    k++;
    while(k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
    if(s[k] === '"') return readJsonStringValue(s, k);
    const codes = [];
    for(; k < s.length; k++){
      const c = s[k];
      if(c === ',' || c === '}' || c === '<' || c === '\n' || c === '\r') break;
      codes.push(c.charCodeAt(0));
    }
    return asciiFromCharCodes(codes);
  }
  return '';
}

function collectB64From(s, i){
  const codes = [];
  for(let j = i; j < s.length; j++){
    const c = s.charCodeAt(j);
    if(isB64CharCode(c)) codes.push(c);
    else if(c === 32 || c === 10 || c === 13 || c === 9) continue;
    else break;
  }
  return asciiFromCharCodes(codes);
}

/* PK zip as base64 always starts UEsDBB (PK\x03\x04).
 * Contiguous ASCII, or the same letters with NULs between them (UTF-16). */
export function extractBase64ZipFromText(text){
  const s = String(text || '').replace(/\0/g, '');
  const i = s.indexOf('UEsDBB');
  if(i < 0) return '';
  return collectB64From(s, i);
}

export function extractBase64ZipFromBytes(buf){
  if(!buf || buf.length < 6) return '';
  const t0 = 0x55, t1 = 0x45, t2 = 0x73, t3 = 0x44, t4 = 0x42, t5 = 0x42;
  for(let p = 0; p <= buf.length - 6; p++){
    if(buf[p] === t0 && buf[p + 1] === t1 && buf[p + 2] === t2
      && buf[p + 3] === t3 && buf[p + 4] === t4 && buf[p + 5] === t5){
      const codes = [];
      for(let j = p; j < buf.length; j++){
        const c = buf[j];
        if(isB64CharCode(c)) codes.push(c);
        else if(c === 32 || c === 10 || c === 13 || c === 9) continue;
        else break;
      }
      return asciiFromCharCodes(codes);
    }
  }
  const skipped = findAsciiSkipNuls(buf, 'UEsDBB');
  if(skipped >= 0) return collectB64SkipNuls(buf, skipped);
  return '';
}

function looksLikePaEnvelopeText(text){
  const s = String(text || '').replace(/\0/g, '');
  return s.includes('$content') || s.includes('UEsDBB') || s.includes('spreadsheetml');
}

function decodeRequestText(buf, contentType){
  const collapsed = collapseUtf16Ascii(buf, contentType);
  if(collapsed && (collapsed.startsWith('{') || collapsed.includes('UEsDBB') || collapsed.includes('$content'))){
    return collapsed;
  }
  const cs = charsetOf(contentType);
  if(cs.indexOf('utf-16') >= 0 || cs === 'unicode'){
    const enc = cs === 'utf-16be' ? 'utf-16be' : 'utf-16le';
    try {
      return new TextDecoder(enc).decode(buf).replace(/^\uFEFF/, '').trim();
    } catch(_){}
  }
  if(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe){
    try {
      return new TextDecoder('utf-16le').decode(buf).replace(/^\uFEFF/, '').trim();
    } catch(_){}
  }
  if(buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff){
    try {
      return new TextDecoder('utf-16be').decode(buf).replace(/^\uFEFF/, '').trim();
    } catch(_){}
  }
  if(buf.length >= 4 && buf[0] === 0x7b && buf[1] === 0x00 && buf[3] === 0x00){
    try {
      return new TextDecoder('utf-16le').decode(buf).replace(/^\uFEFF/, '').trim();
    } catch(_){}
  }
  if(buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x7b){
    try {
      return new TextDecoder('utf-16be').decode(buf).replace(/^\uFEFF/, '').trim();
    } catch(_){}
  }
  try {
    return new TextDecoder().decode(buf).replace(/^\uFEFF/, '').replace(/\0/g, '').trim();
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

function rowsFromBase64Zip(b64){
  if(!b64) return null;
  try {
    const bytes = decodeBase64(b64);
    if(!looksLikeZipXlsx(bytes)) return null;
    return rowsFromXlsxBytes(bytes, DEFAULT_XLSX_NAME);
  } catch(_){
    return null;
  }
}

function tryXlsxBytes(bytes, fileName){
  try {
    return rowsFromXlsxBytes(bytes, fileName || DEFAULT_XLSX_NAME);
  } catch(_){
    return { kind: 'bad', error: 'bad_xlsx' };
  }
}

function firstXlsxFromCandidates(candidates){
  for(const b64 of candidates){
    const got = rowsFromBase64Zip(b64);
    if(got && got.kind === 'rows') return got;
  }
  return null;
}

/* Raw POST text → xlsx rows for a PA $content / UEsDBB envelope.
 * Try $content and UEsDBB independently (do not let a MIME-type false
 * match hide the zip). Returns null so the caller can parse or fall through. */
export function rowsFromRawEnvelopeText(text){
  const s = String(text || '').trim();
  if(!s) return null;
  return firstXlsxFromCandidates([
    extractBase64FromMalformed(s),
    extractBase64ZipFromText(s)
  ]);
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
    if(bytes){
      try {
        return rowsFromXlsxBytes(bytes, envelopeFileName(body));
      } catch(_){
        return { kind: 'bad', error: 'bad_xlsx' };
      }
    }
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
  const contentType = request.headers.get('Content-Type') || '';
  /* Content-Type may be omitted (Flow 1) or charset=utf-16. */

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

  let fromBufB64 = '';
  try {
    fromBufB64 = extractBase64ZipFromBytes(buf);
  } catch(_){}
  const fromBytes = rowsFromBase64Zip(fromBufB64);
  if(fromBytes && fromBytes.kind === 'rows') return fromBytes;

  let text;
  try {
    text = decodeRequestText(buf, contentType);
  } catch(_){
    text = '';
  }
  if(!text && !fromBufB64) return { kind: 'bad', error: 'bad_json' };

  const fromRaw = rowsFromRawEnvelopeText(text);
  if(fromRaw && fromRaw.kind === 'rows') return fromRaw;

  if(zipAt > 0){
    const sliced = tryXlsxBytes(buf.slice(zipAt));
    if(sliced && sliced.kind === 'rows') return sliced;
  }

  const envelope = !!(fromBufB64 || looksLikePaEnvelopeText(text) || utf16Mode(buf, contentType));

  let body;
  try {
    body = JSON.parse(text);
  } catch(_){
    if(envelope) return { kind: 'bad', error: 'bad_xlsx' };
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
