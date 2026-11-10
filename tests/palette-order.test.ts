import {describe, expect, it} from 'vitest';

import {letterOf} from '../src/app/shortcut-keys';
import {defaultActive, groupResults} from '../src/portal/ui/command-order';

describe('palette ordering', () => {
  const rows = [
    {id: 'new-board', group: 'Actions'},
    {id: 'create', group: 'Actions', always: true, fallback: true},
    {id: 'card-1', group: 'Cards', always: true},
  ];
  it('puts the create fallback last and never makes it the Enter default', () => {
    const out = groupResults(rows);
    expect(out.map(r => r.id)).toEqual(['new-board', 'card-1', 'create']);
    expect(out[defaultActive(out, 'fix')]!.id).toBe('card-1');
  });
  it('falls back to the first non-fallback row without results', () => {
    const out = groupResults([rows[1]!, rows[0]!]);
    expect(out[defaultActive(out, 'zz')]!.id).toBe('new-board');
  });
  it('returns -1 when only fallback rows exist', () => {
    expect(defaultActive([rows[1]!], 'zz')).toBe(-1);
  });
});

describe('shortcut letters', () => {
  it('uses the produced letter on Latin layouts (Dvorak: physical KeyV prints k)', () => {
    expect(letterOf({code: 'KeyV', key: 'k'})).toBe('k');
    expect(letterOf({code: 'KeyN', key: 'b'})).toBe('b');
  });
  it('falls back to the physical key on non-Latin layouts', () => {
    expect(letterOf({code: 'KeyN', key: 'т'})).toBe('n');
    expect(letterOf({code: 'KeyN', key: 'ن'})).toBe('n');
  });
  it('maps slash and ignores other keys', () => {
    expect(letterOf({code: 'Slash', key: '/'})).toBe('/');
    expect(letterOf({code: 'Slash', key: '?'})).toBe('');
    expect(letterOf({code: 'Enter', key: 'Enter'})).toBe('');
  });
});
