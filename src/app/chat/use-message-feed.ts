import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {useI18n} from '../../i18n';
import {call} from '../api';
import {type MessagePage, type MessageT, newClientId, useVisibleInterval} from './api';

export type PendingMessage = {
  clientId: string;
  body: string;
  mentions: number[];
  cardIds?: number[];
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
  /** A fallback poll of `after` on this interval, for a list with no pulse (off by default: threads follow the pulse too). */
  pollMs?: number | null;
  me: number | undefined;
};

const WINDOW_MS = 20_000;
/** Every this many window refreshes, ONE older page already open is re-read too (round robin): ~100 s per page. */
const OLDER_EVERY = 5;
/** The most messages a list keeps once the reader is back at the newest: older ones are dropped (Load older brings them back). */
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
 *   - back at the newest, a list longer than `MAX_KEPT` drops its oldest messages (`trim`; Load older reloads them),
 *   - a sent message shows at once as pending; a failed one keeps its `clientId`, so Retry never duplicates it.
 */
export function useMessageFeed({conversationId, parentId = null, pulseSeq, pollMs = null, me}: Options) {
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
  /** `before` cursors of the older pages already loaded: the refresh re-reads one of them now and then, in turn. */
  const olderCursors = useRef<number[]>([]);
  const ticks = useRef(0);
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
      setCanWrite(page.canWrite);
      setCanModerate(page.canModerate ?? false);
      knownRef.current = page.lastSeq;
      setKnown(page.lastSeq);
      setStatus('ready');
    } catch (e) {
      if (mine !== generation.current) return;
      setError(e);
      setStatus('error');
    }
  }, [url]);

  useEffect(() => {
    setItems([]);
    setPending([]);
    setNextBefore(null);
    olderCursors.current = [];
    knownRef.current = 0;
    setKnown(0);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  /** New messages since what we know; loops while the server says there are more. Quiet on errors (the next tick retries). */
  const poll = useCallback(async () => {
    if (busy.current || sending.current > 0 || status !== 'ready') return;
    busy.current = true;
    const mine = generation.current;
    try {
      for (let round = 0; round < 10; round += 1) {
        const page = await call<MessagePage>('GET', url({after: knownRef.current}));
        if (mine !== generation.current) return;
        merge(page.items);
        setCanWrite(page.canWrite);
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
  const refreshWindow = useCallback(async () => {
    if (busy.current || refreshing.current || sending.current > 0 || status !== 'ready') return;
    refreshing.current = true;
    const mine = generation.current;
    try {
      const page = await call<MessagePage>('GET', url({}));
      if (mine !== generation.current || sending.current > 0) return;
      merge(page.items);
      setCanWrite(page.canWrite);
      if (page.canModerate !== undefined) setCanModerate(page.canModerate);
      // Older pages already open: edits, deletes and pins there too, one page now and then, newest first, in turn.
      ticks.current += 1;
      const cursors = olderCursors.current;
      if (cursors.length > 0 && ticks.current % OLDER_EVERY === 0) {
        const round = ticks.current / OLDER_EVERY - 1;
        const before = cursors[cursors.length - 1 - (round % cursors.length)]!;
        const older = await call<MessagePage>('GET', url({before}));
        if (mine !== generation.current || sending.current > 0) return;
        // Only what the list still holds: a page reaches below its cursor, so after a trim it would otherwise bring
        // the dropped messages back (and the list would grow past MAX_KEPT, trim, and bounce).
        if (older.items.length > 0) {
          setItems(prev => {
            const floor = prev[0]?.seq;
            const kept = floor === undefined ? older.items : older.items.filter(m => m.seq >= floor);
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
  useVisibleInterval(() => void poll(), pollMs);
  useVisibleInterval(() => void refreshWindow(), status === 'ready' ? WINDOW_MS : null);
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
        const res = await call<{message: MessageT}>('POST', base, {
          body: p.body,
          clientId: p.clientId,
          ...(p.parentId ? {parentId: p.parentId} : {}),
          ...(p.mentions.length ? {mentions: p.mentions} : {}),
          ...(p.cardIds?.length ? {cardIds: p.cardIds} : {}),
          // What this view has seen of the conversation (a thread's seqs are not the conversation's, so it sends none).
          ...(!p.parentId && knownRef.current > 0 ? {lastSeenSeq: knownRef.current} : {}),
        });
        merge([res.message]);
        // Only advance when nothing from others sits in between; otherwise fetch the gap after the send.
        if (res.message.seq === knownRef.current + 1) setKnownSeq(res.message.seq);
        else gap = true;
        setPending(list => list.filter(x => x.clientId !== p.clientId));
        return res.message;
      } catch (e) {
        setPending(list => list.map(x => (x.clientId === p.clientId ? {...x, status: 'failed', error: errorMessage(e)} : x)));
        return null;
      } finally {
        sending.current -= 1;
        if (gap) void poll();
      }
    },
    [base, merge, setKnownSeq, errorMessage, poll]
  );

  const send = useCallback(
    (body: string, mentions: number[], cardIds: number[] = []) => {
      const p: PendingMessage = {clientId: newClientId(), body, mentions, cardIds, parentId, status: 'sending', createdAt: new Date().toISOString()};
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
  const discard = useCallback((clientId: string) => setPending(list => list.filter(x => x.clientId !== clientId)), []);

  return useMemo(
    () => ({items, pending, status, error, nextBefore, loadingOlder, olderError, canWrite, canModerate, known, load, loadOlder, send, retry, discard, patch, merge, trim, me}),
    [items, pending, status, error, nextBefore, loadingOlder, olderError, canWrite, canModerate, known, load, loadOlder, send, retry, discard, patch, merge, trim, me]
  );
}

export type MessageFeed = ReturnType<typeof useMessageFeed>;
