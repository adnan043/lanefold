import {describe, expect, it} from 'vitest';

import {descriptionFromMessage, titleFromMessage} from '../src/lib/card-from-message';

describe('titleFromMessage', () => {
  it('uses the first non-empty line, whitespace collapsed', () => {
    expect(titleFromMessage('\n\n  Fix   the   login \nmore detail')).toBe('Fix the login');
    expect(titleFromMessage('one\r\ntwo')).toBe('one');
  });
  it('cuts to 120 characters with an ellipsis', () => {
    const t = titleFromMessage('a'.repeat(300));
    expect(Array.from(t)).toHaveLength(120);
    expect(t.endsWith('…')).toBe(true);
    expect(titleFromMessage('b'.repeat(120))).toBe('b'.repeat(120));
  });
  it('never splits an emoji and falls back when empty', () => {
    expect(Array.from(titleFromMessage('😀'.repeat(200)))).toHaveLength(120);
    expect(titleFromMessage('  \n ')).toBe('Untitled');
    expect(titleFromMessage('', '')).toBe('');
  });
});

describe('descriptionFromMessage', () => {
  it('keeps the text and adds the back-reference', () => {
    expect(descriptionFromMessage(' hello ', '#general')).toBe('hello\n\n---\n*From chat: #general*');
  });

  it('cuts the text by code points and keeps the footer', () => {
    const out = descriptionFromMessage('😀'.repeat(50), '#g', 30);
    expect(Array.from(out).length).toBeLessThanOrEqual(30);
    expect(out.endsWith('\n\n---\n*From chat: #g*')).toBe(true);
    expect(out).not.toContain('\uFFFD');
  });
});
