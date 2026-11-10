import {describe, expect, it} from 'vitest';

import {groupDrop, type BulkUndoStep, runUndoSteps, selectKeyCardId} from '../src/app/boards/bulk-run';

const step = (action: string, cardIds: number[]): BulkUndoStep => ({action, cardIds, ifUnchangedSince: '5'});

describe('runUndoSteps', () => {
  it('replays the steps in order and adds up the answers', async () => {
    const seen: string[] = [];
    const result = await runUndoSteps([step('a', [1]), step('b', [2, 3])], async s => {
      seen.push(s.action);
      return {changed: s.cardIds.length, skipped: s.action === 'b' ? 1 : undefined};
    });
    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({changed: 3, skipped: 1, failed: null});
  });
  it('stops at the first failure and keeps what was already taken back', async () => {
    const boom = new Error('full');
    const seen: string[] = [];
    const result = await runUndoSteps([step('a', [1]), step('b', [2]), step('c', [3])], async s => {
      seen.push(s.action);
      if (s.action === 'b') throw boom;
      return {changed: 1};
    });
    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({changed: 1, skipped: 0, failed: boom});
  });
  it('an empty list does nothing', async () => {
    expect(await runUndoSteps([], async () => ({changed: 9}))).toEqual({changed: 0, skipped: 0, failed: null});
  });
});

describe('groupDrop', () => {
  const ids = new Set([1, 2, 3]);
  it('returns every ticked id when the dragged card is one of several ticked', () => {
    expect(groupDrop({mode: true, ids}, 2)).toEqual([1, 2, 3]);
  });
  it('is a plain single drag for an unticked card, one ticked card, or outside select mode', () => {
    expect(groupDrop({mode: true, ids}, 9)).toBeNull();
    expect(groupDrop({mode: true, ids: new Set([1])}, 1)).toBeNull();
    expect(groupDrop({mode: false, ids}, 2)).toBeNull();
  });
});

describe('selectKeyCardId (the x key)', () => {
  const key = {key: 'x', code: 'KeyX', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false};
  const card = (id: string) => ({getAttribute: (n: string) => (n === 'data-card-id' ? id : null)});
  const inCard = (tagName: string, id = '12', extra: Record<string, unknown> = {}) => ({tagName, closest: (sel: string) => (sel === 'li[data-card-id]' ? card(id) : null), ...extra});

  it('gives the id of the card holding the focus', () => {
    expect(selectKeyCardId(key, inCard('BUTTON'), 'x')).toBe(12);
  });
  it('works from the card\'s own tick (a checkbox is not typing)', () => {
    expect(selectKeyCardId(key, inCard('INPUT', '7', {type: 'checkbox'}), 'x')).toBe(7);
  });
  it('leaves the key alone while typing', () => {
    expect(selectKeyCardId(key, inCard('INPUT', '7', {type: 'text'}), 'x')).toBeNull();
    expect(selectKeyCardId(key, inCard('TEXTAREA'), 'x')).toBeNull();
    expect(selectKeyCardId(key, inCard('SELECT'), 'x')).toBeNull();
    expect(selectKeyCardId(key, inCard('DIV', '7', {isContentEditable: true}), 'x')).toBeNull();
  });
  it('leaves it alone with a modifier, a repeat, another letter or a handled event', () => {
    expect(selectKeyCardId({...key, ctrlKey: true}, inCard('BUTTON'), 'x')).toBeNull();
    expect(selectKeyCardId({...key, metaKey: true}, inCard('BUTTON'), 'x')).toBeNull();
    expect(selectKeyCardId({...key, altKey: true}, inCard('BUTTON'), 'x')).toBeNull();
    expect(selectKeyCardId({...key, shiftKey: true}, inCard('BUTTON'), 'x')).toBeNull();
    expect(selectKeyCardId({...key, repeat: true}, inCard('BUTTON'), 'x')).toBeNull();
    expect(selectKeyCardId({...key, defaultPrevented: true}, inCard('BUTTON'), 'x')).toBeNull();
    expect(selectKeyCardId(key, inCard('BUTTON'), 'y')).toBeNull();
  });
  it('needs focus inside a saved card', () => {
    expect(selectKeyCardId(key, {tagName: 'BODY', closest: () => null}, 'x')).toBeNull();
    expect(selectKeyCardId(key, null, 'x')).toBeNull();
    expect(selectKeyCardId(key, inCard('BUTTON', '-3'), 'x')).toBeNull();
    expect(selectKeyCardId(key, inCard('BUTTON', 'abc'), 'x')).toBeNull();
  });
});
