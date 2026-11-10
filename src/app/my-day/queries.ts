import {queryOptions} from '@tanstack/react-query';

import {call} from '../api';

export type DayGroup = 'overdue' | 'today' | 'next7' | 'later' | 'none';
export type DayCard = {
  id: number;
  number?: number | null;
  title: string;
  priority: string;
  dueDate: string | null;
  group: DayGroup;
  workspaceId: number;
  workspaceName: string;
  boardId: number;
  boardName: string;
  laneName: string;
};
export type MyDayData = {today: string; truncated: boolean; items: DayCard[]};

/** `today` is the visitor's own calendar day (the server only groups by it). */
export const myDayQuery = (today: string) =>
  queryOptions({
    queryKey: ['my-day', today],
    queryFn: () => call<MyDayData>('GET', `/my-day?today=${today}`),
    staleTime: 30_000,
  });
