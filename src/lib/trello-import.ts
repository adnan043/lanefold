/**
 * Import from a Trello export (Phase 8). PURE: no I/O, no React, no DOM, so the browser (parse, dry run, chunking)
 * and the server (strict re-validation of every chunk) use the very same rules, and the unit tests call it directly.
 *
 * What comes in is untrusted JSON. What goes out is a small normalized plan (lanes, labels, cards with their
 * checklists, comments and link attachments) whose every string is length-capped. Trello's Markdown is kept as plain
 * text: our renderer is the safe one (nothing here becomes HTML). Attachments are NEVER downloaded: only their
 * http(s) address is kept as a link. Members are NOT mapped (that would need other people's email addresses):
 * a comment's author is written into the comment text as "imported by <name>".
 */

export const IMPORT_LIMITS = {
  /** Largest export file the browser will read. */
  fileBytes: 20 * 1024 * 1024,
  lanes: 50,
  labels: 50,
  cards: 5000,
  /** Same safety cap as `MAX_CARDS_PER_LANE` on the server. */
  cardsPerLane: 500,
  chunkCards: 40,
  /** One request carries at most this many bytes of cards (the Site API body limit is 64 KB). */
  chunkBytes: 48_000,
  /** One card, serialized, never exceeds this (so it always fits a chunk). */
  cardBytes: 40_000,
  name: 80,
  title: 200,
  desc: 10_000,
  checklists: 20,
  checklistName: 100,
  items: 100,
  itemText: 300,
  comments: 20,
  commentText: 2000,
  author: 80,
  links: 10,
  linkName: 200,
  url: 500,
  ext: 64,
} as const;

export type ImpLane = {ext: string; name: string};
export type ImpLabel = {ext: string; name: string; color: string};
export type ImpChecklist = {name: string; items: {text: string; done: boolean}[]};
export type ImpComment = {by: string; at: string; text: string};
export type ImpLink = {name: string; url: string};
export type ImpCard = {
  ext: string;
  lane: string;
  title: string;
  desc: string;
  /** `YYYY-MM-DD` or null. */
  due: string | null;
  done: boolean;
  /** External label ids. */
  labels: string[];
  checklists: ImpChecklist[];
  comments: ImpComment[];
  links: ImpLink[];
};

export type ImportSummary = {
  boardName: string;
  lanes: number;
  labels: number;
  cards: number;
  checklists: number;
  checklistItems: number;
  comments: number;
  links: number;
  /** The most cards any one lane would hold. */
  maxLaneCards: number;
};

export type ImportWarning = {
  code:
    | 'archived_lists'
    | 'archived_cards'
    | 'orphan_cards'
    | 'members_not_imported'
    | 'uploads_not_copied'
    | 'text_shortened'
    | 'comments_dropped'
    | 'items_dropped'
    | 'checklists_dropped'
    | 'links_dropped'
    | 'cards_over_limit'
    | 'lanes_over_limit'
    | 'labels_over_limit';
  count: number;
};

export type ImportPlan = {
  board: {name: string};
  lanes: ImpLane[];
  labels: ImpLabel[];
  cards: ImpCard[];
};

export type ParseResult =
  | {ok: true; plan: ImportPlan; summary: ImportSummary; warnings: ImportWarning[]}
  | {ok: false; error: 'not_json' | 'not_trello' | 'empty'};

/* ------------------------------------------------------------------ helpers */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const EXT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_RE = /^#[0-9A-F]{6}$/;

/** UTF-8 length of the JSON form (what the request body will weigh). */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Control characters other than newline and tab never reach the database (Postgres refuses NUL). */
const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end);
}

const pos = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const byPos = <T extends Obj>(a: T, b: T) => pos(a.pos) - pos(b.pos);

/** Trello label colour names to the hex values Lanefold stores. Unknown or missing colours become grey. */
const COLORS: Record<string, string> = {
  green: '#61BD4F',
  yellow: '#F2D600',
  orange: '#FF9F1A',
  red: '#EB5A46',
  purple: '#C377E0',
  blue: '#0079BF',
  sky: '#00C2E0',
  lime: '#51E898',
  pink: '#FF78CB',
  black: '#344563',
};
const GREY = '#8B8F97';
export const trelloColor = (name: unknown): string => {
  const base = str(name).toLowerCase().replace(/_(dark|light)$/, '');
  return Object.hasOwn(COLORS, base) ? COLORS[base]! : GREY;
};

/** `2026-03-04T10:00:00.000Z` to `2026-03-04`, or null when it is not a real date. */
export function dayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // JavaScript rolls "02-30" over to March; a date that does not exist stays invalid here.
  const head = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  if (head) {
    const probe = new Date(`${head}T00:00:00.000Z`);
    if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== head) return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.toISOString().slice(0, 10);
  return /^\d{4}-/.test(day) ? day : null;
}

const httpUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > IMPORT_LIMITS.url || /\u0000/.test(v)) return null;
  try {
    const u = new URL(v);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    return u.toString().slice(0, IMPORT_LIMITS.url);
  } catch {
    return null;
  }
};

/** Keeps the first row of each id. */
const firstById = (rows: Obj[]): Obj[] => {
  const seen = new Set<string>();
  return rows.filter(r => !seen.has(str(r.id)) && !!seen.add(str(r.id)));
};

/* -------------------------------------------------------------------- parse */

/**
 * `json` is the parsed export (`JSON.parse` of the file; the caller catches a syntax error and says `not_json`).
 * Archived (closed) lists and cards are skipped and counted in the warnings.
 */
export function parseTrelloExport(json: unknown): ParseResult {
  if (!isObj(json) || !Array.isArray(json.lists) || !Array.isArray(json.cards)) return {ok: false, error: 'not_trello'};

  const warn = new Map<ImportWarning['code'], number>();
  const bump = (code: ImportWarning['code'], n = 1) => {
    if (n > 0) warn.set(code, (warn.get(code) ?? 0) + n);
  };

  const boardName = cut(clean(str(json.name)).trim(), IMPORT_LIMITS.name) || 'Imported board';

  // Lanes: open lists in board order, capped.
  const openLists = firstById((json.lists as unknown[]).filter(isObj).filter(l => EXT_RE.test(str(l.id))));
  bump('archived_lists', openLists.filter(l => l.closed === true).length);
  const lists = openLists.filter(l => l.closed !== true).sort(byPos);
  bump('lanes_over_limit', Math.max(0, lists.length - IMPORT_LIMITS.lanes));
  const lanes: ImpLane[] = lists.slice(0, IMPORT_LIMITS.lanes).map(l => ({
    ext: str(l.id),
    name: cut(clean(str(l.name)).trim(), IMPORT_LIMITS.name) || '(untitled)',
  }));
  const laneIds = new Set(lanes.map(l => l.ext));

  // Labels: the board's own, capped. A nameless label takes its colour's name.
  const labelRows = firstById(arr(json.labels).filter(isObj).filter(l => EXT_RE.test(str(l.id)) && (str(l.name).trim() || str(l.color))));
  bump('labels_over_limit', Math.max(0, labelRows.length - IMPORT_LIMITS.labels));
  const labels: ImpLabel[] = labelRows.slice(0, IMPORT_LIMITS.labels).map(l => ({
    ext: str(l.id),
    name: cut(clean(str(l.name)).trim() || str(l.color).replace(/_/g, ' '), 40) || 'label',
    color: trelloColor(l.color),
  }));
  const labelIds = new Set(labels.map(l => l.ext));

  // Checklists and comments, grouped by card.
  const checklistsBy = new Map<string, Obj[]>();
  for (const cl of arr(json.checklists).filter(isObj)) {
    const key = str(cl.idCard);
    if (key) (checklistsBy.get(key) ?? checklistsBy.set(key, []).get(key)!).push(cl);
  }
  const commentsBy = new Map<string, {by: string; at: string; text: string; time: number}[]>();
  for (const action of arr(json.actions).filter(isObj)) {
    if (action.type !== 'commentCard' || !isObj(action.data) || !isObj(action.data.card)) continue;
    const key = str(action.data.card.id);
    const text = clean(str(action.data.text)).trim();
    if (!key || !text) continue;
    const creator = isObj(action.memberCreator) ? action.memberCreator : {};
    const by = cut(clean(str(creator.fullName) || str(creator.username)).trim(), IMPORT_LIMITS.author) || 'Unknown';
    const at = dayOf(action.date) ? new Date(str(action.date)).toISOString() : '';
    (commentsBy.get(key) ?? commentsBy.set(key, []).get(key)!).push({by, at, text, time: at ? Date.parse(at) : 0});
  }

  // Cards: open cards of kept lanes, per lane in card order.
  const allCards = firstById((json.cards as unknown[]).filter(isObj).filter(c => EXT_RE.test(str(c.id))));
  bump('archived_cards', allCards.filter(c => c.closed === true).length);
  const open = allCards.filter(c => c.closed !== true);
  const placed = open.filter(c => laneIds.has(str(c.idList)));
  bump('orphan_cards', open.length - placed.length);
  const laneOrder = new Map(lanes.map((l, i) => [l.ext, i]));
  placed.sort((a, b) => laneOrder.get(str(a.idList))! - laneOrder.get(str(b.idList))! || byPos(a, b));
  bump('cards_over_limit', Math.max(0, placed.length - IMPORT_LIMITS.cards));

  const cards: ImpCard[] = [];
  const perLane = new Map<string, number>();
  let membersSkipped = 0;
  let uploadsSkipped = 0;
  let shortened = 0;
  for (const raw of placed) {
    if (cards.length >= IMPORT_LIMITS.cards) break;
    const lane = str(raw.idList);
    const inLane = perLane.get(lane) ?? 0;
    if (inLane >= IMPORT_LIMITS.cardsPerLane) {
      bump('cards_over_limit');
      continue;
    }
    perLane.set(lane, inLane + 1);
    const ext = str(raw.id);
    if (arr(raw.idMembers).length) membersSkipped++;

    const rawTitle = clean(str(raw.name)).trim();
    const title = cut(rawTitle, IMPORT_LIMITS.title) || '(untitled)';
    const rawDesc = clean(str(raw.desc));
    const desc = cut(rawDesc, IMPORT_LIMITS.desc);
    if (title.length < rawTitle.length || desc.length < rawDesc.length) shortened++;

    const checklistRows = (checklistsBy.get(ext) ?? []).sort(byPos);
    bump('checklists_dropped', Math.max(0, checklistRows.length - IMPORT_LIMITS.checklists));
    const checklists: ImpChecklist[] = checklistRows.slice(0, IMPORT_LIMITS.checklists).map(cl => {
      const itemRows = arr(cl.checkItems).filter(isObj).sort(byPos);
      bump('items_dropped', Math.max(0, itemRows.length - IMPORT_LIMITS.items));
      return {
        name: cut(clean(str(cl.name)).trim(), IMPORT_LIMITS.checklistName) || 'Checklist',
        items: itemRows
          .slice(0, IMPORT_LIMITS.items)
          .map(it => ({text: cut(clean(str(it.name)).trim(), IMPORT_LIMITS.itemText), done: it.state === 'complete'}))
          .filter(it => it.text.length > 0),
      };
    });

    const commentRows = (commentsBy.get(ext) ?? []).sort((a, b) => a.time - b.time);
    bump('comments_dropped', Math.max(0, commentRows.length - IMPORT_LIMITS.comments));
    const comments: ImpComment[] = commentRows.slice(0, IMPORT_LIMITS.comments).map(c => ({
      by: c.by,
      at: c.at,
      text: cut(c.text, IMPORT_LIMITS.commentText),
    }));

    const links: ImpLink[] = [];
    let linkRows = 0;
    for (const a of arr(raw.attachments).filter(isObj)) {
      const url = httpUrl(a.url);
      if (!url) continue;
      if (a.isUpload === true) {
        // A file Trello hosts: its address needs a Trello sign-in, so it stays a link and is counted.
        uploadsSkipped++;
      }
      linkRows++;
      if (links.length < IMPORT_LIMITS.links) {
        links.push({name: cut(clean(str(a.name)).trim() || new URL(url).hostname, IMPORT_LIMITS.linkName), url});
      }
    }
    bump('links_dropped', Math.max(0, linkRows - IMPORT_LIMITS.links));

    cards.push(
      fitCard({
        ext,
        lane,
        title,
        desc,
        due: dayOf(raw.due),
        done: raw.dueComplete === true,
        labels: arr(raw.idLabels).filter((id): id is string => typeof id === 'string' && labelIds.has(id)),
        checklists,
        comments,
        links,
      })
    );
  }
  bump('members_not_imported', membersSkipped);
  bump('uploads_not_copied', uploadsSkipped);
  bump('text_shortened', shortened);

  if (cards.length === 0 && lanes.length === 0) return {ok: false, error: 'empty'};

  const plan: ImportPlan = {board: {name: boardName}, lanes, labels, cards};
  return {
    ok: true,
    plan,
    summary: summarize(plan),
    warnings: [...warn.entries()].map(([code, count]) => ({code, count})),
  };
}

/** Drops comments, links, then checklist items from the end until one card fits `cardBytes`; last, shortens the text. */
export function fitCard(card: ImpCard): ImpCard {
  // Sizes are computed once; removing the last element of an array of n saves its bytes plus one comma when n > 1.
  let total = jsonBytes(card);
  const max = IMPORT_LIMITS.cardBytes;
  const drop = (size: number, n: number) => {
    total -= size + (n > 1 ? 1 : 0);
  };
  while (total > max && card.comments.length) drop(jsonBytes(card.comments.pop()), card.comments.length + 1);
  while (total > max && card.links.length) drop(jsonBytes(card.links.pop()), card.links.length + 1);
  while (total > max && card.checklists.length) {
    const last = card.checklists[card.checklists.length - 1]!;
    if (last.items.length) drop(jsonBytes(last.items.pop()), last.items.length + 1);
    else drop(jsonBytes(card.checklists.pop()), card.checklists.length + 1);
  }
  if (total > max) {
    total = jsonBytes(card);
    while (total > max && card.desc.length > 0) {
      card.desc = cut(card.desc, Math.floor(card.desc.length / 2));
      total = jsonBytes(card);
    }
  }
  return card;
}

export function summarize(plan: ImportPlan): ImportSummary {
  const perLane = new Map<string, number>();
  let checklists = 0;
  let checklistItems = 0;
  let comments = 0;
  let links = 0;
  for (const c of plan.cards) {
    perLane.set(c.lane, (perLane.get(c.lane) ?? 0) + 1);
    checklists += c.checklists.length;
    for (const cl of c.checklists) checklistItems += cl.items.length;
    comments += c.comments.length;
    links += c.links.length;
  }
  return {
    boardName: plan.board.name,
    lanes: plan.lanes.length,
    labels: plan.labels.length,
    cards: plan.cards.length,
    checklists,
    checklistItems,
    comments,
    links,
    maxLaneCards: Math.max(0, ...perLane.values()),
  };
}

/** Packs cards, in order, into requests of at most `chunkCards` cards and `chunkBytes` bytes. */
export function chunkCards(cards: readonly ImpCard[]): ImpCard[][] {
  const chunks: ImpCard[][] = [];
  let current: ImpCard[] = [];
  let bytes = 0;
  for (const card of cards) {
    const size = jsonBytes(card) + 1;
    if (current.length && (current.length >= IMPORT_LIMITS.chunkCards || bytes + size > IMPORT_LIMITS.chunkBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(card);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/* ------------------------------------------------- strict check (the server) */

export type Checked<T> = {ok: true; value: T} | {ok: false; field: string};
const bad = (field: string): {ok: false; field: string} => ({ok: false, field});

const okStr = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max && !/\u0000/.test(v);

export const isImportId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{8,40}$/.test(v);

export function checkLanes(v: unknown): Checked<ImpLane[]> {
  if (!Array.isArray(v) || v.length > IMPORT_LIMITS.lanes) return bad('lanes');
  const seen = new Set<string>();
  const out: ImpLane[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !okStr(raw.ext, 1, IMPORT_LIMITS.ext) || !EXT_RE.test(raw.ext) || seen.has(raw.ext)) return bad('lanes');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!okStr(name, 1, IMPORT_LIMITS.name)) return bad('lanes');
    seen.add(raw.ext);
    out.push({ext: raw.ext, name});
  }
  return {ok: true, value: out};
}

export function checkLabels(v: unknown): Checked<ImpLabel[]> {
  if (!Array.isArray(v) || v.length > IMPORT_LIMITS.labels) return bad('labels');
  const seen = new Set<string>();
  const out: ImpLabel[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !okStr(raw.ext, 1, IMPORT_LIMITS.ext) || !EXT_RE.test(raw.ext) || seen.has(raw.ext)) return bad('labels');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const color = typeof raw.color === 'string' ? raw.color.toUpperCase() : '';
    if (!okStr(name, 1, 40) || !HEX_RE.test(color)) return bad('labels');
    seen.add(raw.ext);
    out.push({ext: raw.ext, name, color});
  }
  return {ok: true, value: out};
}

/** One card of a chunk, exactly as `parseTrelloExport` makes it. Anything else is refused, never repaired. */
export function checkCard(raw: unknown): Checked<ImpCard> {
  if (!isObj(raw)) return bad('cards');
  const L = IMPORT_LIMITS;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!okStr(raw.ext, 1, L.ext) || !EXT_RE.test(raw.ext)) return bad('cards.ext');
  if (!okStr(raw.lane, 1, L.ext) || !EXT_RE.test(raw.lane)) return bad('cards.lane');
  if (!okStr(title, 1, L.title)) return bad('cards.title');
  if (typeof raw.desc !== 'string' || raw.desc.length > L.desc || /\u0000/.test(raw.desc)) return bad('cards.desc');
  let due: string | null = null;
  if (raw.due !== null) {
    if (typeof raw.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.due)) return bad('cards.due');
    const d = new Date(`${raw.due}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw.due) return bad('cards.due');
    due = raw.due;
  }
  if (typeof raw.done !== 'boolean') return bad('cards.done');
  if (!Array.isArray(raw.labels) || raw.labels.length > L.labels || !raw.labels.every(x => typeof x === 'string' && EXT_RE.test(x))) return bad('cards.labels');
  if (!Array.isArray(raw.checklists) || raw.checklists.length > L.checklists) return bad('cards.checklists');
  const checklists: ImpChecklist[] = [];
  for (const cl of raw.checklists) {
    if (!isObj(cl) || !okStr(cl.name, 1, L.checklistName) || !Array.isArray(cl.items) || cl.items.length > L.items) return bad('cards.checklists');
    const items: ImpChecklist['items'] = [];
    for (const it of cl.items) {
      if (!isObj(it) || !okStr(it.text, 1, L.itemText) || typeof it.done !== 'boolean') return bad('cards.checklists');
      items.push({text: it.text, done: it.done});
    }
    checklists.push({name: cl.name, items});
  }
  if (!Array.isArray(raw.comments) || raw.comments.length > L.comments) return bad('cards.comments');
  const comments: ImpComment[] = [];
  for (const c of raw.comments) {
    if (!isObj(c) || !okStr(c.by, 1, L.author) || !okStr(c.text, 1, L.commentText) || typeof c.at !== 'string' || c.at.length > 30) return bad('cards.comments');
    if (c.at !== '' && Number.isNaN(Date.parse(c.at))) return bad('cards.comments');
    comments.push({by: c.by, at: c.at, text: c.text});
  }
  if (!Array.isArray(raw.links) || raw.links.length > L.links) return bad('cards.links');
  const links: ImpLink[] = [];
  for (const l of raw.links) {
    if (!isObj(l) || !okStr(l.name, 1, L.linkName) || !httpUrl(l.url)) return bad('cards.links');
    links.push({name: l.name, url: httpUrl(l.url)!});
  }
  return {
    ok: true,
    value: {ext: raw.ext, lane: raw.lane, title, desc: raw.desc, due, done: raw.done, labels: [...new Set(raw.labels as string[])], checklists, comments, links},
  };
}
