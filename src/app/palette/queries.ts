import {queryOptions} from '@tanstack/react-query';

import {call} from '../api';

/** Wire shapes of `GET /workspaces/:id/search` (`src/server/routes/search.ts`). People carry NO email. */
export type SearchCard = {id: number; number?: number | null; title: string; boardId: number; boardName: string; laneName: string; dueDate: string | null; completed: boolean; priority: string};
export type SearchBoard = {id: number; name: string; visibility: string};
export type SearchPerson = {id: number; name: string; role: string};
export type SearchResults = {cards: SearchCard[]; boards: SearchBoard[]; people: SearchPerson[]; nextBefore: number | null};

export const searchQuery = (workspaceId: number, q: string) =>
  queryOptions({
    queryKey: ['search', workspaceId, q],
    queryFn: () => call<SearchResults>('GET', `/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}`),
    staleTime: 30_000,
    retry: false,
  });
