import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {useI18n} from '../../i18n';
import {call} from '../api';
import type {ChatFileT} from '../../lib/chat-files';
import {idleMs, type MessagePage, type MessageT, newClientId, removeUnsentFile, useVisibleInterval} from './api';
import {windowDelayMs} from './poll-timing';

export type PendingMessage = {
  clientId: string;
  body: string;
  mentions: number[];
  cardIds?: number[];
  /** Files already uploaded, sent with it (kept for a retry; taken out again when the message is discarded). */
  files?: ChatFileT[];
  parentId: string | null;
  status: 'sending' | 'failed';
  error?: string;
  createdAt: string;
};

type Options = {
  conversationId: number;
  /** A thread: only the replies of this message. */
  parentId?: string | null;
  /** The conversation's `lastSeq` from the pulse: when it grows past what we know, fetch what is new. */
  pulseSeq?: number;
  /**
   * The conversation's `editRev` from the pulse: it moves on edits, deletes, reactions, pins, linked cards and new
   * replies. While it is known the window is re-read only when it moves (and every few minutes as a safety net).
   */
  pulseEditRev?: number;
  /** A fallback poll of `after` on this interval, for a list with no pulse (off by default: threads follow the pulse too). */
  pollMs?: number | null;
  me: number | undefined;
};

/** The window refresh's timer ticks this often; `windowDelayMs` decides whether a tick refreshes (slower when idle). */
const WINDOW_MS = 20_000;
/** Every this many window refreshes, ONE older page already open is re-read too (round robin): ~100 s per page. */
const OLDER_EVERY = 5;
/** With the pulse's `editRev` to go by: the window is still re-read this often (permissions, an archive, a deleted card). */
const WINDOW_SAFETY_MS = 3 * 60_000;
/**
 * The most messages a list keeps. Back at the newest, the oldest are dropped (Load older brings them back); while
 * the reader is further up, the newest far below them are dropped (`trimNewest`; scrolling down loads them again).
 */
export const MAX_KEPT = 300;

const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is) =>
  a === b || (a.length === b.length && a.every((x, i) => same(x, b[i]!)));

/**
 * Two copies of one message show the same thing: compares the fields a message can change (edit, delete, pin,
 * reactions, replies, resolved card numbers) without serialising either. Cheap enough for every refresh.
 */
export function sameMessage(a: MessageT, b: MessageT): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.seq !== b.seq ||
    a.body !== b.body ||
    a.edited !== b.edited ||
    a.deleted !== b.deleted ||
    a.pinned !== b.pinned ||
    a.replyCount !== b.replyCount ||
    a.kind !== b.kind ||
    a.parentId !== b.parentId ||
    a.createdAt !== b.createdAt ||
    a.conversationId !== b.conversationId ||
    a.sender.id !== b.sender.id ||
    a.sender.name !== b.sender.name
  ) {
    return false;
  }
  if (!sameList(a.mentions, b.mentions) || !sameList(a.cardIds, b.cardIds)) return false;
  if (!sameList(a.files ?? [], b.files ?? [], (x, y) => x.id === y.id && x.name === y.name)) return false;
  if (!sameList(a.mentionNames ?? [], b.mentionNames ?? [])) return false;
  if (!sameList(a.reactions, b.reactions, (x, y) => x.emoji === y.emoji && x.count === y.count && x.mine === y.mine)) return false;
  const ra = a.numberRefs;
  const rb = b.numberRefs;
  if (ra === rb) return true;
  if (!ra || !rb) return false;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  return keys.every(k => {
    const x = ra[Number(k)];
    const y = rb[Number(k)];
    return !!x && !!y && x.id === y.id && x.boardId === y.boardId && x.title === y.title;
  });
}

/**
 * Merges fetched messages into the list by id, oldest first. Returns `prev` itself when nothing changed, and keeps
 * every unchanged message object, so memoised rows skip re-rendering on a refresh.
 */
export function mergeMessages(prev: MessageT[], incoming: readonly MessageT[]): MessageT[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map(m => [m.id, m]));
  let changed = false;
  let appendOnly = true;
  const last = prev.length ? prev[prev.length - 1]!.seq : -Infinity;
  for (const m of incoming) {
    const old = byId.get(m.id);
    if (old && sameMessage(old, m)) continue;
    if (old || m.seq <= last) appendOnly = false;
    byId.set(m.id, m);
    changed = true;
  }
  if (!changed) return prev;
  const all = [...byId.values()];
  // New messages only (the usual poll): already in order after the old ones unless they came out of order.
  return appendOnly && all.every((m, i) => i === 0 || all[i - 1]!.seq < m.seq) ? all : all.sort((a, b) => a.seq - b.seq);
}

/**
 * The transport of one message list (SPEC §8: polling; a push channel would replace only this hook).
 *   - first load: the newest 50 (`GET …/messages`), older pages by `before=<seq>`,
 *   - new messages: `?after=<known seq>` when the pulse says the conversation moved (a thread too: a reply moves its
 *     conversation's `lastSeq`, so the thread fetches only when something was written there or nearby),
 *   - edits, deletes and reactions are NOT seen by `after`, so the newest window is refetched every 20 s
 *     (and when the tab comes back) and merged by id; every 5th refresh also re-reads ONE older page already open,
 *     in turn, so a change far up the list shows within a few minutes without re-reading every page each time,
 *   - back at the newest, a list longer than `MAX_KEPT` drops its oldest messages (`trim`; Load older reloads them);
 *     read further up, it drops the newest instead (`trimNewest`), and `loadNewer` pages them back in with `after`.
 *     While newer messages are dropped (`hasNewer`) nothing new is appended (it would leave a gap),
 *   - the window refresh slows down while the person is idle (`windowDelayMs`) and never runs in a hidden tab,
 *   - a sent message shows at once as pending; a failed one keeps its `clientId`, so Retry never duplicates it.
 */
export function useMessageFeed({conversationId, parentId = null, pulseSeq, pulseEditRev, pollMs = null, me}: Options) {
  const {errorMessage} = useI18n();
  const [items, setItems] = useState<MessageT[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const [canWrite, setCanWrite] = useState(true);
  const [canModerate, setCanModerate] = useState(false);
  const [archived, setArchived] = useState(false);
  /** The seq of the newest message held while newer ones were dropped (`trimNewest`); null = the list reaches the newest. */
  const [newerCursor, setNewerCursorState] = useState<number | null>(null);
  const newerRef = useRef<number | null>(null);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const lastWindow = useRef(0);
  /** `before` cursors of the older pages already loaded: the refresh re-reads one of them now and then, in turn. */
  const olderCursors = useRef<number[]>([]);
  const ticks = useRef(0);
  /** The `editRev` the list last showed (from a page), or null before the first page. */
  const seenRev = useRef<number | null>(null);
  const olderTurn = useRef(0);
  const pulseRev = useRef(pulseEditRev);
  pulseRev.current = pulseEditRev;
  const [known, setKnown] = useState(0);
  const knownRef = useRef(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const refreshing = useRef(false);
  const sending = useRef(0);

  const base = `/conversations/${conversationId}/messages`;
  const url = useCallback(
    (params: Record<string, string | number | undefined>) => {
      const q = new URLSearchParams();
      if (parentId) q.set('parent', parentId);
      for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
      const s = q.toString();
      return s ? `${base}?${s}` : base;
    },
    [base, parentId]
  );

  const merge = useCallback((incoming: MessageT[]) => {
    if (incoming.length === 0) return;
    setItems(prev => mergeMessages(prev, incoming));
  }, []);

  const setNewerCursor = useCallback((seq: number | null) => {
    newerRef.current = seq;
    setNewerCursorState(seq);
  }, []);

  const setKnownSeq = useCallback((seq: number) => {
    if (seq > knownRef.current) {
      knownRef.current = seq;
      setKnown(seq);
    }
  }, []);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setStatus('loading');
    setError(null);
    try {
      const page = await call<MessagePage>('GET', url({}));
      if (mine !== generation.current) return;
      setItems(page.items);
      setNextBefore(page.nextBefore);
      setNewerCursor(null);
      setCanWrite(page.canWrite);
      setCanModerate(page.canModerate ?? false);
      setArchived(page.archived ?? false);
      lastWindow.current = Date.now();
      seenRev.current = page.editRev ?? null;
      knownRef.current = page.lastSeq;
      setKnown(page.lastSeq);
      setStatus('ready');
    } catch (e) {
      if (mine !== generation.current) return;
      setError(e);
      setStatus('error');
    }
  }, [url, setNewerCursor]);

  useEffect(() => {
    setItems([]);
    setPending([]);
    setNextBefore(null);
    setNewerCursor(null);
    olderCursors.current = [];
    knownRef.current = 0;
    setKnown(0);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load, setNewerCursor]);

  /**
   * The newest page again, replacing the list (jump back to the newest after the newer messages were dropped, or
   * after a send from a list that does not reach the newest). No loading state: the old rows stay until it answers.
   */
  const reloadNewest = useCallback(async () => {
    const mine = generation.current;
    try {
      const page = await call<MessagePage>('GET', url({}));
      if (mine !== generation.current) return;
      olderCursors.current = [];
      setItems(page.items);
      setNextBefore(page.nextBefore);
      setNewerCursor(null);
      setCanWrite(page.canWrite);
      if (page.canModerate !== undefined) setCanModerate(page.canModerate);
      setArchived(page.archived ?? false);
      seenRev.current = page.editRev ?? seenRev.current;
      setKnownSeq(page.lastSeq);
    } catch {
      // Quiet: the list keeps what it shows; the next refresh or a click tries again.
    }
  }, [url, setNewerCursor, setKnownSeq]);

  /** New messages since what we know; loops while the server says there are more. Quiet on errors (the next tick retries). */
  const poll = useCallback(async () => {
    // A list that does not reach the newest (`hasNewer`) appends nothing: `loadNewer` fills it in order.
    if (busy.current || sending.current > 0 || status !== 'ready' || newerRef.current !== null) return;
    busy.current = true;
    const mine = generation.current;
    try {
      for (let round = 0; round < 10; round += 1) {
        const page = await call<MessagePage>('GET', url({after: knownRef.current}));
        if (mine !== generation.current) return;
        merge(page.items);
        setCanWrite(page.canWrite);
        setArchived(page.archived ?? false);
        const last = page.items[page.items.length - 1];
        if (page.more && last) setKnownSeq(last.seq);
        else {
          setKnownSeq(page.lastSeq);
          break;
        }
      }
    } catch {
      // The next tick tries again.
    } finally {
      busy.current = false;
    }
  }, [url, merge, setKnownSeq, status]);

  /** The newest window again: shows edits, deletes and reactions that `after` cannot. */
  const refreshWindow = useCallback(async (changed = false) => {
    if (busy.current || refreshing.current || sending.current > 0 || status !== 'ready') return;
    refreshing.current = true;
    lastWindow.current = Date.now();
    const mine = generation.current;
    // What the pulse said when this started: a list not at the newest reads no window, yet has caught up to it.
    const startRev = pulseRev.current;
    try {
      // The newest window only when the list reaches the newest: merged into a list missing the newer messages it
      // would leave a gap.
      if (newerRef.current === null) {
        const page = await call<MessagePage>('GET', url({}));
        if (mine !== generation.current || sending.current > 0) return;
        merge(page.items);
        setCanWrite(page.canWrite);
        if (page.canModerate !== undefined) setCanModerate(page.canModerate);
        setArchived(page.archived ?? false);
        seenRev.current = Math.max(seenRev.current ?? 0, page.editRev ?? startRev ?? 0);
      } else if (startRev !== undefined) seenRev.current = Math.max(seenRev.current ?? 0, startRev);
      // Older pages already open: edits, deletes and pins there too, newest first, in turn: one page on each refresh a
      // change started, else one every OLDER_EVERY refreshes.
      ticks.current += 1;
      const cursors = olderCursors.current;
      if (cursors.length > 0 && (changed || ticks.current % OLDER_EVERY === 0)) {
        olderTurn.current += 1;
        const before = cursors[cursors.length - 1 - ((olderTurn.current - 1) % cursors.length)]!;
        const older = await call<MessagePage>('GET', url({before}));
        if (mine !== generation.current || sending.current > 0) return;
        // Only what the list still holds: a page reaches below its cursor, so after a trim it would otherwise bring
        // the dropped messages back (and the list would grow past MAX_KEPT, trim, and bounce).
        if (older.items.length > 0) {
          setItems(prev => {
            const floor = prev[0]?.seq;
            // ...and nothing past the newest held while newer messages are dropped.
            const ceiling = newerRef.current === null ? Infinity : (prev[prev.length - 1]?.seq ?? Infinity);
            const kept = floor === undefined ? older.items : older.items.filter(m => m.seq >= floor && m.seq <= ceiling);
            return kept.length === 0 ? prev : mergeMessages(prev, kept);
          });
        }
      }
    } catch {
      // Quiet: the next refresh tries again.
    } finally {
      refreshing.current = false;
    }
  }, [url, merge, status]);

  // The pulse moved past what we know.
  useEffect(() => {
    if (pulseSeq !== undefined && pulseSeq > knownRef.current) void poll();
  }, [pulseSeq, poll]);
  // Something changed that `after` cannot see (an edit, a reaction…): the window again, at once.
  useEffect(() => {
    if (pulseEditRev !== undefined && seenRev.current !== null && pulseEditRev > seenRev.current) void refreshWindow(true);
  }, [pulseEditRev, refreshWindow]);
  useVisibleInterval(() => void poll(), pollMs);
  // Ticks every 20 s in a visible tab. With the pulse's editRev: a refresh when it moved (one the effect above could
  // not start), else only the slow safety net. Without it (a channel not joined yet): the idle-aware delay (20 s
  // active, then 1 and 3 min).
  useVisibleInterval(() => {
    const since = Date.now() - lastWindow.current;
    const rev = pulseRev.current;
    if (rev !== undefined && seenRev.current !== null) {
      if (rev > seenRev.current) void refreshWindow(true);
      else if (since >= Math.max(WINDOW_SAFETY_MS, windowDelayMs(idleMs())) - 1000) void refreshWindow();
      return;
    }
    if (since >= windowDelayMs(idleMs()) - 1000) void refreshWindow();
  }, status === 'ready' ? WINDOW_MS : null);
  useEffect(() => {
    const wake = () => {
      if (!document.hidden) {
        void poll();
        void refreshWindow();
      }
    };
    document.addEventListener('visibilitychange', wake);
    return () => document.removeEventListener('visibilitychange', wake);
  }, [poll, refreshWindow]);

  const loadOlder = useCallback(async () => {
    if (nextBefore === null || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    const mine = generation.current;
    // The oldest message held is the cursor (the server's `nextBefore` is that same seq; after a trim it is the only
    // right one).
    const before = items[0]?.seq ?? nextBefore;
    try {
      const page = await call<MessagePage>('GET', url({before}));
      if (mine !== generation.current) return;
      merge(page.items);
      olderCursors.current.push(before);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setOlderError(e);
    } finally {
      setLoadingOlder(false);
    }
  }, [nextBefore, loadingOlder, url, merge, items]);

  /**
   * The newer messages dropped by `trimNewest`, one page at a time (`after` the newest held, oldest first). When the
   * last page comes back the list reaches the newest again and polling appends as before.
   */
  const loadNewer = useCallback(async () => {
    const from = newerRef.current;
    if (from === null || loadingNewer) return;
    setLoadingNewer(true);
    const mine = generation.current;
    try {
      const page = await call<MessagePage>('GET', url({after: from}));
      if (mine !== generation.current || newerRef.current !== from) return;
      merge(page.items);
      const last = page.items[page.items.length - 1];
      if (page.more && last) setNewerCursor(last.seq);
      else {
        setNewerCursor(null);
        setKnownSeq(page.lastSeq);
      }
    } catch {
      // Quiet: scrolling down (or the button) tries again.
    } finally {
      setLoadingNewer(false);
    }
  }, [loadingNewer, url, merge, setNewerCursor, setKnownSeq]);

  /**
   * Keeps the oldest `MAX_KEPT` messages and drops the newest past them (the list calls it while the reader is far up
   * and the dropped rows are well below the screen). `loadNewer` brings them back.
   */
  const trimNewest = useCallback(() => {
    if (loadingNewer || items.length <= MAX_KEPT) return;
    const newest = items[MAX_KEPT - 1]!.seq;
    setItems(prev => (prev.length > MAX_KEPT ? prev.slice(0, MAX_KEPT) : prev));
    setNewerCursor(newest);
  }, [items, loadingNewer, setNewerCursor]);

  /** Drops the oldest messages past `MAX_KEPT` (the list calls it while the reader is at the newest). */
  const trim = useCallback(() => {
    if (loadingOlder || items.length <= MAX_KEPT) return;
    const oldest = items[items.length - MAX_KEPT]!.seq;
    // A page whose cursor is at or below the oldest kept message is gone entirely: stop refreshing it (it would
    // bring the dropped messages back).
    olderCursors.current = olderCursors.current.filter(c => c > oldest);
    // An updater, so a message merged meanwhile is never lost; `loadOlder` starts from the oldest kept message.
    setItems(prev => (prev.length > MAX_KEPT ? prev.slice(prev.length - MAX_KEPT) : prev));
    setNextBefore(n => n ?? oldest);
  }, [items, loadingOlder]);

  const patch = useCallback((id: string, change: (m: MessageT) => MessageT) => {
    setItems(prev => prev.map(m => (m.id === id ? change(m) : m)));
  }, []);

  const transmit = useCallback(
    async (p: PendingMessage) => {
      sending.current += 1;
      let gap = false;
      setPending(list => list.map(x => (x.clientId === p.clientId ? {...x, status: 'sending', error: undefined} : x)));
      try {
        const gapped = newerRef.current !== null;
        const res = await call<{message: MessageT}>('POST', base, {
          body: p.body,
          clientId: p.clientId,
          ...(p.parentId ? {parentId: p.parentId} : {}),
          ...(p.mentions.length ? {mentions: p.mentions} : {}),
          ...(p.cardIds?.length ? {cardIds: p.cardIds} : {}),
          ...(p.files?.length ? {attachmentIds: p.files.map(f => f.id)} : {}),
          // What this view has seen of the conversation (a thread's seqs are not the conversation's, so it sends none).
          ...(!p.parentId && knownRef.current > 0 ? {lastSeenSeq: knownRef.current} : {}),
        });
        setPending(list => list.filter(x => x.clientId !== p.clientId));
        // A list that does not reach the newest jumps back to it: the sent message lands where it belongs.
        if (gapped || newerRef.current !== null) {
          void reloadNewest();
          return res.message;
        }
        merge([res.message]);
        // Only advance when nothing from others sits in between; otherwise fetch the gap after the send.
        if (res.message.seq === knownRef.current + 1) setKnownSeq(res.message.seq);
        else gap = true;
        return res.message;
      } catch (e) {
        setPending(list => list.map(x => (x.clientId === p.clientId ? {...x, status: 'failed', error: errorMessage(e)} : x)));
        return null;
      } finally {
        sending.current -= 1;
        if (gap) void poll();
      }
    },
    [base, merge, setKnownSeq, errorMessage, poll, reloadNewest]
  );

  const send = useCallback(
    (body: string, mentions: number[], cardIds: number[] = [], files: ChatFileT[] = []) => {
      const p: PendingMessage = {clientId: newClientId(), body, mentions, cardIds, files, parentId, status: 'sending', createdAt: new Date().toISOString()};
      setPending(list => [...list, p]);
      return transmit(p);
    },
    [parentId, transmit]
  );

  const retry = useCallback(
    (clientId: string) => {
      const p = pending.find(x => x.clientId === clientId);
      if (p && p.status === 'failed') void transmit(p);
    },
    [pending, transmit]
  );
  const discard = useCallback(
    (clientId: string) => {
      // Its files were never sent: take them out (they would otherwise wait a day for the sweep).
      for (const f of pending.find(x => x.clientId === clientId)?.files ?? []) void removeUnsentFile(f.id);
      setPending(list => list.filter(x => x.clientId !== clientId));
    },
    [pending]
  );

  const hasNewer = newerCursor !== null;
  return useMemo(
    () => ({items, pending, status, error, nextBefore, loadingOlder, olderError, canWrite, canModerate, archived, known, hasNewer, loadingNewer, load, loadOlder, loadNewer, reloadNewest, send, retry, discard, patch, merge, trim, trimNewest, me}),
    [items, pending, status, error, nextBefore, loadingOlder, olderError, canWrite, canModerate, archived, known, hasNewer, loadingNewer, load, loadOlder, loadNewer, reloadNewest, send, retry, discard, patch, merge, trim, trimNewest, me]
  );
}

export type MessageFeed = ReturnType<typeof useMessageFeed>;
