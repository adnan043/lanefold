import {describe, expect, it} from 'vitest';

import {restoreText} from '../src/app/boards/composers';

describe('restoreText', () => {
  it('puts the sent text back into an empty field', () => {
    expect(restoreText('', 'Write docs')).toBe('Write docs');
    expect(restoreText('  \n', 'Write docs')).toBe('Write docs');
  });
  it('keeps what the person typed meanwhile', () => {
    expect(restoreText('Newer', 'Write docs')).toBe('Newer');
  });
});
