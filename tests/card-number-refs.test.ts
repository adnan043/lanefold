import {describe, expect, it} from 'vitest';

import {segments} from '../src/app/chat/mentions';
import {distinctCardNumbers, findCardNumberRefs, MAX_REFS_PER_MESSAGE} from '../src/lib/card-number-refs';

const nums = (text: string) => findCardNumberRefs(text).map(r => r.number);

describe('#N references in chat text', () => {
  it('finds plain references with their positions', () => {
    expect(findCardNumberRefs('see #42 now')).toEqual([{start: 4, end: 7, number: 42}]);
    expect(nums('#1')).toEqual([1]);
    expect(nums('(#7), #8. #9!')).toEqual([7, 8, 9]);
    expect(nums('#1234567')).toEqual([1234567]);
  });

  it('ignores what is not a reference', () => {
    expect(nums('C#1 and a#1b and foo#42')).toEqual([]);
    expect(nums('#42abc #42_x #4x')).toEqual([]);
    expect(nums('#0 #007 #')).toEqual([]);
    expect(nums('#12345678')).toEqual([]); // more than 7 digits
    expect(nums('no hash here')).toEqual([]);
    expect(nums('##42')).toEqual([]);
  });

  it('ignores code spans, code blocks and web addresses', () => {
    expect(nums('run `git log #42` then #43')).toEqual([43]);
    expect(nums('```\n#1\n#2\n```\n#3')).toEqual([3]);
    expect(nums('https://example.test/issues#42 and #44')).toEqual([44]);
    expect(nums('http://x.test/a/#5')).toEqual([]);
  });

  it('works next to non-Latin letters and punctuation', () => {
    expect(nums('কার্ড #12 দেখুন')).toEqual([12]);
    expect(nums('كارت #5')).toEqual([5]);
    expect(nums('বাংলা#5')).toEqual([]);
  });

  it('distinct numbers are unique, in first-seen order and capped', () => {
    expect(distinctCardNumbers('#3 #1 #3 #2 #1')).toEqual([3, 1, 2]);
    const many = Array.from({length: 40}, (_, i) => `#${i + 1}`).join(' ');
    expect(distinctCardNumbers(many)).toHaveLength(MAX_REFS_PER_MESSAGE);
    // A huge message of repeats stays cheap and bounded.
    expect(findCardNumberRefs('#1 '.repeat(5000), 50)).toHaveLength(50);
  });
});

describe('segments with card numbers', () => {
  it('makes a segment only for numbers the server resolved', () => {
    const out = segments('fix #42 and #43 today', [], new Set([42]));
    expect(out).toEqual([
      {kind: 'text', value: 'fix '},
      {kind: 'card', value: '#42', number: 42},
      {kind: 'text', value: ' and #43 today'},
    ]);
  });

  it('keeps plain text when nothing resolved', () => {
    expect(segments('fix #42', [])).toEqual([{kind: 'text', value: 'fix #42'}]);
    expect(segments('fix #42', [], new Set())).toEqual([{kind: 'text', value: 'fix #42'}]);
  });

  it('works with mentions and links in the same message', () => {
    const out = segments('@Ann see #5 https://example.test/a#5', ['Ann'], new Set([5]));
    expect(out.map(s => s.kind)).toEqual(['mention', 'text', 'card', 'text', 'link']);
    expect(out.find(s => s.kind === 'link')).toMatchObject({value: 'https://example.test/a#5'});
  });
});
