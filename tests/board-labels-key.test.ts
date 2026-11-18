import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {boardLabelsKey} from '../src/app/cards/use-card';

/** The bulk bar caches the board's labels; creating, renaming or deleting a label in the card panel must refresh it. */
describe('board label list stays fresh', () => {
  const useCard = readFileSync('src/app/cards/use-card.ts', 'utf8');
  const bulkBar = readFileSync('src/app/boards/bulk-bar.tsx', 'utf8');

  it('the bulk bar reads the shared key', () => {
    expect(boardLabelsKey(7)).toEqual(['board-labels', 7]);
    expect(bulkBar).toContain('queryKey: boardLabelsKey(boardId)');
    expect(bulkBar).not.toMatch(/\['board-labels'/);
  });

  it('createLabel, updateLabel and deleteLabel each invalidate it', () => {
    for (const name of ['createLabel', 'updateLabel', 'deleteLabel']) {
      const start = useCard.indexOf(`const ${name} = async`);
      expect(start, name).toBeGreaterThan(-1);
      const body = useCard.slice(start, useCard.indexOf('\n    };', start));
      expect(body, name).toContain('invalidateQueries({queryKey: boardLabelsKey(boardId)})');
    }
  });
});
