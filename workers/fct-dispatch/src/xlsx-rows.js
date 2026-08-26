/* Sheet "2026" of 2026 FCT Dispatch Log.xlsx → GET /latest row objects.
 *
 * Same column order the Office Script posts and the calc walks:
 * time, po, driver, origin, fb, commodity, truck, status, extra (A..I).
 * Values stay raw (Excel serials / day-fractions as numbers stringified)
 * so parseDispatchRows / parseCellDate / fmtSheetTime keep working.
 */
import * as XLSX from 'xlsx';

export const WORKER_FIELDS = ['time', 'po', 'driver', 'origin', 'fb', 'commodity', 'truck', 'status', 'extra'];
export const DISPATCH_SHEET = '2026';
export const DEFAULT_XLSX_NAME = '2026 FCT Dispatch Log.xlsx';

export function cellToText(v){
  if(v == null || v === '') return '';
  if(typeof v === 'number' && !Number.isFinite(v)) return '';
  return String(v);
}

export function aoaToWorkerRows(aoa){
  return (Array.isArray(aoa) ? aoa : []).map(row => {
    const r = Array.isArray(row) ? row : [];
    const obj = {};
    for(let i = 0; i < WORKER_FIELDS.length; i++){
      obj[WORKER_FIELDS[i]] = cellToText(r[i]);
    }
    return obj;
  });
}

export function pickDispatchSheet(wb){
  const names = (wb && wb.SheetNames) || [];
  if(!names.length) throw new Error('no_sheets');
  if(names.indexOf(DISPATCH_SHEET) >= 0) return DISPATCH_SHEET;
  return names[0];
}

export function xlsxBytesToRows(bytes){
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const wb = XLSX.read(u8, { type: 'array', cellDates: false, raw: true });
  const sheetName = pickDispatchSheet(wb);
  const sheet = wb.Sheets[sheetName];
  if(!sheet) throw new Error('no_sheet');
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: true
  });
  return {
    rows: aoaToWorkerRows(aoa),
    sheetName,
    fileName: DEFAULT_XLSX_NAME
  };
}
