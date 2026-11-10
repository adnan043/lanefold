import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

import {spacerSizes, VIRTUAL_MIN_ROWS} from '../src/portal/ui/virtual-rows';

describe('table windowing', () => {
  it('no spacers without drawn rows', () => expect(spacerSizes([], 5000)).toEqual({top: 0, bottom: 0}));
  it('spacers fill the space around the window', () => {
    expect(spacerSizes([{start: 520, end: 572}, {start: 572, end: 624}], 5200)).toEqual({top: 520, bottom: 4576});
  });
  it('never negative', () => expect(spacerSizes([{start: -4, end: 60}], 40)).toEqual({top: 0, bottom: 0}));
  it('short lists render whole', () => expect(VIRTUAL_MIN_ROWS).toBeGreaterThan(50));
  it('react-virtual is a declared dependency, used only by tables (never the dnd board canvas)', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    expect(pkg.dependencies['@tanstack/react-virtual']).toBeTruthy();
    expect(readFileSync(join(__dirname, '../src/app/boards/canvas.tsx'), 'utf8')).not.toContain('react-virtual');
  });
});
