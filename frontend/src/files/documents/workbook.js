// XLSX → sayfa sayfa satırlar (bellekte). Arayüz her sayfadan yalnız ilk SHEET_MAX_ROWS×SHEET_MAX_COLS hücreyi çizer:
// tarayıcıyı dondurmadan "içine bakmaya" yeter; tamamı için dosya telefondaki/PC'deki uygulamasında açılır.
export const SHEET_MAX_ROWS = 500;
export const SHEET_MAX_COLS = 40;

/** Hücre değeri → gösterim metni. */
export function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toLocaleDateString('tr-TR');
  if (typeof value === 'boolean') return value ? 'DOĞRU' : 'YANLIŞ';
  return String(value);
}

/** ArrayBuffer (.xlsx) → [{ name, rows, totalRows, totalCols }] (rows kırpılmış). Kırpma `totalX > rows` ile görünür. */
export async function readWorkbook(buffer) {
  // `browser` girişi ayrı bir Web Worker'da çözer (arayüz donmaz); CSP `worker-src blob:` buna izin verir.
  const { default: readExcelFile } = await import('read-excel-file/browser');
  const sheets = await readExcelFile(buffer);
  return sheets.map(({ sheet, data }) => {
    const totalCols = data.reduce((max, row) => Math.max(max, row.length), 0);
    return {
      name: sheet,
      rows: data.slice(0, SHEET_MAX_ROWS).map((row) => row.slice(0, SHEET_MAX_COLS)),
      totalRows: data.length,
      totalCols,
    };
  });
}
