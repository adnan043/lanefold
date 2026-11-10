import {infiniteQueryOptions, queryOptions} from '@tanstack/react-query';

import {api, type BoardData, type BoardSummary, call, type WorkspaceT} from './api';

/** Every read, ONCE, so a route's loader and its screen share the cache (as in the portal). */
export const workspacesQuery = queryOptions({
  queryKey: ['workspaces'],
  queryFn: () => call<{items: WorkspaceT[]}>('GET', '/workspaces').then(r => r.items),
  staleTime: 60_000,
});

/** The boards I am a GUEST on (added to a board of a workspace I am not a member of), with that workspace's name. */
export const guestBoardsQuery = queryOptions({
  queryKey: ['guest-boards'],
  queryFn: () => call<{items: (BoardSummary & {workspaceName: string})[]}>('GET', '/guest-boards').then(r => r.items),
  staleTime: 60_000,
});

export const boardsQuery = (workspaceId: number) =>
  infiniteQueryOptions({
    queryKey: ['boards', workspaceId],
    queryFn: ({pageParam}) =>
      call<{items: BoardSummary[]; nextBefore: number | null}>('GET', `/workspaces/${workspaceId}/boards?before=${pageParam}`),
    initialPageParam: '' as number | '',
    getNextPageParam: last => last.nextBefore ?? undefined,
  });

export const boardQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['board', boardId],
    queryFn: () => call<BoardData>('GET', `/boards/${boardId}`),
    // The sync hook keeps it fresh; never refetch it behind its back.
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });

/** The signed-in member's memberships (plans they bought or administer); a screen picks the workspace's own row. */
export const membershipsQuery = queryOptions({
  queryKey: ['memberships'],
  queryFn: api.memberships.list,
});
