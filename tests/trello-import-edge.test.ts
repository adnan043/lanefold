import {describe, expect, it} from 'vitest';

import {
  checkCard,
  checkLabels,
  checkLanes,
  chunkCards,
  dayOf,
  IMPORT_LIMITS as L,
  jsonBytes,
  parseTrelloExport,
  trelloColor,
  type ImpCard,
} from '../src/lib/trello-import';

type Any = Record<string, unknown>;
const board = (over: Any = {}): Any => ({
  name: 'B',
  lists: [{id: 'l1', name: 'Todo', closed: false, pos: 1}],
  cards: [],
  labels: [],
  checklists: [],
  actions: [],
  ...over,
});
const card = (i: number | string, over: Any = {}): Any => ({id: `c${i}`, idList: 'l1', name: `Card ${i}`, desc: '', closed: false, pos: Number(i) || 0, idLabels: [], idMembers: [], ...over});
const ok = (json: unknown) => {
  const r = parseTrelloExport(json);
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r;
};
/** Everything parse makes must pass the server's strict check, or an import would fail half way. */
const expectRoundTrip = (cards: ImpCard[]) => {
  for (const c of cards) {
    const r = checkCard(JSON.parse(JSON.stringify(c)));
    expect(r.ok, JSON.stringify(c).slice(0, 200)).toBe(true);
  }
};

describe('parseTrelloExport: invalid shapes refuse cleanly', () => {
  it.each([
    [null],
    [undefined],
    [42],
    ['str'],
    [true],
    [[]],
    [[board()]],
    [{}],
    [{lists: {}, cards: []}],
    [{lists: [], cards: {}}],
    [{lists: 'x', cards: 'y'}],
    [{lists: null, cards: null}],
  ])('%j is not_trello', input => {
    expect(parseTrelloExport(input)).toEqual({ok: false, error: 'not_trello'});
  });

  it('empty arrays are "empty", not a crash', () => {
    expect(parseTrelloExport({lists: [], cards: []})).toEqual({ok: false, error: 'empty'});
  });

  it('survives garbage inside the arrays and in every optional field', () => {
    const r = parseTrelloExport(
      board({
        name: {x: 1},
        lists: [null, 1, 'x', [], {id: 'l1', name: 7, closed: 'yes', pos: 'a'}, {id: 5}, {id: 'l 2'}],
        labels: [null, 5, {id: 'b1', name: null, color: null}, {id: 'b2', name: 5, color: 5}, {id: 'b3', color: 'sky'}],
        cards: [null, 3, [], card(1, {name: 9, desc: {a: 1}, due: 5, idLabels: 'b1', idMembers: 'x', attachments: 'no'}), card(2, {idLabels: [1, null, 'b3', {}], attachments: [null, 1, {url: 5}]})],
        checklists: [null, {idCard: 'c1'}, {idCard: 'c1', name: 5, checkItems: 'x'}, {idCard: 'c1', checkItems: [null, {name: 5}, {name: 'ok', state: 'complete'}]}],
        actions: [null, 1, {type: 'commentCard'}, {type: 'commentCard', data: null}, {type: 'commentCard', data: {card: 5, text: 'x'}}, {type: 'commentCard', data: {card: {id: 'c1'}, text: 5}}, {type: 'commentCard', data: {card: {id: 'c1'}, text: 'hi'}, memberCreator: 'x', date: {}}],
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.board.name).toBe('Imported board');
    expect(r.plan.lanes).toEqual([{ext: 'l1', name: '(untitled)'}]);
    expect(r.plan.labels.map(l => l.ext)).toEqual(['b3']); // nameless AND colourless labels are skipped
    expect(r.plan.cards[0]!.title).toBe('(untitled)');
    expect(r.plan.cards[0]!.comments).toEqual([{by: 'Unknown', at: '', text: 'hi'}]);
    expect(r.plan.cards[0]!.checklists.flatMap(c => c.items)).toEqual([{text: 'ok', done: true}]);
    expectRoundTrip(r.plan.cards);
  });

  it('a Trello "actions" or "checklists" that is an object, not an array, is ignored', () => {
    const r = ok(board({cards: [card(1)], actions: {a: 1}, checklists: {a: 1}, labels: {a: 1}}));
    expect(r.plan.cards).toHaveLength(1);
  });
});

describe('parseTrelloExport: prototype pollution keys', () => {
  it('JSON.parse __proto__ / constructor keys do not pollute or break anything', () => {
    const text = `{"name":"x","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},
      "lists":[{"id":"l1","name":"L","__proto__":{"closed":true}}],
      "cards":[{"id":"c1","idList":"l1","name":"C","__proto__":{"closed":true},"constructor":"x","idLabels":["__proto__","constructor"]}],
      "labels":[{"id":"__proto__","name":"p","color":"red"},{"id":"constructor","name":"c","color":"blue"}]}`;
    const r = ok(JSON.parse(text));
    expect(({} as Any).polluted).toBeUndefined();
    expect(({} as Any).polluted2).toBeUndefined();
    expect(r.plan.lanes).toHaveLength(1);
    expect(r.plan.cards).toHaveLength(1);
    expect(r.plan.cards[0]!.labels.sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(r.plan)).toBe(Object.prototype);
  });

  it('ids named like Object.prototype members work as plain ids', () => {
    const ids = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
    const r = ok(
      board({
        lists: ids.map((id, i) => ({id, name: id, pos: i})),
        cards: ids.map((id, i) => card(i, {id: `${id}`, idList: id})),
        checklists: ids.map(id => ({idCard: id, name: 'c', checkItems: [{name: 'x', state: 'complete'}]})),
        actions: ids.map(id => ({type: 'commentCard', date: '2026-01-01T00:00:00Z', data: {text: 'hi', card: {id}}})),
      })
    );
    expect(r.plan.lanes.map(l => l.ext)).toEqual(ids);
    expect(r.plan.cards).toHaveLength(5);
    for (const c of r.plan.cards) {
      expect(c.checklists).toHaveLength(1);
      expect(c.comments).toHaveLength(1);
    }
    expect(r.summary.maxLaneCards).toBe(1);
  });

  it('checkLanes / checkLabels / checkCard accept prototype-named ids and keep result prototypes plain', () => {
    expect(checkLanes([{ext: '__proto__', name: 'a'}, {ext: 'constructor', name: 'b'}]).ok).toBe(true);
    expect(checkLabels([{ext: '__proto__', name: 'a', color: '#aabbcc'}]).ok).toBe(true);
    const raw = JSON.parse('{"__proto__":{"x":1},"ext":"c1","lane":"__proto__","title":"t","desc":"","due":null,"done":false,"labels":["__proto__","__proto__"],"checklists":[],"comments":[],"links":[]}');
    const r = checkCard(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.labels).toEqual(['__proto__']); // deduped
  });
});

describe('parseTrelloExport: duplicates', () => {
  // BUG: parse keeps duplicates (no de-duplication by id), the server then refuses the whole import.
  it('duplicate list ids still give the server unique lanes (checkLanes refuses duplicates)', () => {
    const r = ok(board({lists: [{id: 'l1', name: 'A', pos: 1}, {id: 'l1', name: 'B', pos: 2}], cards: [card(1)]}));
    expect(checkLanes(r.plan.lanes).ok).toBe(true);
  });
  // BUG: parse keeps duplicates (no de-duplication by id), the server then refuses the whole import.
  it('duplicate card ids produce unique cards', () => {
    const r = ok(board({cards: [card(1), card(1, {name: 'dup'})]}));
    expect(new Set(r.plan.cards.map(c => c.ext)).size).toBe(r.plan.cards.length);
  });
  // BUG: parse keeps duplicates (no de-duplication by id), the server then refuses the whole import.
  it('duplicate label ids give unique labels (checkLabels refuses duplicates)', () => {
    const r = ok(board({cards: [card(1)], labels: [{id: 'b1', name: 'A', color: 'red'}, {id: 'b1', name: 'B', color: 'blue'}]}));
    expect(checkLabels(r.plan.labels).ok).toBe(true);
  });
  it('a card with the same label twice keeps both ids parse-side but checkCard dedupes', () => {
    const r = ok(board({cards: [card(1, {idLabels: ['b1', 'b1']})], labels: [{id: 'b1', name: 'A', color: 'red'}]}));
    const c = checkCard(JSON.parse(JSON.stringify(r.plan.cards[0])));
    expect(c.ok && c.value.labels).toEqual(['b1']);
  });
});

describe('parseTrelloExport: archived, orphans, ordering', () => {
  it('counts archived lists, archived cards, and cards of archived or missing lists', () => {
    const r = ok(
      board({
        lists: [{id: 'l1', name: 'A', pos: 1}, {id: 'l2', name: 'Z', closed: true, pos: 2}],
        cards: [card(1), card(2, {closed: true}), card(3, {idList: 'l2'}), card(4, {idList: 'ghost'}), card(5, {idList: null}), card(6, {idList: undefined})],
      })
    );
    const w = Object.fromEntries(r.warnings.map(x => [x.code, x.count]));
    expect(w.archived_lists).toBe(1);
    expect(w.archived_cards).toBe(1);
    expect(w.orphan_cards).toBe(4);
    expect(r.plan.cards.map(c => c.ext)).toEqual(['c1']);
  });
  it('an export of only archived lists is "empty"', () => {
    expect(parseTrelloExport(board({lists: [{id: 'l1', name: 'A', closed: true}], cards: [card(1)]}))).toEqual({ok: false, error: 'empty'});
  });
  it('NaN / Infinity / string pos values do not break sorting', () => {
    const r = ok(board({cards: [card(1, {pos: 'x'}), card(2, {pos: null}), card(3, {pos: 5e300}), card(4, {pos: -1})]}));
    expect(r.plan.cards.map(c => c.ext)).toEqual(['c4', 'c1', 'c2', 'c3']);
  });
});

describe('parseTrelloExport: text, unicode, hostile strings', () => {
  const strings = {
    rtl: 'שלום עולם مرحبا بالعالم',
    emoji: '👨‍👩‍👧‍👦🏳️‍🌈 ship it 🚀',
    bidi: '‮evil‬ ⁦x⁩ ‏',
    cjk: '日本語のタスク',
    combining: 'é'.repeat(50),
    html: '<img src=x onerror=alert(1)> <script>x</script>',
    controls: 'a\u0000b\u0001c\u0008d\u000Be\u001Ff\u007Fg',
  };

  it('keeps legitimate unicode, strips control characters (but not newline or tab)', () => {
    const r = ok(board({cards: [card(1, {name: strings.rtl, desc: `${strings.emoji}\n\t${strings.bidi}`}), card(2, {name: strings.controls, desc: strings.controls + '\nkeep\ttab'}), card(3, {name: strings.html})]}));
    expect(r.plan.cards[0]!.title).toBe(strings.rtl);
    expect(r.plan.cards[0]!.desc).toBe(`${strings.emoji}\n\t${strings.bidi}`);
    expect(r.plan.cards[1]!.title).toBe('abcdefg');
    expect(r.plan.cards[1]!.desc).toBe('abcdefg\nkeep\ttab');
    expect(r.plan.cards[2]!.title).toBe(strings.html); // plain text: our renderer escapes, nothing here is HTML
    expect(JSON.stringify(r.plan)).not.toMatch(/\\u0000/);
    expectRoundTrip(r.plan.cards);
  });

  it('control-only and whitespace-only titles become "(untitled)"', () => {
    const r = ok(board({cards: [card(1, {name: '\u0000\u0001'}), card(2, {name: '   \n\t '})]}));
    expect(r.plan.cards.map(c => c.title)).toEqual(['(untitled)', '(untitled)']);
  });

  it('never splits a surrogate pair when shortening (emoji at the cut)', () => {
    const r = ok(board({name: '😀'.repeat(200), cards: [card(1, {name: '😀'.repeat(500), desc: '😀'.repeat(20_000)})]}));
    const c = r.plan.cards[0]!;
    for (const s of [r.plan.board.name, c.title, c.desc]) {
      // no lone surrogate at the end
      expect(/[\uD800-\uDBFF]$/.test(s)).toBe(false);
      expect(() => encodeURIComponent(s)).not.toThrow();
    }
    expect(c.title.length).toBeLessThanOrEqual(L.title);
    expect(c.desc.length).toBeLessThanOrEqual(L.desc);
    expect(r.plan.board.name.length).toBeLessThanOrEqual(L.name);
    expect(r.warnings.find(w => w.code === 'text_shortened')?.count).toBe(1);
  });

  it('very long everything stays inside every cap', () => {
    const long = 'x'.repeat(100_000);
    const r = ok(
      board({
        name: long,
        lists: [{id: 'l1', name: long, pos: 1}],
        labels: [{id: 'b1', name: long, color: 'red'}],
        cards: [card(1, {name: long, desc: long, idLabels: ['b1'], attachments: [{name: long, url: 'https://e.test/' + 'a'.repeat(100)}, {name: 'toolong', url: 'https://e.test/' + 'a'.repeat(600)}]})],
        checklists: [{idCard: 'c1', name: long, checkItems: [{name: long, state: 'complete'}]}],
        actions: [{type: 'commentCard', date: '2026-01-01T00:00:00Z', data: {text: long, card: {id: 'c1'}}, memberCreator: {fullName: long}}],
      })
    );
    const c = r.plan.cards[0]!;
    expect(r.plan.board.name).toHaveLength(L.name);
    expect(r.plan.lanes[0]!.name).toHaveLength(L.name);
    expect(r.plan.labels[0]!.name).toHaveLength(40);
    expect(c.title).toHaveLength(L.title);
    expect(c.desc.length).toBeLessThanOrEqual(L.desc);
    expect(c.checklists[0]!.name).toHaveLength(L.checklistName);
    expect(c.checklists[0]!.items[0]!.text).toHaveLength(L.itemText);
    expect(c.comments[0]!.text).toHaveLength(L.commentText);
    expect(c.comments[0]!.by).toHaveLength(L.author);
    expect(c.links).toHaveLength(1); // the 600 char URL is refused
    expect(c.links[0]!.name).toHaveLength(L.linkName);
    expect(jsonBytes(c)).toBeLessThanOrEqual(L.cardBytes);
    expectRoundTrip(r.plan.cards);
  });
});

describe('parseTrelloExport: checklists, comments, labels, links', () => {
  it('a checklist with no items is kept, empty-text items are dropped, a nameless checklist is "Checklist"', () => {
    const r = ok(
      board({
        cards: [card(1)],
        checklists: [{idCard: 'c1', name: 'Empty', checkItems: []}, {idCard: 'c1', checkItems: [{name: '   '}, {name: '\u0000'}], pos: 5}, {idCard: 'c1', name: 'nope'}],
      })
    );
    const cls = r.plan.cards[0]!.checklists;
    expect(cls.map(c => c.name)).toEqual(['Empty', 'nope', 'Checklist']);
    expect(cls.every(c => c.items.length === 0)).toBe(true);
    expect(r.summary.checklistItems).toBe(0);
    expectRoundTrip(r.plan.cards);
  });
  it('checklist for a card id that does not exist or is archived goes nowhere', () => {
    const r = ok(board({cards: [card(1, {closed: true}), card(2)], checklists: [{idCard: 'c1', name: 'x'}, {idCard: 'zzz', name: 'y'}]}));
    expect(r.plan.cards[0]!.checklists).toEqual([]);
  });
  it('comments from deleted members (no memberCreator, nulls, empty names) read "Unknown"', () => {
    const mk = (memberCreator: unknown, extra: Any = {}) => ({type: 'commentCard', date: '2026-01-01T00:00:00Z', data: {text: 'hi', card: {id: 'c1'}}, memberCreator, ...extra});
    const r = ok(board({cards: [card(1)], actions: [mk(undefined), mk(null), mk({}), mk({fullName: '', username: ''}), mk({fullName: '  '}), mk({username: 'ann'})]}));
    expect(r.plan.cards[0]!.comments.map(c => c.by)).toEqual(['Unknown', 'Unknown', 'Unknown', 'Unknown', 'Unknown', 'ann'].map(x => x)); // stable sort keeps input order
    expectRoundTrip(r.plan.cards);
  });
  it('comment dates in odd shapes become "" and never throw', () => {
    const mk = (date: unknown) => ({type: 'commentCard', date, data: {text: 't', card: {id: 'c1'}}});
    const r = ok(board({cards: [card(1)], actions: [mk(undefined), mk('garbage'), mk(12345), mk('2026-02-30T00:00:00Z'), mk('2026-03-04T10:00:00.000Z')]}));
    expect(r.plan.cards[0]!.comments.map(c => c.at).sort()).toEqual(['', '', '', '', '2026-03-04T10:00:00.000Z']);
    expectRoundTrip(r.plan.cards);
  });
  it('caps comments, checklists, items and links and warns', () => {
    const r = ok(
      board({
        cards: [card(1, {attachments: Array.from({length: 25}, (_, i) => ({name: `a${i}`, url: `https://e.test/${i}`}))})],
        checklists: Array.from({length: 30}, (_, i) => ({idCard: 'c1', name: `cl${i}`, pos: i, checkItems: Array.from({length: 3}, (_, j) => ({name: `i${j}`, pos: j}))})),
        actions: Array.from({length: 50}, (_, i) => ({type: 'commentCard', date: new Date(2026, 0, 1 + (i % 28)).toISOString(), data: {text: `c${i}`, card: {id: 'c1'}}})),
      })
    );
    const c = r.plan.cards[0]!;
    expect(c.links).toHaveLength(L.links);
    expect(c.checklists).toHaveLength(L.checklists);
    expect(c.comments).toHaveLength(L.comments);
    expect(jsonBytes(c)).toBeLessThanOrEqual(L.cardBytes);
    const codes = r.warnings.map(w => w.code);
    expect(codes).toEqual(expect.arrayContaining(['links_dropped', 'checklists_dropped', 'comments_dropped']));
    expectRoundTrip(r.plan.cards);
  });
  it('caps checklist items at 100 and warns', () => {
    const r = ok(board({cards: [card(1)], checklists: [{idCard: 'c1', name: 'big', checkItems: Array.from({length: 150}, (_, j) => ({name: `i${j}`, pos: j}))}]}));
    expect(r.plan.cards[0]!.checklists[0]!.items).toHaveLength(L.items);
    expect(r.warnings.find(w => w.code === 'items_dropped')?.count).toBe(50);
  });
  it('labels without names: colour name, "label", grey for unknown colours; dark/light variants map', () => {
    const r = ok(
      board({
        cards: [card(1)],
        labels: [{id: 'b1', name: '', color: 'sky_light'}, {id: 'b2', name: '  ', color: ''}, {id: 'b3', name: 'x', color: 'neon'}, {id: 'b4', name: 'y', color: 'BLACK_DARK'}, {id: 'b5', name: '', color: 'blue_dark'}],
      })
    );
    expect(r.plan.labels.map(l => [l.ext, l.name, l.color])).toEqual([
      ['b1', 'sky light', '#00C2E0'],
      ['b3', 'x', '#8B8F97'],
      ['b4', 'y', '#344563'],
      ['b5', 'blue dark', '#0079BF'],
    ]);
    expect(checkLabels(r.plan.labels).ok).toBe(true);
    expect(trelloColor(null)).toBe('#8B8F97');
  });
  // BUG: COLORS[base] is a plain-object lookup, so these return Object.prototype members (an object / function), not a hex string.
  it('trelloColor is grey for prototype-named colours', () => {
    for (const n of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(trelloColor(n)).toBe('#8B8F97');
  });
  it('a label whose colour is "__proto__" still passes checkLabels', () => {
    const r = ok(board({cards: [card(1)], labels: [{id: 'b1', name: 'x', color: '__proto__'}]}));
    expect(checkLabels(JSON.parse(JSON.stringify(r.plan.labels))).ok).toBe(true);
  });
  it('only plain http(s) links without credentials survive', () => {
    const urls = [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///tmp/secret.txt', 'ftp://x.test/f', 'mailto:a@b.c',
      'vbscript:x', 'blob:https://x.test/1', '//evil.test', '/relative', 'https://user:pw@x.test/', 'https://@x.test/', 'not a url', '', 'https://', 'http://[::1', 'trello.com/x',
      'https://ok.test/a b', 'HTTP://OK.TEST/UP',
    ];
    const r = ok(board({cards: [card(1, {attachments: urls.map(u => ({name: 'n', url: u})).concat([{name: 'n', url: null as never}, {name: 'n', url: 5 as never}])})]}));
    const links = r.plan.cards[0]!.links;
    for (const l of links) expect(l.url).toMatch(/^https?:\/\/[^@]*$/);
    expect(links.map(l => l.url)).toEqual(['https://x.test/', 'https://ok.test/a%20b', 'http://ok.test/UP']); // an empty-credential "https://@x.test/" is normalized, harmless
    expectRoundTrip(r.plan.cards);
  });
  it('a nameless attachment is named after its host; Trello uploads are counted', () => {
    const r = ok(board({cards: [card(1, {attachments: [{url: 'https://files.example.test/x.pdf'}, {name: 'f', url: 'https://trello.com/1/a', isUpload: true}]})]}));
    expect(r.plan.cards[0]!.links[0]!.name).toBe('files.example.test');
    expect(r.warnings.find(w => w.code === 'uploads_not_copied')?.count).toBe(1);
  });
});

describe('dayOf: odd date formats', () => {
  it.each([
    ['2026-03-04T10:00:00.000Z', '2026-03-04'],
    ['2026-03-04', '2026-03-04'],
    ['2026-03-04T23:30:00-05:00', '2026-03-05'],
    ['2026-03-04T00:30:00+05:00', '2026-03-03'],
    ['2024-02-29', '2024-02-29'],
  ])('%j -> %j', (i, o) => expect(dayOf(i)).toBe(o));
  it.each([
    ['2026-02-30'], ['2025-02-29'], ['2026-13-01'], ['2026-00-10'], ['2026-04-31T00:00:00Z'], ['0000-00-00'], [''], ['   '], ['tomorrow'], ['NaN'], ['+275760-09-13T00:00:00.000Z'],
    ['-000001-01-01T00:00:00Z'], [null], [undefined], [0], [1.7e12], [{}], [[]], [true],
  ])('%j -> null', i => expect(dayOf(i)).toBeNull());
  it('never throws on any odd string', () => {
    for (const s of ['\u0000', '9'.repeat(5000), '2026-03-04T', '2026-3-4', '04/03/2026', 'Mar 4, 2026', '２０２６-０３-０４']) expect(() => dayOf(s)).not.toThrow();
  });
  it('a card with a bad due keeps the card and drops the date', () => {
    const r = ok(board({cards: [card(1, {due: '2026-02-30'}), card(2, {due: 'soon'}), card(3, {due: '2026-03-04T10:00:00Z', dueComplete: 'yes'})]}));
    expect(r.plan.cards.map(c => c.due)).toEqual([null, null, '2026-03-04']);
    expect(r.plan.cards[2]!.done).toBe(false);
  });
});

describe('parseTrelloExport: huge boards near the caps', () => {
  it('caps lanes (50) and cards per lane (500) and cards overall (5000), counting the loss', () => {
    const lists = Array.from({length: 60}, (_, i) => ({id: `l${i}`, name: `L${i}`, pos: i}));
    const cards = Array.from({length: 7000}, (_, i) => card(i, {idList: `l${i % 20}`, pos: i})); // 350 per lane for 20 lanes
    const r = ok(board({lists, cards}));
    expect(r.plan.lanes).toHaveLength(L.lanes);
    expect(r.plan.cards).toHaveLength(7000 - 0 > L.cards ? L.cards : 7000);
    expect(r.summary.maxLaneCards).toBeLessThanOrEqual(L.cardsPerLane);
    const w = Object.fromEntries(r.warnings.map(x => [x.code, x.count]));
    expect(w.lanes_over_limit).toBe(10);
    expect(w.cards_over_limit).toBeGreaterThan(0);
    // lane order is kept, every card sits in a kept lane
    const kept = new Set(r.plan.lanes.map(l => l.ext));
    expect(r.plan.cards.every(c => kept.has(c.lane))).toBe(true);
  });
  it('501 cards in one lane: the 501st is dropped and counted', () => {
    const r = ok(board({cards: Array.from({length: 501}, (_, i) => card(i))}));
    expect(r.plan.cards).toHaveLength(500);
    expect(r.warnings.find(w => w.code === 'cards_over_limit')?.count).toBe(1);
    expect(r.summary.maxLaneCards).toBe(500);
  });
  it('exactly at the caps: nothing dropped, no over-limit warnings', () => {
    const lists = Array.from({length: L.lanes}, (_, i) => ({id: `l${i}`, name: `L${i}`, pos: i}));
    const labels = Array.from({length: L.labels}, (_, i) => ({id: `b${i}`, name: `B${i}`, color: 'red'}));
    const cards = Array.from({length: 100}, (_, i) => card(i, {idList: `l${i % L.lanes}`, idLabels: ['b0', `b${L.labels - 1}`]}));
    const r = ok(board({lists, labels, cards}));
    expect(r.plan.lanes).toHaveLength(L.lanes);
    expect(r.plan.labels).toHaveLength(L.labels);
    expect(r.warnings.filter(w => /over_limit/.test(w.code))).toEqual([]);
    expect(checkLanes(r.plan.lanes).ok).toBe(true);
    expect(checkLabels(r.plan.labels).ok).toBe(true);
  });
  it('labels over 50 are cut and card label ids pointing at cut labels are dropped', () => {
    const labels = Array.from({length: 80}, (_, i) => ({id: `b${i}`, name: `B${i}`, color: 'red'}));
    const r = ok(board({labels, cards: [card(1, {idLabels: ['b0', 'b79']})]}));
    expect(r.plan.labels).toHaveLength(L.labels);
    expect(r.plan.cards[0]!.labels).toEqual(['b0']);
    expect(r.warnings.find(w => w.code === 'labels_over_limit')?.count).toBe(30);
  });
  it('heavy cards (long text, 4-byte and lone-surrogate characters, comments, links) shrink to fit and chunk within byte caps', () => {
    const heavy = (i: number): Any => card(i, {name: '\uD800'.repeat(300), desc: '\uD83D'.repeat(10_000), attachments: Array.from({length: 10}, (_, k) => ({name: '😀'.repeat(100), url: `https://e.test/${'é'.repeat(100)}${k}`}))});
    const cards = Array.from({length: 60}, (_, i) => heavy(i));
    const actions = cards.flatMap(c => Array.from({length: 20}, (_, k) => ({type: 'commentCard', date: '2026-01-01T00:00:00Z', data: {text: '😀'.repeat(1000), card: {id: c.id}}, memberCreator: {fullName: 'x'.repeat(80)}, k})));
    const r = ok(board({cards, actions}));
    for (const c of r.plan.cards) expect(jsonBytes(c)).toBeLessThanOrEqual(L.cardBytes);
    const chunks = chunkCards(r.plan.cards);
    expect(chunks.flat()).toHaveLength(r.plan.cards.length);
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(L.chunkCards);
      expect(jsonBytes(ch)).toBeLessThanOrEqual(L.chunkBytes + 2);
    }
    expectRoundTrip(r.plan.cards);
  }, 20_000);

  // BUG (performance): fitCard pops one checklist item at a time and re-stringifies the whole card after each pop, which is
  // O(n^2). One card at the caps (20 checklists x 100 items x 300 chars) takes seconds of blocking CPU in the browser.
  it('one card at the checklist caps parses in under 1 second', () => {
    const t = Date.now();
    const checklists = Array.from({length: 20}, (_, k) => ({idCard: 'c1', name: 'c', pos: k, checkItems: Array.from({length: 100}, (_, j) => ({name: '日'.repeat(300), pos: j}))}));
    const r = ok(board({cards: [card(1)], checklists}));
    expect(jsonBytes(r.plan.cards[0]!)).toBeLessThanOrEqual(L.cardBytes);
    expect(Date.now() - t).toBeLessThan(1000);
  }, 60_000);
});

describe('chunkCards', () => {
  const mini = (i: number): ImpCard => ({ext: `c${i}`, lane: 'l1', title: 't', desc: '', due: null, done: false, labels: [], checklists: [], comments: [], links: []});
  it('empty in, no chunks out', () => expect(chunkCards([])).toEqual([]));
  it('keeps order and never makes an empty chunk', () => {
    const cards = Array.from({length: 85}, (_, i) => mini(i));
    const chunks = chunkCards(cards);
    expect(chunks.map(c => c.length)).toEqual([40, 40, 5]);
    expect(chunks.flat().map(c => c.ext)).toEqual(cards.map(c => c.ext));
  });
  it('a single card larger than the chunk still travels alone (never lost)', () => {
    const big = {...mini(1), desc: 'x'.repeat(60_000)};
    const chunks = chunkCards([mini(0), big, mini(2)]);
    expect(chunks.flat()).toHaveLength(3);
    expect(chunks.every(c => c.length > 0)).toBe(true);
  });
});

describe('strict check (server side) with hostile cards', () => {
  const good = (over: Any = {}): Any => ({ext: 'c1', lane: 'l1', title: 'T', desc: '', due: null, done: false, labels: [], checklists: [], comments: [], links: [], ...over});
  it.each([
    ['title NUL', {title: 'a\u0000b'}], ['title blank', {title: '   '}], ['title huge', {title: 'x'.repeat(201)}], ['ext bad', {ext: 'a b'}], ['ext __proto__ ok-shaped but long', {ext: 'x'.repeat(65)}],
    ['desc not string', {desc: null}], ['desc NUL', {desc: '\u0000'}], ['due odd', {due: '2026-02-30'}], ['due iso time', {due: '2026-03-04T00:00:00Z'}], ['due undefined', {due: undefined}], ['done string', {done: 'no'}],
    ['labels object', {labels: {a: 1}}], ['labels bad id', {labels: ['a b']}], ['labels too many', {labels: Array.from({length: 51}, (_, i) => `b${i}`)}],
    ['checklists object', {checklists: {}}], ['checklist item NUL', {checklists: [{name: 'c', items: [{text: 'a\u0000', done: false}]}]}], ['checklist item blank', {checklists: [{name: 'c', items: [{text: '', done: false}]}]}],
    ['checklist item done missing', {checklists: [{name: 'c', items: [{text: 'a'}]}]}], ['checklist items not array', {checklists: [{name: 'c', items: {}}]}], ['too many items', {checklists: [{name: 'c', items: Array.from({length: 101}, () => ({text: 'a', done: false}))}]}],
    ['comment date garbage', {comments: [{by: 'a', at: 'garbage', text: 't'}]}], ['comment date long', {comments: [{by: 'a', at: 'x'.repeat(31), text: 't'}]}], ['comment by empty', {comments: [{by: '', at: '', text: 't'}]}], ['too many comments', {comments: Array.from({length: 21}, () => ({by: 'a', at: '', text: 't'}))}],
    ['link js', {links: [{name: 'n', url: 'javascript:alert(1)'}]}], ['link data', {links: [{name: 'n', url: 'data:text/html,x'}]}], ['link creds', {links: [{name: 'n', url: 'https://a:b@x.test'}]}], ['link name empty', {links: [{name: '', url: 'https://x.test'}]}], ['link name NUL', {links: [{name: 'a\u0000', url: 'https://x.test'}]}],
    ['links too many', {links: Array.from({length: 11}, () => ({name: 'n', url: 'https://x.test'}))}],
  ])('refuses %s', (_n, over) => {
    const r = checkCard(good(over as Any));
    expect(r.ok).toBe(false);
  });
  it.each([[null], [undefined], [[]], ['x'], [5], [true]])('refuses non-object %j without throwing', v => expect(checkCard(v)).toEqual({ok: false, field: 'cards'}));
  it('checkLanes / checkLabels refuse duplicates, bad shapes and over-cap lists', () => {
    expect(checkLanes([{ext: 'a', name: 'x'}, {ext: 'a', name: 'y'}]).ok).toBe(false);
    expect(checkLanes({}).ok).toBe(false);
    expect(checkLanes(Array.from({length: 51}, (_, i) => ({ext: `l${i}`, name: 'x'}))).ok).toBe(false);
    expect(checkLanes([{ext: 'a', name: '  '}]).ok).toBe(false);
    expect(checkLanes([null]).ok).toBe(false);
    expect(checkLabels([{ext: 'a', name: 'x', color: 'red'}]).ok).toBe(false);
    expect(checkLabels([{ext: 'a', name: 'x', color: '#GGGGGG'}]).ok).toBe(false);
    expect(checkLabels(Array.from({length: 51}, (_, i) => ({ext: `b${i}`, name: 'x', color: '#AAAAAA'}))).ok).toBe(false);
  });

  // BUG: checkCard validates the link URL with httpUrl() but stores the ORIGINAL string, and (unlike the name) never
  // checks it for NUL. new URL() percent-encodes NUL, tabs and newlines are silently stripped, so these pass.
  it('refuses a link url holding a NUL (Postgres would reject the insert)', () => {
    expect(checkCard(good({links: [{name: 'n', url: 'https://x.test/a\u0000b'}]})).ok).toBe(false);
  });
  it('stores a normalized link url (no leading space, tab or newline smuggled in)', () => {
    const r = checkCard(good({links: [{name: 'n', url: ' https://x.test/a\tb\n'}]}));
    if (r.ok) expect(r.value.links[0]!.url).toBe('https://x.test/ab');
    else expect(r.ok).toBe(false);
  });
});
