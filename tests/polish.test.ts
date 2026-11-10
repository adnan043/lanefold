import {describe, expect, it} from 'vitest';

import en from '../src/i18n/messages/en.json';

import {isChunkLoadError, safeErrorLabel} from '../src/app/polish';

describe('polish helpers', () => {
  it('detects failed chunk loads', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /x.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
  it('logs only the error kind', () => {
    expect(safeErrorLabel(new TypeError('card "Salary review" failed'))).toBe('TypeError');
    expect(safeErrorLabel('boom')).toBe('Error');
  });
  it('has the English text for the "Card moved." bar label', () => {
    expect((en as Record<string, string>)['polish.cardMoved']).toBe('Card moved.');
  });
});
