/**
 * Pure helpers of the board export (no I/O): CSV that a spreadsheet cannot turn into a formula, and download names.
 */

/** A cell starting with one of these is a formula in Excel, Sheets and LibreOffice ("CSV injection"). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: formulas defused with a leading apostrophe, always quoted, quotes doubled. Newlines stay inside
 * the quotes (RFC 4180). A leading apostrophe is the OWASP-recommended neutraliser: the spreadsheet shows text.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export const csvRow = (cells: readonly unknown[]): string => `${cells.map(csvCell).join(',')}\r\n`;

/** `My board: Q3!` to `my-board-q3`: ASCII only, safe in a Content-Disposition filename. */
export function safeFileBase(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return base || 'board';
}

export const CSV_COLUMNS = [
  'lane',
  'card_id',
  'title',
  'description',
  'labels',
  'priority',
  'assignees',
  'start_date',
  'due_date',
  'completed',
  'archived',
  'checklist_done',
  'checklist_total',
  'comments',
  'attachments',
  'created_at',
  'card_number',
] as const;
