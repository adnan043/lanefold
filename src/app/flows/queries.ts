import {queryOptions} from '@tanstack/react-query';

import {call} from '../api';
import type {FlowInput, FlowsAnswer, FlowT} from './logic';

/** The Flows thin api layer (docs/product/flows-api.md). Reads are `queryOptions`; the writes are plain calls. */
export const flowsQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['flows', boardId],
    queryFn: () => call<FlowsAnswer>('GET', `/boards/${boardId}/flows`),
    staleTime: 30_000,
  });

export const flowsApi = {
  create: (boardId: number, input: FlowInput) => call<{flow: FlowT}>('POST', `/boards/${boardId}/flows`, input).then(r => r.flow),
  update: (id: number, patch: Partial<FlowInput>) => call<{flow: FlowT}>('PATCH', `/flows/${id}`, patch).then(r => r.flow),
  remove: (id: number) => call<{ok: true}>('DELETE', `/flows/${id}`),
};
