import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {useEffect, useMemo, useState} from 'react';

import {useT} from '../../i18n';
import {Field, Select} from '../../portal/ui';
import {isTemp} from '../boards/actions';
import {boardQuery, boardsQuery} from '../queries';

/**
 * "Another board" part of Move / Copy: the workspace's boards (the current one first, as "This board"), and the open lanes
 * of the board picked, read through the same cached `boardQuery` the board screen uses. The server decides what is allowed;
 * this only offers it and says up front when the picked board is view-only.
 */
export function useBoardTarget(workspaceId: number, currentBoardId: number, active: boolean) {
  const [boardId, setBoardId] = useState(currentBoardId);
  const [laneId, setLaneId] = useState(0);
  useEffect(() => {
    if (active) setBoardId(currentBoardId);
  }, [active, currentBoardId]);
  const list = useInfiniteQuery({...boardsQuery(workspaceId), enabled: active});
  const boards = useMemo(() => (list.data?.pages.flatMap(p => p.items) ?? []).filter(b => b.id !== currentBoardId), [list.data, currentBoardId]);
  const other = boardId !== currentBoardId;
  const target = useQuery({...boardQuery(boardId), enabled: active && other});
  const lanes = useMemo(() => (target.data?.lanes ?? []).filter(l => !l.archived && !isTemp(l.id)), [target.data]);
  // The first open lane is picked as soon as the other board's lanes are known.
  useEffect(() => {
    if (other && lanes.length > 0 && !lanes.some(l => l.id === laneId)) setLaneId(lanes[0]!.id);
  }, [other, lanes, laneId]);
  const name = other ? (boards.find(b => b.id === boardId)?.name ?? target.data?.board.name ?? '') : '';
  return {
    boardId, setBoardId, laneId, setLaneId, other, boards, lanes, name,
    hasMore: list.hasNextPage === true,
    loadingLanes: other && target.isPending,
    lanesFailed: other && target.isError,
    viewOnly: other && target.data !== undefined && !target.data.board.canWrite,
    archived: other && target.data?.board.archived === true,
    /** The picked board can take the card: its lanes are known, it is writable, open, and a lane is chosen. */
    ready: other && target.data !== undefined && target.data.board.canWrite && !target.data.board.archived && lanes.some(l => l.id === laneId),
  };
}
export type BoardTarget = ReturnType<typeof useBoardTarget>;

/** The board select (only when the workspace has another board). The current board is "This board". */
export function BoardPicker({idPrefix, currentBoardId, target}: {idPrefix: string; currentBoardId: number; target: BoardTarget}) {
  const t = useT();
  if (target.boards.length === 0) return null;
  return (
    <Field id={`${idPrefix}-board`} label={t('card.moveBoard')} hint={target.hasMore ? t('card.moveBoardsMore') : undefined}>
      <Select
        id={`${idPrefix}-board`}
        value={String(target.boardId)}
        onChange={event => target.setBoardId(Number(event.target.value))}
        options={[{value: String(currentBoardId), label: t('card.thisBoard')}, ...target.boards.map(b => ({value: String(b.id), label: b.name}))]}
      />
    </Field>
  );
}

/** The lane of the OTHER board, with what the person must know before moving there. Nothing when "This board" is picked. */
export function OtherBoardLane({idPrefix, target}: {idPrefix: string; target: BoardTarget}) {
  const t = useT();
  if (!target.other) return null;
  return (
    <>
      <Field id={`${idPrefix}-olane`} label={t('card.moveLane')} hint={target.loadingLanes ? t('card.moveLanesLoading') : target.lanesFailed ? undefined : t('card.moveEndHint')} error={target.lanesFailed ? t('card.moveLanesFailed') : target.viewOnly || target.archived ? t('card.moveBoardViewOnly') : undefined}>
        <Select
          id={`${idPrefix}-olane`}
          value={String(target.laneId)}
          disabled={target.loadingLanes || target.lanes.length === 0}
          onChange={event => target.setLaneId(Number(event.target.value))}
          options={target.lanes.map(l => ({value: String(l.id), label: l.name}))}
        />
      </Field>
      <p className="lf-move-note">{t('card.moveOtherNote')}</p>
    </>
  );
}
