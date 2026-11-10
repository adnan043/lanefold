import {useEffect, useState} from 'react';

import {useI18n} from '../../i18n';
import {Button, Field, Modal, Select, useToast} from '../../portal/ui';
import {BoardPicker, OtherBoardLane, useBoardTarget} from '../cards/board-target';
import type {CardT, LaneT} from '../api';
import {findCard} from '../board-state';
import {type BoardActions, isTemp, type Undoable} from './actions';
import {moveIndex, moveSlots} from './move-target';

/**
 * "Move to…": the single-pointer, no-drag way to move a card (WCAG 2.5.7). Pick a lane and a position,
 * then the same optimistic `moveCard` the drag uses runs (with its undo).
 */
export function MoveCardDialog({
  card,
  boardId,
  workspaceId,
  lanes,
  actions,
  onUndoable,
  onClose,
}: {
  card: CardT | null;
  boardId: number;
  workspaceId: number;
  lanes: LaneT[];
  actions: BoardActions;
  onUndoable: (label: string, undo: Undoable) => void;
  onClose: () => void;
}) {
  const {t, errorMessage} = useI18n();
  const toast = useToast();
  const target = useBoardTarget(workspaceId, boardId, card !== null);
  const [busy, setBusy] = useState<'move' | 'copy' | null>(null);
  const [failure, setFailure] = useState('');
  const [laneId, setLaneId] = useState(0);
  const [position, setPosition] = useState(1);
  useEffect(() => {
    if (!card) return;
    const at = findCard(lanes, card.id);
    setLaneId(at?.laneId ?? card.laneId);
    setPosition((at?.index ?? 0) + 1);
    setFailure('');
    setBusy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id]);
  // Only lanes the server can take a card into: not archived, not still being saved (negative id).
  const targets = lanes.filter(l => !l.archived && !isTemp(l.id));
  const targetLane = lanes.find(l => l.id === laneId);
  const slots = card ? moveSlots(lanes, card.id, laneId) : 1;
  const safePosition = Math.min(position, slots);
  /** Another board: ask the server, then close; a refusal stays in the dialog, in words, and the buttons work again. */
  const sendElsewhere = async (kind: 'move' | 'copy') => {
    if (!card || !target.ready || busy) return;
    setBusy(kind);
    setFailure('');
    try {
      if (kind === 'move') await actions.moveCardToBoard(card.id, target.boardId, target.laneId);
      else await actions.copyCardToBoard(card.id, target.boardId, target.laneId);
      toast.success(t(kind === 'move' ? 'card.movedToBoardToast' : 'card.copiedToBoardToast', {board: target.name}));
      onClose();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };
  const submit = () => {
    if (!card) return;
    if (target.other) {
      void sendElsewhere('move');
      return;
    }
    const undo = actions.moveCard(card.id, laneId, moveIndex(lanes, card.id, laneId, safePosition));
    if (undo) onUndoable(t('polish.cardMoved'), undo);
    onClose();
  };
  return (
    <Modal
      open={card !== null}
      onClose={onClose}
      title={t('card.moveTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
            {t('common.cancel')}
          </Button>
          {target.other && (
            <Button variant="secondary" disabled={!target.ready || busy !== null} pending={busy === 'copy'} pendingLabel={t('card.copying')} onClick={() => void sendElsewhere('copy')}>
              {t('card.copyToBoard')}
            </Button>
          )}
          <Button type="submit" form="move-card-form" disabled={target.other && (!target.ready || busy !== null)} pending={busy === 'move'} pendingLabel={t('card.moving')}>
            {t('card.moveConfirm')}
          </Button>
        </>
      }>
      <form
        id="move-card-form"
        className="lf-move-form"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}>
        <BoardPicker idPrefix="mv" currentBoardId={boardId} target={target} />
        {target.other ? (
          <OtherBoardLane idPrefix="mv" target={target} />
        ) : (
          <>
            <Field id="mv-lane" label={t('card.moveLane')}>
              <Select id="mv-lane" value={String(laneId)} onChange={event => setLaneId(Number(event.target.value))} options={targets.map(l => ({value: String(l.id), label: l.name}))} />
            </Field>
            <Field id="mv-pos" label={t('card.movePosition')} hint={targetLane && (targetLane.hasMore || !targetLane.loaded) ? t('card.positionLoadedOnly') : undefined}>
              <Select
                id="mv-pos"
                value={String(safePosition)}
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
      </form>
    </Modal>
  );
}
