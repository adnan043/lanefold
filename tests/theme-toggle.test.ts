import {describe, expect, it} from 'vitest';

import {shownTheme} from '../src/app/settings/theme-toggle';

describe('shownTheme', () => {
  it('follows an explicit choice over the device', () => {
    expect(shownTheme('dark', false)).toBe('dark');
    expect(shownTheme('light', true)).toBe('light');
  });
  it('treats high contrast as a light theme', () => {
    expect(shownTheme('contrast', true)).toBe('light');
  });
  it('follows the device when nothing is chosen', () => {
    expect(shownTheme(undefined, true)).toBe('dark');
    expect(shownTheme(undefined, false)).toBe('light');
  });
});
