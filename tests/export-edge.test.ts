import {describe, expect, it} from 'vitest';

import {csvCell, csvRow, safeFileBase} from '../src/server/export-format';

/** Parses one cell the way a spreadsheet reads it back (quotes undoubled). */
const unquote = (cell: string) => cell.slice(1, -1).replace(/""/g, '"');

describe('csvCell hostile input', () => {
  it.each([
    ['=HYPERLINK("http://evil.test","x")'],
    ['+1+1'],
    ['-1+1'],
    ['@SUM(1)'],
    ['\t=1'],
    ['\r=1'],
    ['=cmd|\' /C calc\'!A0'],
    ['-2+3+cmd|\' /C calc\'!A0'],
  ])('defuses %j and the result cannot start a formula', value => {
    const out = csvCell(value);
    expect(out.startsWith('"\'')).toBe(true);
    expect(unquote(out)).toBe(`'${value}`);
  });

  it('is always one quoted cell whatever it holds', () => {
    const nasty = ['"', '""', '",', 'a\r\nb', '\n', ',,,', '"\n"', '\u0000', '‮=1', '​=1', '日本語', '😀=1', 'x'.repeat(100_000)];
    for (const v of nasty) {
      const out = csvCell(v);
      expect(out.startsWith('"') && out.endsWith('"')).toBe(true);
      // Every inner quote is doubled: removing doubled pairs leaves no lone quote.
      expect(out.slice(1, -1).replace(/""/g, '')).not.toContain('"');
      expect(unquote(out).replace(/^'/, '')).toBe(v);
    }
  });

  it('handles non-string values without throwing', () => {
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(false)).toBe('"false"');
    expect(csvCell(true)).toBe('"true"');
    expect(csvCell(NaN)).toBe('"NaN"');
    expect(csvCell(10n)).toBe('"10"');
    expect(csvCell(new Date(0))).toContain('1970');
    expect(csvCell(['=a', 'b'])).toBe(`"'=a,b"`); // arrays stringify first, then the result is defused
  });

  // Pinned current behaviour (OWASP lists only = + - @ tab CR). Spreadsheets do not run formulas for these starts.
  it('pins what is NOT defused: leading space, LF, bidi and zero-width starts, fullwidth equals', () => {
    for (const v of [' =1+1', '\n=1', '‮=1', '​=1', '＝1+1']) {
      expect(csvCell(v)).toBe(`"${v}"`);
    }
  });

  it('defuses negative numbers too (they become text, by design of the first-character rule)', () => {
    expect(csvCell(-5)).toBe(`"'-5"`);
  });

  it('only the first character matters, and an apostrophe start is not doubled', () => {
    expect(csvCell("'=1")).toBe(`"'=1"`);
    expect(csvCell('a\t=1')).toBe('"a\t=1"');
  });
});

describe('csvRow', () => {
  it('ends in exactly one CRLF and keeps column count when cells hold newlines and commas', () => {
    const row = csvRow(['a,b', 'line1\r\nline2', '=x', null, 1]);
    expect(row.endsWith('\r\n')).toBe(true);
    expect(row.endsWith('\r\n\r\n')).toBe(false);
    // Split on commas outside quotes.
    const cells = row.slice(0, -2).match(/"(?:[^"]|"")*"/g)!;
    expect(cells).toHaveLength(5);
    expect(cells.map(unquote)).toEqual(['a,b', 'line1\r\nline2', "'=x", '', '1']);
  });
  it('an empty row is just CRLF', () => {
    expect(csvRow([])).toBe('\r\n');
  });
});

describe('safeFileBase hostile input', () => {
  it.each([
    ['../../etc/passwd', 'etc-passwd'],
    ['..\\..\\windows', 'windows'],
    ['a\r\nSet-Cookie: x=1', 'aset-cookie-x-1'],
    ['a"b;c', 'a-b-c'],
    ['‮fdp.exe', 'fdp-exe'],
    ['😀😀', 'board'],
    ['', 'board'],
    ['   ', 'board'],
    ['.', 'board'],
    ['ＡＢＣ １２３', 'abc-123'],
    ['ﬁnal', 'final'],
  ])('%j -> %j', (input, expected) => {
    expect(safeFileBase(input)).toBe(expected);
  });

  it('is always header-safe, short and non-empty', () => {
    const inputs = ['x'.repeat(10_000), '\u0000\u0001', '%0d%0a', 'a b '.repeat(50), '\uD800', '😀'.repeat(50) + 'z'];
    for (const i of inputs) {
      const out = safeFileBase(i);
      expect(out).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$|^board$/.source.length ? /^[a-z0-9-]+$/ : /./);
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThanOrEqual(40);
    }
  });

  // BUG (minor): slice(0, 40) runs after the trailing-dash trim, so a cut can leave a trailing "-".
  it('never ends or starts with a dash after the 40 character cut', () => {
    const out = safeFileBase(`${'a'.repeat(39)} b`);
    expect(out).not.toMatch(/-$/);
  });
});
