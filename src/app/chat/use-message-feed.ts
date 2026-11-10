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
  /** Threads have no pulse of their own: poll `after` on this interval instead. */
  pollMs?: number | null;
  me: number | undefined;
};

const WINDOW_MS = 20_000;
const MAX_OLDER_REFRESH = 3;

/**
 * The transport of one message list (SPEC §8: polling; a push channel would replace only this hook).
 *   - first load: the newest 50 (`GET …/messages`), older pages by `before=<seq>`,
 *   - new messages: `?after=<known seq>` when the pulse says the conversation moved,
 *   - edits, deletes and reactions are NOT seen by `after`, so the newest window is refetched every 20 s
 *     (and when the tab comes back) and merged by id,
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
  /** `before` cursors of the older pages already loaded: the 20 s refresh re-reads the newest few of them. */
  const olderCursors = useRef<number[]>([]);
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
    setItems(prev => {
      const byId = new Map(prev.map(m => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => a.seq - b.seq);
    });
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
      // Older pages already open: edits, deletes and pins there too (at most the 3 newest, one after the other).
      for (const before of olderCursors.current.slice(-MAX_OLDER_REFRESH)) {
        const older = await call<MessagePage>('GET', url({before}));
        if (mine !== generation.current || sending.current > 0) return;
        merge(older.items);
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
    try {
      const page = await call<MessagePage>('GET', url({before: nextBefore}));
      if (mine !== generation.current) return;
      merge(page.items);
      olderCursors.current.push(nextBefore);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setOlderError(e);
    } finally {
      setLoadingOlder(false);
    }
  }, [nextBefore, loadingOlder, url, merge]);

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
    () => ({items, pending, status, error, nextBefore, loadingOlder, olderError, canWrite, canModerate, known, load, loadOlder, send, retry, discard, patch, merge, me}),
    [items, pending, status, error, nextBefore, loadingOlder, olderError, canWrite, canModerate, known, load, loadOlder, send, retry, discard, patch, merge, me]
  );
}

export type MessageFeed = ReturnType<typeof useMessageFeed>;
