/**
 * Dates, numbers and relative times with `Intl.*` in the user's locale and
 * time zone. Pure: pass the context (from `useI18n().format` in the app).
 * A bad time zone or locale falls back instead of throwing.
 */
export interface FormatContext {
  locale: string;
  timezone: string;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(ctx: FormatContext, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${ctx.locale}|${ctx.timezone}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(ctx.locale, {...options, timeZone: ctx.timezone});
    } catch {
      format = new Intl.DateTimeFormat('en', options);
    }
    dateFormats.set(key, format);
  }
  return format;
}

const toDate = (value: Date | string | number) => (value instanceof Date ? value : new Date(value));

export function formatDate(ctx: FormatContext, value: Date | string | number, options: Intl.DateTimeFormatOptions = {dateStyle: 'medium'}): string {
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? '' : dateFormat(ctx, options).format(date);
}

export function formatDateTime(ctx: FormatContext, value: Date | string | number): string {
  return formatDate(ctx, value, {dateStyle: 'medium', timeStyle: 'short'});
}

const numberFormats = new Map<string, Intl.NumberFormat>();

export function formatNumber(ctx: FormatContext, value: number, options?: Intl.NumberFormatOptions): string {
  const key = `${ctx.locale}|${options ? JSON.stringify(options) : ''}`;
  let format = numberFormats.get(key);
  if (!format) {
    try {
      format = new Intl.NumberFormat(ctx.locale, options);
    } catch {
      format = new Intl.NumberFormat('en', options);
    }
    numberFormats.set(key, format);
  }
  return format.format(value);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
];

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
/** One per locale, reused (chat renders a relative time per message). */
function relativeFormat(locale: string): Intl.RelativeTimeFormat {
  let rtf = relativeFormats.get(locale);
  if (!rtf) {
    try {
      rtf = new Intl.RelativeTimeFormat(locale, {numeric: 'auto'});
    } catch {
      rtf = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
    }
    relativeFormats.set(locale, rtf);
  }
  return rtf;
}

/** "3 minutes ago", "tomorrow", "in 2 weeks"; under a minute is "now". */
export function formatRelative(ctx: FormatContext, value: Date | string | number, now: number = Date.now()): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.round((date.getTime() - now) / 1000);
  const rtf = relativeFormat(ctx.locale);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.trunc(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}

/** The browser's own time zone, or UTC. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
