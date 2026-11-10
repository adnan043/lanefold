import {queryOptions, useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useRef, useState} from 'react';

import {cardRefsKey} from '../../lib/card-refs';
import {ApiError, call} from '../api';

/** Wire shapes of `src/server/routes/chat.ts`. Message ids are strings (bigint); everything else is a number. */
export type ConversationKind = 'channel' | 'group' | 'dm' | 'board';
export type ConversationT = {
  id: number;
  kind: ConversationKind;
  name: string | null;
  boardId: number | null;
  peer: {id: number; name: string} | null;
  lastSeq: number;
  unread: number;
  joined: boolean;
  muted: boolean;
};
export type PulseItem = {conversationId: number; workspaceId: number; lastSeq: number; lastReadSeq: number; unread: number; muted: boolean};
export type NumberRefT = {id: number; boardId: number; title: string};
export type ReactionT = {emoji: string; count: number; mine: boolean};
export type MessageT = {
  id: string;
  conversationId: number;
  seq: number;
  sender: {id: number | null; name: string | null};
  kind: string;
  body: string;
  parentId: string | null;
  replyCount: number;
  edited: boolean;
  deleted: boolean;
  pinned: boolean;
  mentions: number[];
  cardIds: number[];
  /** `#42` in a board chat that resolved to a card the viewer may open (absent = plain text). */
  numberRefs?: Record<number, NumberRefT>;
  reactions: ReactionT[];
  createdAt: string;
};
export type MessagePage = {items: MessageT[]; nextBefore: number | null; more: boolean; lastSeq: number; lastReadSeq: number; canWrite: boolean; canModerate?: boolean};
export type MemberT = {userId: number; name: string | null; email?: string; maskedEmail?: string; role: string; joinedAt: string; isMe: boolean; canManage: boolean};

export const conversationsQuery = (workspaceId: number) =>
  queryOptions({
    queryKey: ['chat', 'conversations', workspaceId],
    queryFn: () => call<{items: ConversationT[]}>('GET', `/workspaces/${workspaceId}/conversations`).then(r => r.items),
    staleTime: 15_000,
  });

export const boardConversationQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['chat', 'board', boardId],
    queryFn: () => call<{conversation: ConversationT & {canWrite: boolean}}>('GET', `/boards/${boardId}/conversation`).then(r => r.conversation),
    staleTime: 5 * 60_000,
  });

/** One page of the member directory (mentions, new DM, group). Names only; at most a few pages are read. */
export const chatPeopleQuery = (workspaceId: number) =>
  queryOptions({
    queryKey: ['chat', 'people', workspaceId],
    queryFn: async () => {
      const people: MemberT[] = [];
      let after: number | null = null;
      for (let page = 0; page < 4; page += 1) {
        const res: {items: MemberT[]; nextAfter: number | null} = await call('GET', `/workspaces/${workspaceId}/members${after ? `?after=${after}` : ''}`);
        people.push(...res.items);
        after = res.nextAfter;
        if (!after) break;
      }
      return people;
    },
    staleTime: 5 * 60_000,
  });

export type PersonHit = {userId: number; name: string; role: string; isMe: boolean};

/** `GET /workspaces/:id/members/search`: up to 20 names (never emails), for the mention and new-chat pickers. */
export const memberSearchQuery = (workspaceId: number, q: string) =>
  queryOptions({
    queryKey: ['chat', 'member-search', workspaceId, q],
    queryFn: () => call<{items: PersonHit[]}>('GET', `/workspaces/${workspaceId}/members/search?q=${encodeURIComponent(q)}`).then(r => r.items),
    staleTime: 60_000,
  });

/** The search text after a short pause, so typing does not send a request per key. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setOut(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return out;
}

/** One conversation by id (a notification can point at a board chat the list does not hold). */
export const conversationQuery = (id: number) =>
  queryOptions({
    queryKey: ['chat', 'conversation', id],
    queryFn: () => call<{conversation: ConversationT & {workspaceId: number; canWrite: boolean; canModerate: boolean}}>('GET', `/conversations/${id}`).then(r => r.conversation),
    staleTime: 30_000,
    retry: false,
  });

export const pulseKey = ['chat', 'pulse'] as const;

/** Seconds since the person last touched the page: the pulse slows down while they are away. */
let lastInput = Date.now();
if (typeof window !== 'undefined') {
  for (const name of ['pointerdown', 'keydown', 'pointermove', 'wheel', 'touchstart'] as const) {
    window.addEventListener(name, () => (lastInput = Date.now()), {passive: true});
  }
}

/**
 * The pulse (SPEC §8): ONE small read says which of my conversations moved. `fast` while a chat is open and
 * the person is active (about 3 s), 12 s when they are idle, 30 s otherwise. The tab being hidden pauses it
 * (TanStack's default), focus refetches, and errors back off to 30 s.
 */
export function usePulse(fast: boolean) {
  return useQuery({
    queryKey: pulseKey,
    queryFn: () => call<{items: PulseItem[]}>('GET', '/chat/pulse').then(r => r.items),
    refetchInterval: query => {
      if (query.state.status === 'error' && query.state.fetchFailureCount > 0) return 30_000;
      const jitter = Math.random() * 500;
      if (!fast) return 30_000 + jitter;
      return (Date.now() - lastInput > 60_000 ? 12_000 : 3000) + jitter;
    },
    refetchOnWindowFocus: true,
    staleTime: 1000,
  });
}

export const totalUnread = (items: PulseItem[] | undefined, workspaceId?: number) =>
  (items ?? []).reduce((sum, p) => (p.muted || (workspaceId !== undefined && p.workspaceId !== workspaceId) ? sum : sum + p.unread), 0);

/** `crypto.randomUUID()` without dashes: 32 characters, matches the server's client key rule. */
export const newClientId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.padEnd(8, '0'));

export const displayName = (name: string | null | undefined, deleted: string) => (name && name.trim() ? name : deleted);

/** Marks a conversation read up to `seq` (and zeroes it in the cached pulse at once). */
export function useMarkRead() {
  const queryClient = useQueryClient();
  const sent = useRef(new Map<number, number>());
  return useCallback((conversationId: number, seq: number) => {
    if (seq <= 0 || (sent.current.get(conversationId) ?? 0) >= seq) return;
    sent.current.set(conversationId, seq);
    queryClient.setQueryData<PulseItem[]>(pulseKey, items => items?.map(p => (p.conversationId === conversationId ? {...p, lastReadSeq: seq, unread: Math.max(0, p.lastSeq - seq)} : p)));
    queryClient.setQueriesData<ConversationT[]>({queryKey: ['chat', 'conversations']}, list =>
      list?.map(c => (c.id === conversationId ? {...c, unread: Math.max(0, c.lastSeq - seq)} : c))
    );
    void call('POST', `/conversations/${conversationId}/read`, {seq}).catch(error => {
      // A read-only workspace refuses read markers: keep the entry so scrolling does not retry, and leave the pulse alone.
      if (error instanceof ApiError && error.status === 409 && error.code === 'workspace_read_only') return;
      sent.current.delete(conversationId);
      if (!(error instanceof ApiError && error.status === 404)) void queryClient.invalidateQueries({queryKey: pulseKey});
    });
  }, [queryClient]);
}

/** Runs `fn` every `ms` while the tab is visible (and once when it comes back). */
export function useVisibleInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const timer = window.setInterval(() => !document.hidden && ref.current(), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
}

export type CardHitT = {id: number; title: string; boardId: number; boardName: string; laneName: string};

/** `GET /workspaces/:id/search`: cards the viewer may see (2+ letters). Only the cards part is used here. */
export const cardSearchQuery = (workspaceId: number, q: string) =>
  queryOptions({
    queryKey: ['chat', 'card-search', workspaceId, q],
    queryFn: () => call<{cards: CardHitT[]}>('GET', `/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`).then(r => r.cards),
    staleTime: 30_000,
  });

/** A card a message points at, as the light batch answers it (only cards the viewer may open). */
export type CardRefT = {id: number; number: number | null; title: string; boardId: number; boardName: string; done: boolean};
export const cardRefsQuery = (ids: readonly number[]) =>
  queryOptions({
    queryKey: cardRefsKey(ids),
    queryFn: async (): Promise<Record<number, CardRefT>> => {
      const sorted = [...new Set(ids)].sort((a, b) => a - b);
      const out: Record<number, CardRefT> = {};
      // The server takes 20 at a time; a message rarely links more than a couple.
      for (let i = 0; i < sorted.length; i += 20) {
        const r = await call<{items: CardRefT[]}>('GET', `/cards/refs?ids=${sorted.slice(i, i + 20).join(',')}`);
        for (const item of r.items) out[item.id] = item;
      }
      return out;
    },
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
