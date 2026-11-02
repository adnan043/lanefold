/**
 * Pure calendar helpers (ISO `yyyy-mm-dd` strings, UTC arithmetic so a time
 * zone or daylight saving never shifts a day). Used by `DatePicker`.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toISODate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year); // years 0-99 are not mapped to 19xx
  return date.toISOString().slice(0, 10);
}

/** `{year, month (1-12), day}` for a real calendar date; null for anything else (`2026-02-30`, `''`). */
export function parseISODate(value: unknown): {year: number; month: number; day: number} | null {
  if (typeof value !== 'string') return null;
  const m = ISO.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return toISODate(year, month, day) === value ? {year, month, day} : null;
}

export function addDays(iso: string, days: number): string {
  const p = parseISODate(iso);
  if (!p) throw new RangeError(`Not an ISO date: ${iso}`);
  return toISODate(p.year, p.month, p.day + days);
}

/** Moves by whole months and keeps the day when it fits (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const p = parseISODate(iso);
  if (!p) throw new RangeError(`Not an ISO date: ${iso}`);
  const index = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12 + 12) % 12 + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return toISODate(year, month, Math.min(p.day, last));
}

/** 0 (Sunday) to 6 (Saturday). */
export function weekday(iso: string): number {
  const p = parseISODate(iso);
  if (!p) throw new RangeError(`Not an ISO date: ${iso}`);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** The weeks of a month as rows of 7 ISO dates, starting on `firstDayOfWeek` (0 Sunday … 6 Saturday), padded with the neighbouring months. */
export function monthGrid(year: number, month: number, firstDayOfWeek = 0): string[][] {
  const first = toISODate(year, month, 1);
  const lead = (weekday(first) - firstDayOfWeek + 7) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weeks = Math.ceil((lead + days) / 7);
  const start = addDays(first, -lead);
  return Array.from({length: weeks}, (_, w) => Array.from({length: 7}, (_, d) => addDays(start, w * 7 + d)));
}

export function startOfWeek(iso: string, firstDayOfWeek = 0): string {
  return addDays(iso, -((weekday(iso) - firstDayOfWeek + 7) % 7));
}

/** Today in the visitor's own calendar, as ISO. */
export function todayISO(now = new Date()): string {
  return toISODate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
