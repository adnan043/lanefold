import {infiniteQueryOptions} from '@tanstack/react-query';

import {call} from '../api';

export type InboxCard = {id: number; title: string; priority: string; dueDate: string | null; createdAt: string};
export type InboxPage = {boardId: number | null; items: InboxCard[]; nextBefore: number | null};

/** My quick-capture cards in one workspace, newest first, keyset paged (`before` = the last card id). */
export const inboxQuery = (workspaceId: number) =>
  infiniteQueryOptions({
    queryKey: ['inbox', workspaceId],
    queryFn: ({pageParam}) => call<InboxPage>('GET', `/workspaces/${workspaceId}/inbox?before=${pageParam}`),
    initialPageParam: '' as number | '',
    getNextPageParam: last => last.nextBefore ?? undefined,
    staleTime: 15_000,
  });
