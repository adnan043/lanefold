import {describe, expect, it} from 'vitest';

import {PASSWORD_LIMITS} from '../src/platform/auth/password';
import {matchCheck, passwordChecks} from '../src/lib/password-checks';
import {idOf, intField, objectOf, textField} from '../src/server/validation';

describe('idOf', () => {
  it('accepts positive ids up to int32', () => {
    expect(idOf('1')).toBe(1);
    expect(idOf('2147483647')).toBe(2147483647);
  });
  it.each(['0', '-1', '1.5', '', ' 1', '1 ', '2147483648', '12345678901', '1e3', '0x10', 'abc'])('rejects %j', v => {
    expect(idOf(v)).toBeUndefined();
  });
  it('rejects non-strings', () => {
    for (const v of [1, null, undefined, ['1'], {}]) expect(idOf(v)).toBeUndefined();
  });
});

describe('objectOf', () => {
  it('returns plain objects only', () => {
    expect(objectOf({a: 1})).toEqual({a: 1});
    for (const v of [null, undefined, [], 'x', 1, true]) expect(objectOf(v)).toBeNull();
  });
});

describe('textField / intField edges', () => {
  it('textField trims, and min 0 allows empty', () => {
    expect(textField('  ', 0, 5)).toEqual({ok: true, value: ''});
    expect(textField(undefined, 0, 5).ok).toBe(false);
    const short = textField('', 3, 5);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.message).toContain('3 characters');
  });
  it('textField singular message for min 1', () => {
    const r = textField('', 1, 5);
    if (!r.ok) expect(r.error.message).toBe('Use at least 1 character.');
  });
  it('intField rejects NaN, Infinity, unsafe ints and bounds', () => {
    for (const v of [NaN, Infinity, -Infinity, 2 ** 53, null, true]) expect(intField(v, -1e16, 1e16).ok).toBe(false);
    expect(intField(-5, -5, 5).ok).toBe(true);
    expect(intField(6, -5, 5).ok).toBe(false);
  });
});

describe('passwordChecks', () => {
  const id = (list: ReturnType<typeof passwordChecks>, k: string) => list.find(c => c.id === k);

  it('length check boundary', () => {
    expect(id(passwordChecks('x'.repeat(PASSWORD_LIMITS.min - 1)), 'length')!.ok).toBe(false);
    expect(id(passwordChecks('x'.repeat(PASSWORD_LIMITS.min)), 'length')!.ok).toBe(true);
  });
  it('whitespace-only is not long enough even at min length', () => {
    expect(id(passwordChecks(' '.repeat(PASSWORD_LIMITS.min + 2)), 'length')!.ok).toBe(false);
  });
  it('max check only appears when too long', () => {
    expect(id(passwordChecks('x'.repeat(PASSWORD_LIMITS.max)), 'max')).toBeUndefined();
    expect(id(passwordChecks('x'.repeat(PASSWORD_LIMITS.max + 1)), 'max')!.ok).toBe(false);
  });
  it('email check appears for 4+ letter local parts, case-insensitive', () => {
    expect(id(passwordChecks('longenoughpassword', 'a@b.c'), 'email')).toBeUndefined();
    expect(id(passwordChecks('longenoughpassword', 'abc@b.c'), 'email')).toBeUndefined();
    expect(id(passwordChecks('Xx-MARIA-xx-123', ' Maria@Example.com '), 'email')!.ok).toBe(false);
    expect(id(passwordChecks('unrelated-secret-9', 'maria@example.com'), 'email')!.ok).toBe(true);
  });
  it('email check is not ok for an empty password', () => {
    expect(id(passwordChecks('', 'maria@example.com'), 'email')!.ok).toBe(false);
  });
});

describe('matchCheck', () => {
  it('needs a non-empty, equal confirmation', () => {
    expect(matchCheck('', '').ok).toBe(false);
    expect(matchCheck('abc', '').ok).toBe(false);
    expect(matchCheck('abc', 'abd').ok).toBe(false);
    expect(matchCheck('abc', 'ABC').ok).toBe(false);
    expect(matchCheck('abc', 'abc').ok).toBe(true);
  });
});
