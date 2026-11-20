import {useInfiniteQuery, useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Link} from '../nav';
import {useEffect, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Button, EmptyState, ErrorNote, Field, Icon, IconButton, LoadingBlock, Modal, PageHeader, Select, useForm, useToast} from '../../portal/ui';
import {call} from '../api';
import {useDraft} from '../use-draft';
import {boardQuery, boardsQuery, workspacesQuery} from '../queries';
import {useWorkspace} from '../workspace';
import {useWriteCooldown} from '../write-cooldown';
import {type InboxCard, inboxQuery} from './queries';
import '../phase3.css';

/** Pick a board and a lane of it for one Inbox card. Boards and lanes come from the same reads the board screens use. */
function MoveModal({card, workspaceId, onClose}: {card: InboxCard | null; workspaceId: number; onClose: () => void}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const open = card !== null;
  const boards = useInfiniteQuery({...boardsQuery(workspaceId), enabled: open});
  // Every board of the workspace is offered: keep loading pages (30 each) while the dialog is open.
  useEffect(() => {
    if (open && boards.hasNextPage && !boards.isFetchingNextPage) void boards.fetchNextPage();
  }, [open, boards]);
  const list = boards.data?.pages.flatMap(page => page.items) ?? [];
  const [boardId, setBoardId] = useState<number | null>(null);
  const [laneId, setLaneId] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const chosenBoard = boardId ?? list[0]?.id ?? null;
  const board = useQuery({...boardQuery(chosenBoard ?? 0), enabled: open && chosenBoard !== null});
  const lanes = board.data?.lanes.filter(lane => !lane.archived) ?? [];
  const chosenLane = lanes.find(lane => lane.id === laneId)?.id ?? lanes[0]?.id ?? null;
  const canWrite = board.data?.board.canWrite ?? true;

  const cooldown = useWriteCooldown();
  const move = useMutation({
    mutationFn: () => call('POST', `/inbox/cards/${card!.id}/triage`, {laneId: chosenLane}),
    onSuccess: async () => {
      toast.success(t('inbox.moved', {board: list.find(b => b.id === chosenBoard)?.name ?? ''}));
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['inbox']}),
        queryClient.invalidateQueries({queryKey: ['my-day']}),
        queryClient.invalidateQueries({queryKey: ['board', chosenBoard]}),
      ]);
      onClose();
    },
    onError: error => setStatus(errorMessage(error)),
  });
  const close = () => {
    if (move.isPending) return;
    setStatus('');
    setBoardId(null);
    setLaneId(null);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!move.isPending}
      title={t('inbox.moveTitle')}
      description={card?.title}
      footer={
        <>
          <Button variant="secondary" disabled={move.isPending} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            icon="arrow-right"
            pending={move.isPending}
            pendingLabel={t('inbox.moving')}
            disabled={chosenLane === null || !canWrite || cooldown.blocked}
            onClick={() => {
              setStatus('');
              move.mutate();
            }}>
            {t('inbox.move')}
          </Button>
        </>
      }>
      {boards.isPending ? (
        <LoadingBlock rows={2} />
      ) : list.length === 0 ? (
        <p className="muted">{t('inbox.noBoards')}</p>
      ) : (
        <div className="lf-form">
          <Field id="inbox-board" label={t('inbox.board')}>
            <Select
              id="inbox-board"
              value={String(chosenBoard ?? '')}
              options={list.map(b => ({value: String(b.id), label: b.name}))}
              onChange={event => {
                setBoardId(Number(event.target.value));
                setLaneId(null);
              }}
            />
          </Field>
          <Field id="inbox-lane" label={t('inbox.lane')} hint={board.isSuccess && lanes.length === 0 ? t('inbox.noLanes') : !canWrite ? t('inbox.readOnlyBoard') : undefined}>
            <Select id="inbox-lane" value={String(chosenLane ?? '')} disabled={lanes.length === 0} options={lanes.map(l => ({value: String(l.id), label: l.name}))} onChange={event => setLaneId(Number(event.target.value))} />
          </Field>
          {status && (
            <p className="field-error" role="alert">
              {status}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Cards captured today first, then everything older, newest first as the server sends them. */
function groupByDay(items: InboxCard[]): {key: 'today' | 'earlier'; items: InboxCard[]}[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today: InboxCard[] = [];
  const earlier: InboxCard[] = [];
  for (const card of items) (new Date(card.createdAt) >= startOfToday ? today : earlier).push(card);
  return [
    {key: 'today' as const, items: today},
    {key: 'earlier' as const, items: earlier},
  ].filter(group => group.items.length > 0);
}

/** The Inbox: quick capture into my personal Inbox board of the current workspace, then triage into a board. */
export function Inbox() {
  const t = useT();
  const {errorMessage, formatRelative} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const {current, pending: workspacePending, error: workspaceError} = useWorkspace();
  const workspaceId = current?.id ?? 0;
  const canWrite = current !== null && current.role !== 'viewer' && current.role !== 'guest';
  const query = useInfiniteQuery({...inboxQuery(workspaceId), enabled: workspaceId > 0});
  const [status, setStatus] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [moving, setMoving] = useState<InboxCard | null>(null);
  const form = useForm({title: ''}, {title: [rules.required(t('inbox.titleRequired')), rules.maxLength(200, t('inbox.titleTooLong'))]});
  const clearDraft = useDraft('capture', 0, form.values.title, text => form.set('title', text), '', canWrite);

  // Inbox cards live on the Inbox board only: that board is the one a cached board view may hold stale (none
  // before the first capture creates it, so nothing to refresh then).
  const refresh = () => {
    const boardId = query.data?.pages[0]?.boardId ?? null;
    return Promise.all([
      queryClient.invalidateQueries({queryKey: ['inbox']}),
      queryClient.invalidateQueries({queryKey: ['my-day']}),
      boardId !== null ? queryClient.invalidateQueries({queryKey: ['board', boardId]}) : undefined,
    ]);
  };
  const capture = useMutation({
    mutationFn: (title: string) => call('POST', `/workspaces/${workspaceId}/inbox/cards`, {title}),
    onSuccess: async () => {
      clearDraft();
      form.reset();
      setStatus('');
      await refresh();
      toast.success(t('inbox.added'));
    },
    onError: error => {
      form.noteError(error);
      setStatus(errorMessage(error));
    },
  });
  // Done toggles: a done card stays in the list, ticked (as on My Day); ticking it again reopens it. Archive removes it.
  const act = useMutation({
    mutationFn: ({card, kind}: {card: InboxCard; kind: 'done' | 'archive'}) =>
      kind === 'done' ? call('PATCH', `/cards/${card.id}`, {completed: !card.completed}) : call('POST', `/cards/${card.id}/archive`, {}),
    onMutate: ({card}) => setBusyId(card.id),
    onSuccess: async (_data, {card, kind}) => {
      await refresh();
      if (kind === 'done') {
        if (!card.completed) toast.success(t('myDay.done'));
        return;
      }
      // An archived card leaves the Inbox list (it stays on the Inbox board): offer the way back right here.
      const undo = () =>
        void call('POST', `/cards/${card.id}/restore`, {})
          .then(refresh)
          .catch((error: unknown) => toast.danger(errorMessage(error)));
      toast.success(t('inbox.archived'), {action: {label: t('card.undo'), onSelect: undo}});
    },
    onError: error => toast.danger(errorMessage(error)),
    onSettled: () => setBusyId(null),
  });

  const items = query.data?.pages.flatMap(page => page.items) ?? [];
  const inboxBoardId = query.data?.pages[0]?.boardId ?? null;
  const count = `${items.filter(item => !item.completed).length}${query.hasNextPage ? '+' : ''}`;
  const listReady = !(workspacePending || (workspaceId > 0 && query.isPending)) && !workspaceError && !query.isError;
  return (
    <div className="app-page">
      <div className="lf-inbox">
        <PageHeader
          title={t('inbox.title')}
          description={t('inbox.subtitle', {workspace: current?.name ?? ''})}
          actions={
            listReady && items.length > 0 ? (
              <span className="lf-inbox-pill">
                <strong>{count}</strong> {t('inbox.toSort').toLowerCase()}
              </span>
            ) : undefined
          }
        />
        {canWrite && (
          <form className="lf-inbox-capture" noValidate onSubmit={form.submit(values => capture.mutate(values.title.trim()))}>
            <label className="visually-hidden" htmlFor="f-title">
              {t('inbox.captureLabel')}
            </label>
            <div className="lf-inbox-bar" data-invalid={form.error('title') ? '' : undefined}>
              <Icon name="plus" size={18} />
              <input {...form.field('title')} autoComplete="off" maxLength={400} placeholder={t('inbox.capturePlaceholder')} disabled={capture.isPending} />
              <Button type="submit" size="sm" pending={capture.isPending} pendingLabel={t('inbox.adding')} disabled={form.blocked}>
                {t('inbox.add')}
              </Button>
            </div>
            {form.error('title') && (
              <p className="field-error" id="f-title-error" role="alert">
                {form.error('title')}
              </p>
            )}
            {status && (
              <p className="field-error" role="alert">
                {status}
              </p>
            )}
          </form>
        )}
        {workspacePending || (workspaceId > 0 && query.isPending) ? (
          <LoadingBlock rows={3} />
        ) : workspaceError ? (
          <div className="lf-inbox-pad">
            <ErrorNote error={new Error(errorMessage(workspaceError))} />
            <Button variant="secondary" icon="refresh" onClick={() => void queryClient.invalidateQueries({queryKey: workspacesQuery.queryKey})}>
              {t('common.retry')}
            </Button>
          </div>
        ) : query.isError ? (
          <div className="lf-inbox-pad">
            <ErrorNote error={new Error(errorMessage(query.error))} />
            <Button variant="secondary" icon="refresh" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon="inbox" title={t('inbox.emptyTitle')}>
            <span className="lf-inbox-empty-body">{t('inbox.emptyCapture')}</span>
            <span className="lf-inbox-tip">
              <span>{t('inbox.tipShortcut')}</span>
              <span className="lf-inbox-keys" aria-hidden="true">
                <kbd className="lf-kbd" dir="ltr">G</kbd>
                <kbd className="lf-kbd" dir="ltr">I</kbd>
              </span>
              <span className="visually-hidden">G, I</span>
            </span>
          </EmptyState>
        ) : (
          <section className="lf-inbox-list" aria-label={t('inbox.listLabel')}>
            {groupByDay(items).map(group => (
              <div key={group.key} className="lf-inbox-group">
                <h2 className="lf-inbox-group-title" id={`inbox-group-${group.key}`}>
                  {group.key === 'today' ? t('myDay.today') : t('inbox.earlier')}
                </h2>
                <ul className="lf-inbox-rows" aria-labelledby={`inbox-group-${group.key}`}>
                  {group.items.map(card => {
                    const body = (
                      <>
                        <span className="lf-inbox-title">{card.title}</span>
                        <time className="lf-inbox-time" dateTime={card.createdAt}>
                          {formatRelative(card.createdAt)}
                        </time>
                      </>
                    );
                    return (
                      <li key={card.id} className="lf-inbox-row" data-busy={busyId === card.id ? '' : undefined} data-done={card.completed ? '' : undefined}>
                        {canWrite && (
                          <IconButton
                            className="lf-inbox-tick"
                            icon="check"
                            size="sm"
                            label={card.completed ? t('card.markNotDone', {title: card.title}) : t('inbox.markDone', {title: card.title})}
                            pending={busyId === card.id && act.variables?.kind === 'done'}
                            disabled={busyId !== null && busyId !== card.id}
                            onClick={() => act.mutate({card, kind: 'done'})}
                          />
                        )}
                        {inboxBoardId ? (
                          <Link to="/b/$boardId/c/$cardId" params={{boardId: String(inboxBoardId), cardId: String(card.id)}} className="lf-inbox-main">
                            {body}
                          </Link>
                        ) : (
                          <span className="lf-inbox-main">{body}</span>
                        )}
                        {canWrite && (
                          <div className="lf-inbox-actions">
                            <Button variant="secondary" size="sm" icon="arrow-right" disabled={busyId !== null} onClick={() => setMoving(card)}>
                              {t('inbox.move')}
                            </Button>
                            <IconButton icon="archive" size="sm" label={t('inbox.archive', {title: card.title})} pending={busyId === card.id && act.variables?.kind === 'archive'} disabled={busyId !== null && busyId !== card.id} onClick={() => act.mutate({card, kind: 'archive'})} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {query.hasNextPage && (
              <div className="lf-inbox-more">
                <Button variant="secondary" size="sm" pending={query.isFetchingNextPage} pendingLabel={t('common.loading')} onClick={() => void query.fetchNextPage()}>
                  {t('inbox.loadMore')}
                </Button>
              </div>
            )}
          </section>
        )}
      </div>
      <MoveModal card={moving} workspaceId={workspaceId} onClose={() => setMoving(null)} />
    </div>
  );
}
