import {describe, expect, it} from 'vitest';

import {
  checkCard,
  checkLabels,
  checkLanes,
  chunkCards,
  dayOf,
  IMPORT_LIMITS,
  isImportId,
  jsonBytes,
  parseTrelloExport,
  trelloColor,
  type ImpCard,
} from '../src/lib/trello-import';

const trello = (over: Record<string, unknown> = {}) => ({
  name: 'Roadmap',
  lists: [
    {id: 'l2', name: 'Doing', closed: false, pos: 20},
    {id: 'l1', name: 'To do', closed: false, pos: 10},
    {id: 'l3', name: 'Old', closed: true, pos: 30},
  ],
  labels: [
    {id: 'b1', name: 'Bug', color: 'red'},
    {id: 'b2', name: '', color: 'green_dark'},
  ],
  cards: [
    {id: 'c2', idList: 'l1', name: 'Second', desc: 'two', closed: false, pos: 200, idLabels: ['b2'], idMembers: ['m1'], due: '2026-03-04T10:00:00.000Z', dueComplete: true},
    {id: 'c1', idList: 'l1', name: 'First', desc: '**bold** <script>alert(1)</script>', closed: false, pos: 100, idLabels: ['b1', 'nope'], idMembers: [], due: null,
      attachments: [{name: 'Spec', url: 'https://example.test/spec.pdf', isUpload: false}, {name: 'bad', url: 'javascript:alert(1)'}, {name: 'up', url: 'https://trello.com/1/x', isUpload: true}]},
    {id: 'c3', idList: 'l2', name: 'Third', desc: '', closed: false, pos: 5, idLabels: []},
    {id: 'c4', idList: 'l1', name: 'Archived', closed: true, pos: 1},
    {id: 'c5', idList: 'l3', name: 'In an archived list', closed: false, pos: 1},
  ],
  checklists: [
    {id: 'k1', idCard: 'c1', name: 'Steps', pos: 1, checkItems: [{name: 'b', state: 'incomplete', pos: 2}, {name: 'a', state: 'complete', pos: 1}]},
  ],
  actions: [
    {type: 'commentCard', date: '2026-01-02T00:00:00.000Z', data: {text: 'later', card: {id: 'c1'}}, memberCreator: {fullName: 'Ann Lee', username: 'ann'}},
    {type: 'commentCard', date: '2026-01-01T00:00:00.000Z', data: {text: 'earlier', card: {id: 'c1'}}, memberCreator: {username: 'bob'}},
    {type: 'updateCard', date: '2026-01-01T00:00:00.000Z', data: {card: {id: 'c1'}}},
  ],
  ...over,
});

describe('parseTrelloExport', () => {
  it('turns an export into lanes, labels and cards in board order', () => {
    const r = parseTrelloExport(trello());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.board.name).toBe('Roadmap');
    expect(r.plan.lanes.map(l => l.name)).toEqual(['To do', 'Doing']); // by pos, archived list skipped
    expect(r.plan.cards.map(c => c.ext)).toEqual(['c1', 'c2', 'c3']); // lane order, then card pos
    expect(r.plan.labels).toEqual([
      {ext: 'b1', name: 'Bug', color: '#EB5A46'},
      {ext: 'b2', name: 'green dark', color: '#61BD4F'}, // a nameless label takes its colour's name
    ]);
    const first = r.plan.cards[0]!;
    expect(first.labels).toEqual(['b1']); // unknown label ids are dropped
    expect(first.checklists).toEqual([{name: 'Steps', items: [{text: 'a', done: true}, {text: 'b', done: false}]}]);
    expect(first.comments.map(c => [c.by, c.text])).toEqual([['bob', 'earlier'], ['Ann Lee', 'later']]); // oldest first, names not ids
    expect(r.plan.cards[1]).toMatchObject({due: '2026-03-04', done: true});
  });

  it('keeps Markdown as plain text and only http(s) links; attachments are never fetched', () => {
    const r = parseTrelloExport(trello());
    if (!r.ok) throw new Error('parse');
    const first = r.plan.cards[0]!;
    expect(first.desc).toContain('<script>'); // stored as text; the Markdown renderer escapes it
    expect(first.links.map(l => l.url)).toEqual(['https://example.test/spec.pdf', 'https://trello.com/1/x']);
  });

  it('counts what it skipped and what it cannot carry over', () => {
    const r = parseTrelloExport(trello());
    if (!r.ok) throw new Error('parse');
    const w = Object.fromEntries(r.warnings.map(x => [x.code, x.count]));
    expect(w).toMatchObject({archived_lists: 1, archived_cards: 1, orphan_cards: 1, members_not_imported: 1, uploads_not_copied: 1});
    expect(r.summary).toMatchObject({lanes: 2, cards: 3, labels: 2, checklists: 1, checklistItems: 2, comments: 2, links: 2, maxLaneCards: 2});
  });

  it('refuses what is not a Trello export', () => {
    expect(parseTrelloExport(null)).toEqual({ok: false, error: 'not_trello'});
    expect(parseTrelloExport([])).toEqual({ok: false, error: 'not_trello'});
    expect(parseTrelloExport({lists: 'x', cards: []})).toEqual({ok: false, error: 'not_trello'});
    expect(parseTrelloExport({name: 'x', lists: [], cards: []})).toEqual({ok: false, error: 'empty'});
  });

  it('survives hostile input without throwing and caps every size', () => {
    const huge = 'x'.repeat(50_000);
    const r = parseTrelloExport(
      trello({
        name: huge,
        cards: [{id: 'c1', idList: 'l1', name: huge, desc: huge, closed: false, pos: 1, due: 'not a date', idLabels: [1, null, {}], attachments: 7}, {id: '../evil', idList: 'l1', name: 'bad id'}, 'x', null],
        checklists: [{idCard: 'c1', name: huge, checkItems: [{name: huge}, {name: ''}, null]}],
        labels: [{id: 'b1', name: huge, color: 'chartreuse'}],
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.plan.cards[0]!;
    expect(r.plan.board.name.length).toBeLessThanOrEqual(IMPORT_LIMITS.name);
    expect(c.title.length).toBeLessThanOrEqual(IMPORT_LIMITS.title);
    expect(c.desc.length).toBeLessThanOrEqual(IMPORT_LIMITS.desc);
    expect(c.due).toBeNull();
    expect(r.plan.cards).toHaveLength(1); // an unsafe external id is dropped
    expect(r.plan.labels[0]).toMatchObject({color: '#8B8F97'});
    expect(jsonBytes(c)).toBeLessThanOrEqual(IMPORT_LIMITS.cardBytes);
    expect(checkCard(c).ok).toBe(true); // what the parser makes, the server accepts
  });

  it('caps lanes, cards and per-card extras and says so', () => {
    const lists = Array.from({length: 60}, (_, i) => ({id: `l${i}`, name: `L${i}`, pos: i}));
    const cards = Array.from({length: 600}, (_, i) => ({id: `c${i}`, idList: 'l0', name: `C${i}`, pos: i}));
    const actions = Array.from({length: 30}, (_, i) => ({type: 'commentCard', date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`, data: {text: `t${i}`, card: {id: 'c0'}}}));
    const r = parseTrelloExport({name: 'Big', lists, cards, actions});
    if (!r.ok) throw new Error('parse');
    expect(r.plan.lanes).toHaveLength(IMPORT_LIMITS.lanes);
    expect(r.plan.cards).toHaveLength(IMPORT_LIMITS.cardsPerLane);
    expect(r.plan.cards[0]!.comments).toHaveLength(IMPORT_LIMITS.comments);
    const w = Object.fromEntries(r.warnings.map(x => [x.code, x.count]));
    expect(w).toMatchObject({lanes_over_limit: 10, cards_over_limit: 100, comments_dropped: 10});
  });

  it('shrinks one oversized card until it fits a chunk', () => {
    const comments = Array.from({length: 20}, (_, i) => ({type: 'commentCard', date: '2026-01-01T00:00:00Z', data: {text: 'é'.repeat(2000) + i, card: {id: 'c1'}}}));
    const r = parseTrelloExport({name: 'x', lists: [{id: 'l1', name: 'A'}], cards: [{id: 'c1', idList: 'l1', name: 't', desc: '日'.repeat(10_000)}], actions: comments});
    if (!r.ok) throw new Error('parse');
    expect(jsonBytes(r.plan.cards[0])).toBeLessThanOrEqual(IMPORT_LIMITS.cardBytes);
  });
});

describe('helpers', () => {
  it('maps colours and dates', () => {
    expect(trelloColor('blue_light')).toBe('#0079BF');
    expect(trelloColor(null)).toBe('#8B8F97');
    expect(dayOf('2026-02-30T00:00:00Z')).toBeNull();
    expect(dayOf('2026-12-31T23:59:59Z')).toBe('2026-12-31');
    expect(dayOf(5)).toBeNull();
  });
  it('accepts only sane import keys', () => {
    expect(isImportId('3f2b1c9e-1111-4222-8333-444455556666')).toBe(true);
    expect(isImportId('short')).toBe(false);
    expect(isImportId("x'; drop table")).toBe(false);
  });
});

describe('chunkCards', () => {
  const card = (i: number, desc = ''): ImpCard => ({ext: `c${i}`, lane: 'l1', title: `T${i}`, desc, due: null, done: false, labels: [], checklists: [], comments: [], links: []});
  it('packs at most 40 cards per request, in order, none lost', () => {
    const cards = Array.from({length: 95}, (_, i) => card(i));
    const chunks = chunkCards(cards);
    expect(chunks.map(c => c.length)).toEqual([40, 40, 15]);
    expect(chunks.flat().map(c => c.ext)).toEqual(cards.map(c => c.ext));
  });
  it('splits on bytes too, so a request stays under the 64 KB body limit', () => {
    const cards = Array.from({length: 10}, (_, i) => card(i, 'x'.repeat(9000)));
    for (const chunk of chunkCards(cards)) expect(jsonBytes({importId: 'a'.repeat(36), cards: chunk})).toBeLessThan(64 * 1024);
    expect(chunkCards(cards).length).toBeGreaterThan(1);
    expect(chunkCards([])).toEqual([]);
  });
});

describe('strict checks (what the server accepts)', () => {
  const ok = {ext: 'c1', lane: 'l1', title: ' Hi ', desc: '', due: '2026-01-31', done: false, labels: ['b1', 'b1'], checklists: [], comments: [], links: []};
  it('accepts a normalized card and trims the title', () => {
    const r = checkCard(ok);
    expect(r.ok && r.value).toMatchObject({title: 'Hi', labels: ['b1']});
  });
  it.each([
    ['not an object', 'x'],
    ['bad ext', {...ok, ext: '../x'}],
    ['empty title', {...ok, title: '  '}],
    ['long title', {...ok, title: 'x'.repeat(201)}],
    ['NUL in text', {...ok, desc: 'a\u0000b'}],
    ['bad date', {...ok, due: '2026-02-30'}],
    ['bad done', {...ok, done: 'yes'}],
    ['javascript link', {...ok, links: [{name: 'x', url: 'javascript:alert(1)'}]}],
    ['credentials in link', {...ok, links: [{name: 'x', url: 'https://u:p@example.test/'}]}],
    ['too many comments', {...ok, comments: Array.from({length: 21}, () => ({by: 'a', at: '', text: 't'}))}],
    ['bad item', {...ok, checklists: [{name: 'c', items: [{text: '', done: false}]}]}],
  ])('refuses %s', (_name, value) => {
    expect(checkCard(value).ok).toBe(false);
  });
  it('checks lanes and labels', () => {
    expect(checkLanes([{ext: 'a', name: 'A'}, {ext: 'a', name: 'B'}]).ok).toBe(false); // duplicate ext
    expect(checkLanes(Array.from({length: 51}, (_, i) => ({ext: `l${i}`, name: 'x'}))).ok).toBe(false);
    expect(checkLanes([{ext: 'a', name: ' A '}])).toEqual({ok: true, value: [{ext: 'a', name: 'A'}]});
    expect(checkLabels([{ext: 'a', name: 'x', color: '#abcdef'}])).toEqual({ok: true, value: [{ext: 'a', name: 'x', color: '#ABCDEF'}]});
    expect(checkLabels([{ext: 'a', name: 'x', color: 'red'}]).ok).toBe(false);
  });
});
