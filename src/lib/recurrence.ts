/**
 * Repeat rules for cards, shared by the server (route + job) and the card panel. Pure: no I/O, no clock.
 * Dates are plain `YYYY-MM-DD` days (UTC calendar); the job runs on the UTC day.
 *
 * Occurrence k of a rule is `anchor + k * interval` units (k = 0 is the anchor itself, the first copy day).
 * A monthly rule keeps the anchor's day of the month and clamps it to short months (31st -> 28th/29th/30th) WITHOUT
 * drifting, because every occurrence is counted from the anchor, never from the previous one.
 */
export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 99;
/** Rules one workspace may have enabled (a safety cap against a script; not a plan limit). */
export const MAX_RULES_PER_WORKSPACE = 200;

export type RepeatRule = {frequency: Frequency; interval: number; anchor: string; endsOn: string | null};

const DAY = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDay(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const m = ISO.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  return Number.isNaN(ms) || d.toISOString().slice(0, 10) !== iso ? null : ms;
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const isFrequency = (v: unknown): v is Frequency => typeof v === 'string' && (FREQUENCIES as readonly string[]).includes(v);

/** The k-th occurrence as an ISO day (k >= 0). Throws on a bad anchor: callers validate first. */
export function occurrence(rule: Pick<RepeatRule, 'frequency' | 'interval' | 'anchor'>, k: number): string {
  const anchor = parseDay(rule.anchor);
  if (anchor === null) throw new Error('bad anchor');
  if (rule.frequency === 'daily') return fmt(anchor + k * rule.interval * DAY);
  if (rule.frequency === 'weekly') return fmt(anchor + k * rule.interval * 7 * DAY);
  const a = new Date(anchor);
  const months = a.getUTCFullYear() * 12 + a.getUTCMonth() + k * rule.interval;
  const year = Math.floor(months / 12);
  const month = months - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fmt(Date.UTC(year, month, Math.min(a.getUTCDate(), last)));
}

/** The first occurrence strictly AFTER `day` (an ISO day), or null when that is past `endsOn`. */
export function nextAfter(rule: RepeatRule, day: string): string | null {
  const target = parseDay(day);
  const anchor = parseDay(rule.anchor);
  if (target === null || anchor === null) return null;
  let k = 0;
  if (target >= anchor) {
    const span = rule.frequency === 'monthly' ? 28 : rule.frequency === 'weekly' ? 7 : 1;
    // A lower bound for k (never above the answer), then step up: at most a couple of steps for months.
    k = Math.max(0, Math.floor((target - anchor) / (rule.interval * span * DAY)) - 1);
    if (rule.frequency === 'monthly') k = Math.max(0, Math.floor(((target - anchor) / (31 * DAY)) / rule.interval) - 1);
    while (occurrence(rule, k) <= day) k++;
  }
  const out = occurrence(rule, k);
  return rule.endsOn && out > rule.endsOn ? null : out;
}

/** The first occurrence ON or after `day`. */
export function onOrAfter(rule: RepeatRule, day: string): string | null {
  const before = parseDay(day);
  if (before === null) return null;
  return nextAfter(rule, fmt(before - DAY));
}

/** Up to `n` upcoming occurrences from `from` (inclusive), for the "next copies" preview. */
export function upcoming(rule: RepeatRule, from: string, n: number): string[] {
  const out: string[] = [];
  let at = onOrAfter(rule, from);
  while (at && out.length < n) {
    out.push(at);
    at = nextAfter(rule, at);
  }
  return out;
}

export type RuleInput = {frequency: unknown; interval: unknown; startOn: unknown; endsOn?: unknown};
export type RuleCheck = {ok: true; value: {frequency: Frequency; interval: number; startOn: string; endsOn: string | null}} | {ok: false; fields: Record<string, string>};

/** Shared by the route and the form, so both say the same thing. `today` is the UTC day. */
export function checkRule(input: RuleInput, today: string): RuleCheck {
  const fields: Record<string, string> = {};
  if (!isFrequency(input.frequency)) fields.frequency = 'invalid';
  const interval = input.interval;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < INTERVAL_MIN || interval > INTERVAL_MAX) fields.interval = 'invalid';
  const start = parseDay(input.startOn);
  const todayMs = parseDay(today)!;
  if (start === null) fields.startOn = 'invalid';
  else if (start < todayMs - DAY) fields.startOn = 'past';
  const rawEnd = input.endsOn ?? null;
  let endsOn: string | null = null;
  if (rawEnd !== null && rawEnd !== '') {
    const end = parseDay(rawEnd);
    if (end === null) fields.endsOn = 'invalid';
    else if (start !== null && end < start) fields.endsOn = 'before_start';
    else endsOn = rawEnd as string;
  }
  if (Object.keys(fields).length) return {ok: false, fields};
  return {ok: true, value: {frequency: input.frequency as Frequency, interval: interval as number, startOn: input.startOn as string, endsOn}};
}
