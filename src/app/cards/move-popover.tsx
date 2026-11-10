import {useQuery} from '@tanstack/react-query';
import {useRef, useState} from 'react';

import {useI18n} from '../../i18n';
import {Button, Field, Icon, Select, useToast} from '../../portal/ui';
import {useNavigate} from '../nav';
import {BoardPicker, OtherBoardLane, useBoardTarget} from './board-target';
import {Popover} from '../../portal/ui/popover';
import {type BoardActions, isTemp} from '../boards/actions';
import {moveIndex, moveSlots} from '../boards/move-target';
import {boardQuery} from '../queries';
import {findCard} from '../board-state';

/**
 * The lane chip at the top of the card; clicking it opens "Move card": the board, the lane and the position,
 * then the same optimistic `moveCard` the board's drag uses.
 */
export function MovePopover({boardId, cardId, canWrite, actions}: {boardId: number; cardId: number; canWrite: boolean; actions: BoardActions}) {
  const {t, errorMessage} = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const board = useQuery(boardQuery(boardId)).data;
  const [open, setOpen] = useState(false);
  const target = useBoardTarget(board?.board.workspaceId ?? 0, boardId, open && board !== undefined);
  const [busy, setBusy] = useState<'move' | 'copy' | null>(null);
  const [failure, setFailure] = useState('');
  const [laneId, setLaneId] = useState(0);
  const [position, setPosition] = useState(1);
  const anchor = useRef<HTMLButtonElement>(null);
  const lanes = board?.lanes ?? [];
  const at = findCard(lanes, cardId);
  const current = lanes.find(l => l.id === at?.laneId);
  if (!board || !current) return null;
  const targets = lanes.filter(l => !l.archived && !isTemp(l.id));
  const slots = moveSlots(lanes, cardId, laneId);
  const safe = Math.min(position, slots);
  const toggle = () => {
    if (!open) {
      setFailure('');
      setLaneId(current.id);
      setPosition((at?.index ?? 0) + 1);
    }
    setOpen(o => !o);
  };
  /** Another board: the card keeps its id, so the panel follows it to the new board. A refusal stays here, in words. */
  const sendElsewhere = async (kind: 'move' | 'copy') => {
    if (!target.ready || busy) return;
    setBusy(kind);
    setFailure('');
    try {
      if (kind === 'move') {
        await actions.moveCardToBoard(cardId, target.boardId, target.laneId);
        toast.success(t('card.movedToBoardToast', {board: target.name}));
        setOpen(false);
        void navigate({to: '/b/$boardId/c/$cardId', params: {boardId: String(target.boardId), cardId: String(cardId)}});
      } else {
        await actions.copyCardToBoard(cardId, target.boardId, target.laneId);
        toast.success(t('card.copiedToBoardToast', {board: target.name}));
        setOpen(false);
      }
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  const submit = () => {
    if (target.other) {
      void sendElsewhere('move');
      return;
    }
    const undo = actions.moveCard(cardId, laneId, moveIndex(lanes, cardId, laneId, safe));
    if (undo) toast.success(t('polish.cardMoved'), {action: {label: t('card.undo'), onSelect: undo.run}});
    setOpen(false);
  };
  return (
    <>
      <button ref={anchor} type="button" className="cd-lane-chip" disabled={!canWrite} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
        <span>{current.name}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('card.moveTitle')} className="cd-pop cd-move">
        <h4 className="cd-move-title">{t('card.moveTitle')}</h4>
        <form
          className="cd-move-form"
          noValidate
          onSubmit={event => {
            event.preventDefault();
            submit();
          }}>
          <BoardPicker idPrefix="cdm" currentBoardId={boardId} target={target} />
          {target.other ? (
            <OtherBoardLane idPrefix="cdm" target={target} />
          ) : (
            <>
              <Field id="cdm-lane" label={t('card.moveLane')}>
                <Select id="cdm-lane" value={String(laneId)} onChange={event => setLaneId(Number(event.target.value))} options={targets.map(l => ({value: String(l.id), label: l.name}))} />
              </Field>
              <Field id="cdm-pos" label={t('card.movePosition')}>
                <Select
                  id="cdm-pos"
                  value={String(safe)}
                  onChange={event => setPosition(Number(event.target.value))}
                  options={Array.from({length: slots}, (_, i) => ({value: String(i + 1), label: t('card.positionOf', {position: i + 1, total: slots})}))}
                />
              </Field>
            </>
          )}
          {failure && (
            <p className="form-status" data-tone="error" role="alert">
              {failure}
            </p>
          )}
          <Button type="submit" block disabled={target.other && (!target.ready || busy !== null)} pending={busy === 'move'} pendingLabel={t('card.moving')}>
            {t('card.moveConfirm')}
          </Button>
          {target.other && (
            <Button type="button" variant="secondary" block disabled={!target.ready || busy !== null} pending={busy === 'copy'} pendingLabel={t('card.copying')} onClick={() => void sendElsewhere('copy')}>
              {t('card.copyToBoard')}
            </Button>
          )}
        </form>
      </Popover>
    </>
  );
}
