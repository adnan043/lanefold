import {describe, expect, it} from 'vitest';

import {cardLinkPath, cardLinkUrl} from '../src/app/cards/card-link';

describe('card link', () => {
  it('builds the path from ids only', () => {
    expect(cardLinkPath(7, 42)).toBe('/app/b/7/c/42');
  });
  it('joins the origin without a double slash', () => {
    expect(cardLinkUrl('https://lanefold.example', 7, 42)).toBe('https://lanefold.example/app/b/7/c/42');
    expect(cardLinkUrl('https://lanefold.example/', 7, 42)).toBe('https://lanefold.example/app/b/7/c/42');
  });
});
