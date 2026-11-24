import {describe, expect, it} from 'vitest';

import {mentionParts} from '../src/app/cards/comments';

describe('mentionParts (the coloured @Name chips in the comment box)', () => {
  it('marks only picked names, as whole words, longest first', () => {
    expect(mentionParts('Hi @Ayesha Siddiqua, see @Ann and @Annabel', ['Ann', 'Ayesha Siddiqua'])).toEqual([
      {text: 'Hi ', mention: false},
      {text: '@Ayesha Siddiqua', mention: true},
      {text: ', see ', mention: false},
      {text: '@Ann', mention: true},
      {text: ' and @Annabel', mention: false},
    ]);
  });
  it('an email-like a@Ann is not a mention; the text is kept whole', () => {
    const parts = mentionParts('mail a@Ann now', ['Ann']);
    expect(parts.every(p => !p.mention)).toBe(true);
    expect(parts.map(p => p.text).join('')).toBe('mail a@Ann now');
  });
});
