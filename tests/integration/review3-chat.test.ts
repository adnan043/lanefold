import {describe, expect, it} from 'vitest';

import {isEmoji} from '../../src/server/routes/chat';

/** Security review 4 (chat): a reaction must be a visible emoji, not only invisible joiners or modifiers. */
describe('review3 chat: emoji validation', () => {
  it('rejects strings with no visible pictograph', () => {
    for (const s of ['‍', '️', '\u{1F3FB}', '‍️', '']) expect(isEmoji(s)).toBe(false);
  });
  it('still accepts real emoji, skin tones and ZWJ sequences', () => {
    for (const s of ['👍', '👍🏽', '👨‍👩‍👧', '❤️']) expect(isEmoji(s)).toBe(true);
  });
});
