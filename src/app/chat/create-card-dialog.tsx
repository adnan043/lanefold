import {useInfiniteQuery, useMutation, useQuery} from '@tanstack/react-query';
import {useNavigate} from '../nav';
import {useEffect, useMemo, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {CARD_TITLE_MAX, titleFromMessage} from '../../lib/card-from-message';
import {Button, Field, LoadingBlock, Modal, Notice, Select, useToast} from '../../portal/ui';
import {call} from '../api';
import {useWriteCooldown} from '../write-cooldown';
import {boardQuery, boardsQuery} from '../queries';
import {applyTemplate, type CardTemplate, expandTitle} from '../templates/templates';
import {TemplatePicker} from '../templates/template-picker';
import type {MessageT} from './api';

type Created = {card: {id: number; boardId: number; laneId: number; title: string}; messageId: string};

/**
 * "Create card" from a chat message: pick a board and a lane the visitor can write to (board chats start on
 * their own board), optionally edit the title. The server checks everything again.
 */
export function CreateCardDialog({
  open,
  onClose,
  message,
  workspaceId,
  defaultBoardId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  message: Pick<MessageT, 'id' | 'body'>;
  workspaceId: number;
  defaultBoardId: number | null;
  onCreated: (cardId: number) => void;
}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const boards = useInfiniteQuery({...boardsQuery(workspaceId), enabled: open});
  const list = useMemo(() => boards.data?.pages.flatMap(p => p.items) ?? [], [boards.data]);
  const [boardId, setBoardId] = useState<number | null>(defaultBoardId);
  const [laneId, setLaneId] = useState(0);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [titleError, setTitleError] = useState('');
  const [templateId, setTemplateId] = useState(0);

  useEffect(() => {
    if (!open) return;
    setTitle(titleFromMessage(message.body, ''));
    setError('');
    setTitleError('');
    setLaneId(0);
    setTemplateId(0);
    setBoardId(defaultBoardId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, message.id]);
  useEffect(() => {
    if (open && boardId === null && list[0]) setBoardId(list[0].id);
  }, [open, boardId, list]);

  const board = useQuery({...boardQuery(boardId ?? 0), enabled: open && boardId !== null, staleTime: 0});
  const lanes = useMemo(() => (board.data?.lanes ?? []).filter(l => !l.archived), [board.data]);
  // The select and the submitted board are the same state: a board that is not in the first page (more than
  // one page, or archived) is added to the options, never silently swapped for the first one.
  const boardOptions = useMemo(() => {
    const options = list.map(b => ({value: String(b.id), label: b.name}));
    if (boardId !== null && !list.some(b => b.id === boardId)) options.unshift({value: String(boardId), label: board.data?.board.id === boardId ? board.data.board.name : '…'});
    return options;
  }, [list, boardId, board.data]);
  const canWrite = board.data?.board.canWrite === true && !board.data.board.archived;
  useEffect(() => {
    if (lanes.length && !lanes.some(l => l.id === laneId)) setLaneId(lanes[0]!.id);
  }, [lanes, laneId]);

  const cooldown = useWriteCooldown();
  const create = useMutation({
    mutationFn: async () => {
      const made = await call<Created>('POST', `/messages/${message.id}/card`, {laneId, title: title.trim() || undefined});
      // The card exists now; a template that cannot be applied is a warning, never a failed create.
      let templateFailed = false;
      if (templateId) await applyTemplate(made.card.id, templateId).catch(() => (templateFailed = true));
      return {...made, templateFailed};
    },
    onSuccess: ({card, templateFailed}) => {
      onCreated(card.id);
      onClose();
      if (templateFailed) toast.danger(t('ctpl.applyFailed'));
      toast.success(t('chat.cardCreated'), {action: {label: t('chat.openCardAction'), onSelect: () => void navigate({to: `/b/${card.boardId}/c/${card.id}` as never})}});
    },
    onError: err => setError(errorMessage(err)),
  });

  const submit = () => {
    if (create.isPending) return;
    if (title.trim().length > CARD_TITLE_MAX) {
      setError('');
      setTitleError(t('chat.cardTitleTooLong', {n: CARD_TITLE_MAX}));
      document.getElementById('cc-title')?.focus();
      return;
    }
    setTitleError('');
    if (!canWrite || !laneId) return setError(t('chat.cardPickLane'));
    setError('');
    create.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!create.isPending}
      title={t('chat.createCardTitle')}
      description={t('chat.createCardBody')}
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="chat-card-form" disabled={!canWrite || !laneId || cooldown.blocked} pending={create.isPending} pendingLabel={t('chat.creatingCard')}>
            {t('chat.createCard')}
          </Button>
        </>
      }>
      <form
        id="chat-card-form"
        className="lf-move-form"
        noValidate
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}>
        {boards.isPending ? (
          <LoadingBlock rows={2} />
        ) : list.length === 0 ? (
          <Notice tone="info">{t('chat.cardNoBoards')}</Notice>
        ) : (
          <>
            <Field id="cc-board" label={t('chat.cardBoard')}>
              <Select
                id="cc-board"
                value={String(boardId ?? '')}
                disabled={create.isPending}
                onChange={event => {
                  setBoardId(Number(event.target.value));
                  setLaneId(0);
                }}
                options={boardOptions}
              />
            </Field>
            {board.isPending ? (
              <LoadingBlock rows={1} />
            ) : board.isError ? (
              <Notice tone="danger">{errorMessage(board.error)}</Notice>
            ) : !canWrite ? (
              <Notice tone="warning">{t('chat.cardBoardReadOnly')}</Notice>
            ) : (
              <Field id="cc-lane" label={t('card.moveLane')}>
                <Select id="cc-lane" value={String(laneId)} disabled={create.isPending} onChange={event => setLaneId(Number(event.target.value))} options={lanes.map(l => ({value: String(l.id), label: l.name}))} />
              </Field>
            )}
            <TemplatePicker
              workspaceId={workspaceId}
              enabled={open}
              value={templateId}
              disabled={create.isPending}
              onPick={(template: CardTemplate | null) => {
                setTemplateId(template?.id ?? 0);
                if (template?.payload.title) setTitle(expandTitle(template.payload.title));
              }}
            />
            <Field id="cc-title" label={t('chat.cardTitle')} error={titleError}>
              <input
                id="cc-title"
                value={title}
                disabled={create.isPending}
                maxLength={CARD_TITLE_MAX + 50}
                autoComplete="off"
                placeholder={t('card.addPlaceholder')}
                aria-invalid={titleError ? true : undefined}
                aria-describedby={titleError ? 'cc-title-error' : undefined}
                onChange={event => {
                  setTitle(event.target.value);
                  if (titleError) setTitleError('');
                }}
              />
            </Field>
          </>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
