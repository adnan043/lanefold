import {describe, expect, it} from 'vitest';

import {clean, escapeHtml, inviteLink, isMailLocale} from '../src/server/mail/templates';

describe('mail clean()', () => {
  it('returns an empty string for non-strings', () => {
    for (const v of [undefined, null, 5, {}, [], true]) expect(clean(v)).toBe('');
  });

  it.each([
    ['CR/LF', 'a\r\nb', 'a b'],
    ['tab and NUL', 'a\tb\u0000c', 'a b c'],
    ['DEL and C1', 'a\u007Fb\u0085c\u009Fd', 'a b c d'],
    ['line/paragraph separators', 'a b c', 'a b c'],
    ['zero-width and direction marks', 'a​b‏c', 'a b c'],
    ['bidi embeddings/overrides', 'a‪b‮c', 'a b c'],
    ['bidi isolates', 'a⁦b⁩c', 'a b c'],
    ['BOM', '﻿name', 'name'],
  ])('strips %s', (_n, input, expected) => {
    expect(clean(input)).toBe(expected);
  });

  it('keeps a single ZWNJ/ZWJ between two non-space characters', () => {
    expect(clean('می\u200Cخواهم')).toBe('می\u200Cخواهم');
    expect(clean('👩\u200D💻')).toBe('👩\u200D💻');
  });

  it.each([
    ['leading', '\u200Dabc', 'abc'],
    ['trailing', 'abc\u200C', 'abc'],
    ['repeated', 'a\u200C\u200Db', 'a b'],
    ['next to a space', 'a \u200Db', 'a b'],
    ['next to another invisible', 'a\u200B\u200Db', 'a b'],
    ['only joiners', '\u200C\u200D', ''],
  ])('strips a joiner that is %s', (_n, input, expected) => {
    expect(clean(input)).toBe(expected);
  });

  it('drops a joiner left dangling by the length cap', () => {
    expect(clean('ab\u200Dcd', 3)).toBe('ab');
  });

  it('collapses whitespace runs and trims', () => {
    expect(clean('  a    b\n\n\nc  ')).toBe('a b c');
  });

  it('keeps ordinary non-latin text and emoji', () => {
    expect(clean('Ana Śilva 日本語 مرحبا')).toBe('Ana Śilva 日本語 مرحبا');
    expect(clean('Team 🚀')).toBe('Team 🚀');
  });

  it('caps by code point, never splitting a surrogate pair', () => {
    const out = clean('🚀'.repeat(10), 3);
    expect(out).toBe('🚀🚀🚀');
    expect([...out]).toHaveLength(3);
  });

  it('honours a custom max and trims after stripping', () => {
    expect(clean('abcdef', 4)).toBe('abcd');
    expect(clean('\r\n​', 10)).toBe('');
  });

  it('cannot smuggle a header line', () => {
    expect(clean('x\r\nBcc: evil@example.com')).not.toMatch(/[\r\n]/);
  });
});

describe('mail helpers', () => {
  it('escapeHtml leaves safe text alone and escapes & first (no double escaping of its own output)', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('')).toBe('');
  });

  it('inviteLink strips any number of trailing slashes', () => {
    expect(inviteLink('https://x.example///', 'iv_t')).toBe('https://x.example/app/join/iv_t');
  });

  it('isMailLocale accepts only known codes', () => {
    expect(isMailLocale('en')).toBe(true);
    expect(isMailLocale('EN')).toBe(false);
    expect(isMailLocale('xx')).toBe(false);
    expect(isMailLocale(undefined)).toBe(false);
    expect(isMailLocale(['en'])).toBe(false);
  });
});
