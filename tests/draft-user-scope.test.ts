import {describe, expect, it} from 'vitest';

import {clearAllDrafts, draftKey, type DraftStorage, loadDraft, saveDraft} from '../src/app/draft-store';

function fake(): DraftStorage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: k => void data.delete(k),
  };
}

describe('draft user scope', () => {
  it('never restores one user draft for another user', () => {
    const s = fake();
    saveDraft(s, draftKey(1, 'comment', 5, 10), 'private');
    expect(loadDraft(s, draftKey(1, 'comment', 5, 11))).toBeNull();
    expect(loadDraft(s, draftKey(2, 'comment', 5, 10))).toBeNull();
    expect(loadDraft(s, draftKey(1, 'comment', 5, 10))).toBe('private');
  });
  it('clearAllDrafts removes drafts and nothing else', () => {
    const s = fake();
    saveDraft(s, draftKey(1, 'desc', 5, 10), 'a');
    saveDraft(s, draftKey(1, 'lane', 6, 11), 'b');
    s.setItem('other', 'keep');
    clearAllDrafts(s);
    expect(s.length).toBe(1);
    expect(s.getItem('other')).toBe('keep');
  });
});
