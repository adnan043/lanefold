import {useInfiniteQuery} from '@tanstack/react-query';
import {useEffect, useMemo} from 'react';

import {useT} from '../../i18n';
import type {LaneT} from '../api';
import {membersListQuery} from '../members/queries';
import type {Names} from './summary';

export type Option = {value: string; label: string};
export type FlowContext = {
  lanes: Option[];
  labels: Option[];
  people: Option[];
  peopleLoading: boolean;
  names: Names;
};

/**
 * The pick lists for the editor and the names for the list: open lanes of this board, labels seen on its cards
 * (the board answer carries labels on the card faces; there is no list-labels route), workspace members (all pages).
 */
export function useFlowContext(workspaceId: number, lanes: LaneT[], enabled: boolean): FlowContext {
  const t = useT();
  const members = useInfiniteQuery({...membersListQuery(workspaceId), enabled});
  const {hasNextPage, isFetchingNextPage, fetchNextPage} = members;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [enabled, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return useMemo(() => {
    const laneList = lanes.filter(l => !l.archived).map(l => ({value: String(l.id), label: l.name}));
    const labelMap = new Map<number, string>();
    for (const lane of lanes) for (const card of lane.cards) for (const label of card.labels ?? []) labelMap.set(label.id, label.name);
    const labelList = [...labelMap].map(([id, name]) => ({value: String(id), label: name})).sort((a, b) => a.label.localeCompare(b.label));
    const people = (members.data?.pages.flatMap(p => p.items) ?? []).map(m => ({value: String(m.userId), label: m.name || t('flows.unnamed')}));
    const find = (list: Option[], id: number) => list.find(o => o.value === String(id))?.label ?? t('flows.missing');
    return {
      lanes: laneList,
      labels: labelList,
      people,
      peopleLoading: members.isPending || members.isFetchingNextPage,
      names: {lane: id => find(laneList, id), label: id => find(labelList, id), user: id => find(people, id)},
    };
  }, [lanes, members.data, members.isPending, members.isFetchingNextPage, t]);
}
