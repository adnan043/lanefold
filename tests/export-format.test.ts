import {describe, expect, it} from 'vitest';

import {csvCell, csvRow, safeFileBase} from '../src/server/export-format';

describe('csvCell', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx'])('defuses a formula start: %j', value => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });
  it('quotes everything and doubles quotes; newlines stay inside the quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a,b\nc')).toBe('"a,b\nc"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell('plain')).toBe('"plain"');
  });
  it('only checks the first character', () => {
    expect(csvCell('a=1')).toBe('"a=1"');
  });
  it('writes CRLF rows', () => {
    expect(csvRow(['a', '=b'])).toBe('"a","\'=b"\r\n');
  });
});

describe('safeFileBase', () => {
  it('is ascii, short and never empty', () => {
    expect(safeFileBase('My board: Q3!')).toBe('my-board-q3');
    expect(safeFileBase('日本語')).toBe('board');
    expect(safeFileBase('"; rm -rf /')).toBe('rm-rf');
    expect(safeFileBase('x'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
});
