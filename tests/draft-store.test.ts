import {describe, expect, it} from 'vitest';

import {clearDraft, DRAFT_TTL_MS, draftKey, type DraftStorage, loadDraft, pruneDrafts, restoreDraft, saveDraft} from '../src/app/draft-store';

function fake(): DraftStorage & {data: Map<string, string>} {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: k => void data.delete(k),
  };
}

describe('draft store', () => {
  it('keys by workspace, kind and id', () => {
    expect(draftKey(1, 'comment', 5)).not.toBe(draftKey(2, 'comment', 5));
    expect(draftKey(1, 'comment', 5)).not.toBe(draftKey(1, 'desc', 5));
    const kinds = ['desc', 'comment', 'item', 'lane', 'cedit', 'itemedit', 'checklist', 'newlist', 'title', 'board', 'sfname', 'wsname', 'newboard', 'capture', 'label', 'chat', 'reply'] as const;
    expect(new Set(kinds.map(k => draftKey(1, k, 5))).size).toBe(kinds.length);
  });
  it('saves and loads only the text', () => {
    const s = fake();
    saveDraft(s, 'k', 'hello', 1000);
    expect(JSON.parse(s.data.get('k')!)).toEqual({t: 'hello', at: 1000});
    expect(loadDraft(s, 'k', 2000)).toBe('hello');
  });
  it('expires after 24 h and removes it', () => {
    const s = fake();
    saveDraft(s, 'k', 'hello', 0);
    expect(loadDraft(s, 'k', DRAFT_TTL_MS - 1)).toBe('hello');
    expect(loadDraft(s, 'k', DRAFT_TTL_MS)).toBeNull();
    expect(s.data.has('k')).toBe(false);
  });
  it('drops empty text, clears, and survives garbage', () => {
    const s = fake();
    saveDraft(s, 'k', 'x', 0);
    saveDraft(s, 'k', '  ', 0);
    expect(s.data.has('k')).toBe(false);
    s.data.set('k', '{nope');
    expect(loadDraft(s, 'k')).toBeNull();
    expect(s.data.has('k')).toBe(false);
    saveDraft(s, 'k', 'x');
    clearDraft(s, 'k');
    expect(loadDraft(s, 'k')).toBeNull();
  });
  it('never throws when storage does or is missing', () => {
    const broken = {...fake(), getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('x'); }} as DraftStorage;
    expect(() => saveDraft(broken, 'k', 'x')).not.toThrow();
    expect(loadDraft(broken, 'k')).toBeNull();
    expect(() => clearDraft(broken, 'k')).not.toThrow();
    expect(loadDraft(null, 'k')).toBeNull();
    expect(() => saveDraft(null, 'k', 'x')).not.toThrow();
  });
  it('restores only into an untouched field', () => {
    expect(restoreDraft('', '', 'kept')).toBe('kept');
    expect(restoreDraft('old text', 'old text', 'kept')).toBe('kept');
    expect(restoreDraft('typed', '', 'kept')).toBeNull();
    expect(restoreDraft('', '', null)).toBeNull();
    expect(restoreDraft('same', 'same', 'same')).toBeNull();
  });
  it('prunes expired drafts and leaves other keys', () => {
    const s = fake();
    saveDraft(s, draftKey(1, 'desc', 1), 'old', 0);
    saveDraft(s, draftKey(1, 'desc', 2), 'new', DRAFT_TTL_MS);
    s.data.set('other', 'keep');
    pruneDrafts(s, DRAFT_TTL_MS + 1);
    expect([...s.data.keys()].sort()).toEqual([draftKey(1, 'desc', 2), 'other'].sort());
  });
});
