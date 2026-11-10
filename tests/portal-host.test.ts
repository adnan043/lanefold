import {describe, expect, it} from 'vitest';

import {nextDialogStack, pickHost} from '../src/portal/ui/portal-host';

describe('overlay host stack', () => {
  it('keeps open order and puts new dialogs on top', () => {
    expect(nextDialogStack(['card'], ['card', 'confirm'])).toEqual(['card', 'confirm']);
    expect(nextDialogStack(['card'], ['confirm', 'card'])).toEqual(['card', 'confirm']);
  });
  it('drops closed dialogs', () => {
    expect(nextDialogStack(['card', 'confirm'], ['card'])).toEqual(['card']);
    expect(nextDialogStack(['card'], [])).toEqual([]);
  });
  it('picks the top dialog, else the fallback', () => {
    expect(pickHost(['card', 'confirm'], 'body')).toBe('confirm');
    expect(pickHost([], 'body')).toBe('body');
  });
});
