import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback} from 'react';

import {call} from '../api';
import type {Frequency} from '../../lib/recurrence';

/** The wire shape of `GET /cards/:id/recurrence` (`src/server/routes/card-recurrence.ts`). */
export type RecurrenceT = {
  frequency: Frequency;
  interval: number;
  startOn: string;
  endsOn: string | null;
  /** The day the next copy is made; null once the rule has finished. */
  nextRunOn: string | null;
  lastRunOn: string | null;
  enabled: boolean;
};
export type RecurrenceInput = {frequency: Frequency; interval: number; startOn: string; endsOn: string | null};

const key = (cardId: number) => ['card-recurrence', cardId] as const;

export function useRecurrence(cardId: number) {
  return useQuery({
    queryKey: key(cardId),
    queryFn: () => call<{recurrence: RecurrenceT | null}>('GET', `/cards/${cardId}/recurrence`),
    staleTime: 15_000,
  });
}

/** Save or stop the rule; both resolve with the server's answer and put it in the cache. They reject with the ApiError. */
export function useRecurrenceActions(cardId: number) {
  const qc = useQueryClient();
  const save = useCallback(
    async (input: RecurrenceInput) => {
      const res = await call<{recurrence: RecurrenceT}>('PUT', `/cards/${cardId}/recurrence`, input);
      qc.setQueryData(key(cardId), {recurrence: res.recurrence});
      void qc.invalidateQueries({queryKey: ['card-activity', cardId]});
      return res.recurrence;
    },
    [cardId, qc]
  );
  const stop = useCallback(async () => {
    await call('DELETE', `/cards/${cardId}/recurrence`);
    qc.setQueryData(key(cardId), {recurrence: null});
    void qc.invalidateQueries({queryKey: ['card-activity', cardId]});
  }, [cardId, qc]);
  return {save, stop};
}
