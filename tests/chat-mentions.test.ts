import {describe, expect, it} from 'vitest';

import type {MemberT} from '../src/app/chat/api';
import {allMentionIndexes, mentionsAll} from '../src/lib/mention-all';
import {insertMention, matchPeople, mentionAt, mentionedIds, segments} from '../src/app/chat/mentions';

const person = (userId: number, name: string): MemberT => ({userId, name, role: 'member', joinedAt: '', isMe: false, canManage: false});
const people = [person(1, 'Ann'), person(2, 'Ann Lee'), person(3, 'Bo')];

describe('chat mentions', () => {
  it('finds the @word at the caret only after whitespace or the start', () => {
    expect(mentionAt('hi @An', 6)).toEqual({start: 3, query: 'An'});
    expect(mentionAt('@', 1)).toEqual({start: 0, query: ''});
    expect(mentionAt('mail a@b', 8)).toBeNull();
    expect(matchPeople(people, mentionAt('hi @Zed there', 13)!.query)).toEqual([]);
  });
  it('matches by prefix first and inserts the name', () => {
    expect(matchPeople(people, 'an').map(p => p.userId)).toEqual([1, 2]);
    expect(matchPeople(people, 'ee').map(p => p.userId)).toEqual([2]);
    expect(insertMention('hi @An', 6, 3, 'Ann Lee')).toEqual({text: 'hi @Ann Lee ', caret: 12});
  });
  it('sends the ids of names still in the text, longest name first', () => {
    expect(mentionedIds('@Ann Lee please', people)).toEqual([2]);
    expect(mentionedIds('@Ann and @Bo', people).sort()).toEqual([1, 3]);
    expect(mentionedIds('@Annabel', people)).toEqual([]);
    expect(mentionedIds('mail@Bo', people)).toEqual([]);
  });
  it('splits a body into text, mentions and links without any HTML', () => {
    expect(segments('hi @Ann Lee, see https://x.test/a.', ['Ann Lee'])).toEqual([
      {kind: 'text', value: 'hi '},
      {kind: 'mention', value: '@Ann Lee'},
      {kind: 'text', value: ', see '},
      {kind: 'link', value: 'https://x.test/a'},
      {kind: 'text', value: '.'},
    ]);
    expect(segments('<b>x</b>', [])).toEqual([{kind: 'text', value: '<b>x</b>'}]);
    // A link safeUrl refuses (credentials) stays plain text.
    expect(segments('go https://u:p@x.test/a', []).some(s => s.kind === 'link')).toBe(false);
  });
});

import {cardTagAt, removeCardTag} from '../src/app/chat/mentions';

describe('card tags', () => {
  it('finds a #query after whitespace only', () => {
    expect(cardTagAt('see #fix lo', 11)).toEqual({start: 4, query: 'fix lo'});
    expect(cardTagAt('a#b', 3)).toBeNull();
    expect(cardTagAt('no tag', 6)).toBeNull();
  });
  it('removes the query being typed', () => {
    expect(removeCardTag('see #fix', 8, 4)).toEqual({text: 'see ', caret: 4});
  });
});

describe('@all', () => {
  it('finds @all only as a whole word after the start, whitespace or markup', () => {
    expect(allMentionIndexes('hlo @all done?')).toEqual([4]);
    expect(allMentionIndexes('@All, look')).toEqual([0]);
    expect(allMentionIndexes('(@all)')).toEqual([1]);
    expect(allMentionIndexes('mail@all.com @allison @all_x')).toEqual([]);
    expect(mentionsAll('nothing here')).toBe(false);
  });
  it('renders @all as a mention, without breaking named people', () => {
    expect(segments('hlo @all done', [])).toEqual([
      {kind: 'text', value: 'hlo '},
      {kind: 'mention', value: '@all'},
      {kind: 'text', value: ' done'},
    ]);
    expect(segments('@Ann and @all', ['Ann']).filter(s => s.kind === 'mention').map(s => s.value)).toEqual(['@Ann', '@all']);
  });
  it('never sends @all as a person id', () => {
    expect(mentionedIds('@all please', people)).toEqual([]);
  });
});
