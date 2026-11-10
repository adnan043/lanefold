import type {Context} from 'hono';

import {problem} from '../platform/guards';

/** Shared input rules for the Lanefold routes (the client mirrors them; docs/agent/security.md A05). */

/** The launch languages (docs/product/SPEC.md §11). */
export const LOCALES = ['en', 'bn', 'hi', 'ur', 'ar', 'fa', 'es', 'fr', 'pt', 'de', 'it', 'ru', 'tr', 'id', 'zh', 'ja', 'ko', 'vi', 'th', 'sw'] as const;

/** Strict `#rrggbb` (any case); stored upper-case. */
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export type FieldError = {code: string; message: string};

/**
 * `422 {error, message, fields, fieldCodes}`: `fields` carries English words, `fieldCodes` stable codes
 * (`required`, `too_long`, `invalid`, `out_of_range`, ...) the client localizes.
 */
export function invalid(c: Context, errors: Record<string, FieldError>) {
  const names = Object.keys(errors);
  if (names.length === 0) errors = {input: {code: 'invalid', message: 'Check the form and try again.'}}, names.push('input');
  const fields: Record<string, string> = {};
  const fieldCodes: Record<string, string> = {};
  for (const name of names) {
    fields[name] = errors[name]!.message;
    fieldCodes[name] = errors[name]!.code;
  }
  return c.json({...problem('invalid_input', errors[names[0]!]!.message), fields, fieldCodes}, 422);
}

/** The JSON body as a plain object, or null (an array, a string, nothing). */
export function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A positive safe integer from a path or query value, else undefined. */
export function idOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,10}$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : undefined;
}

/** A trimmed string within [min, max] characters, or an error. */
export function textField(value: unknown, min: number, max: number): {ok: true; value: string} | {ok: false; error: FieldError} {
  if (typeof value !== 'string') return {ok: false, error: {code: 'required', message: `Enter ${min === 0 ? 'text' : 'a value'}.`}};
  const text = value.trim();
  if (text.length < min) return {ok: false, error: {code: 'required', message: `Use at least ${min} character${min === 1 ? '' : 's'}.`}};
  if (text.length > max) return {ok: false, error: {code: 'too_long', message: `Use at most ${max} characters.`}};
  return {ok: true, value: text};
}

/** An integer in [min, max] (a number or a numeric string is NOT coerced: JSON numbers only). */
export function intField(value: unknown, min: number, max: number): {ok: true; value: number} | {ok: false; error: FieldError} {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    return {ok: false, error: {code: 'out_of_range', message: `Use a whole number from ${min} to ${max}.`}};
  }
  return {ok: true, value};
}

/** Escapes `%`, `_` and `\` so user text is a literal in ILIKE. */
export const likeEscape = (text: string) => text.replace(/[\\%_]/g, ch => `\\${ch}`);
