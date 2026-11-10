import {useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData} from '@tanstack/react-query';
import {Link, useNavigate} from '../nav';
import {useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {rules} from '../../lib/rules';
import {Badge, Button, Card, Checkbox, EmptyState, ErrorNote, Field, IconButton, LoadingBlock, Modal, PageHeader, RadioCards, SearchInput, useForm, useToast} from '../../portal/ui';
import {ApiError, type BoardData, type BoardSummary, call} from '../api';
import {useDraft} from '../use-draft';
import {boardsQuery, guestBoardsQuery} from '../queries';
import {useWorkspace} from '../workspace';
import {backgroundStyle} from './background';
import {ArchivedBoardsSection, TemplatesStrip} from './board-list-parts';
import './settings.css';
import './share-board.css';

type Page = {items: BoardSummary[]; nextBefore: number | null};

function NewBoardModal({workspaceId, open, onClose}: {workspaceId: number; open: boolean; onClose: () => void}) {
  const t = useT();
  const {fieldErrors, errorMessage} = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');
  const [withLanes, setWithLanes] = useState(true);
  const form = useForm({name: ''}, {name: [rules.required(t('boards.nameRequired')), rules.maxLength(80, t('boards.nameTooLong'))]});
  const clearDraft = useDraft('newboard', 0, form.values.name, text => form.set('name', text), '', open);
  const create = useMutation({
    mutationFn: (name: string) =>
      call<{board: {id: number}}>('POST', `/workspaces/${workspaceId}/boards`, {
        name,
        visibility,
        lanes: withLanes ? [t('boards.lane.todo'), t('boards.lane.doing'), t('boards.lane.done')] : [],
      }),
    onSuccess: async ({board}) => {
      await queryClient.invalidateQueries({queryKey: ['boards', workspaceId]});
      toast.success(t('boards.created'));
      clearDraft();
      form.reset();
      onClose();
      void navigate({to: '/b/$boardId', params: {boardId: String(board.id)}});
    },
    onError: (error: ApiError) => {
      form.noteError(error);
      form.setServerErrors(fieldErrors(error));
      setStatus(errorMessage(error));
    },
  });
  const close = () => {
    if (create.isPending) return;
    clearDraft();
    form.reset();
    setStatus('');
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!create.isPending}
      title={t('boards.new')}
      footer={
        <>
          <Button variant="secondary" disabled={create.isPending} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="new-board-form" pending={create.isPending} pendingLabel={t('boards.creating')} disabled={form.blocked}>
            {t('boards.create')}
          </Button>
        </>
      }>
      <form
        id="new-board-form"
        className="lf-form"
        noValidate
        onSubmit={form.submit(values => {
          setStatus('');
          create.mutate(values.name.trim());
        })}>
        <Field id="f-name" label={t('boards.nameLabel')} error={form.error('name')}>
          <input {...form.field('name')} placeholder={t('boards.namePlaceholder')} maxLength={200} autoComplete="off" autoFocus />
        </Field>
        <RadioCards
          legend={t('boards.visibility')}
          name="visibility"
          value={visibility}
          onChange={setVisibility}
          options={[
            {value: 'workspace', title: t('boards.visibility.workspace'), description: t('boards.visibility.workspaceHint')},
            {value: 'private', title: t('boards.visibility.private'), description: t('boards.visibility.privateHint')},
          ]}
        />
        <Checkbox label={t('boards.defaultLanes')} checked={withLanes} onChange={setWithLanes} />
        {status && (
          <p className="field-error" role="alert">
            {status}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** `/app/boards`: the workspace's boards, starred first. Creating needs member or above. */
export function BoardList() {
  const t = useT();
  const {current, pending: workspacePending} = useWorkspace();
  const toast = useToast();
  const {errorMessage} = useI18n();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const workspaceId = current?.id ?? 0;
  const boards = useInfiniteQuery({...boardsQuery(workspaceId), enabled: workspaceId > 0});
  const canCreate = current !== null && current.role !== 'viewer';
  const items = boards.data?.pages.flatMap(page => page.items);
  const sorted = items ? [...items.filter(b => b.starred), ...items.filter(b => !b.starred)] : undefined;

  // Star writes run one after the other (a quick double click never lands PUT and DELETE out of order); the list
  // AND an open board's cache are patched at once and each failure puts back only its own board.
  const starChain = useRef<Promise<unknown>>(Promise.resolve());
  const patchStar = (id: number, starred: boolean) => {
    queryClient.setQueryData<InfiniteData<Page>>(['boards', workspaceId], data =>
      data && {...data, pages: data.pages.map(p => ({...p, items: p.items.map(b => (b.id === id ? {...b, starred} : b))}))}
    );
    queryClient.setQueryData<BoardData>(['board', id], data => (data ? {...data, board: {...data.board, starred}} : data));
  };
  const star = useMutation({
    mutationFn: ({id, starred}: {id: number; starred: boolean}) => {
      const run = starChain.current.then(() => call(starred ? 'PUT' : 'DELETE', `/boards/${id}/star`, starred ? {} : undefined));
      starChain.current = run.catch(() => undefined);
      return run;
    },
    onMutate: ({id, starred}) => patchStar(id, starred),
    onError: (error, {id, starred}) => {
      patchStar(id, !starred);
      toast.danger(errorMessage(error));
    },
  });

  const newBoard = canCreate ? (
    <Button icon="plus" data-shortcut="new" onClick={() => setCreating(true)}>
      {t('boards.new')}
    </Button>
  ) : undefined;

  const needle = filter.trim().toLowerCase();
  const visible = sorted?.filter(b => !needle || b.name.toLowerCase().includes(needle));
  const starredList = visible?.filter(b => b.starred) ?? [];
  const restList = visible?.filter(b => !b.starred) ?? [];
  const grid = (list: BoardSummary[]) => (
    <ul className="lf-board-grid" aria-label={t('boards.title')}>
      {list.map(board => (
        <li key={board.id} className="lf-board-tile">
          <Link to="/b/$boardId" params={{boardId: String(board.id)}} className="lf-board-link" preload="intent">
            <span className="lf-board-swatch" data-bg={board.bgKind} ref={node => backgroundStyle(node, board)} aria-hidden="true" />
            <span className="lf-board-name" dir="auto">{board.name}</span>
            {board.visibility === 'private' && <Badge icon="lock">{t('boards.visibility.private')}</Badge>}
          </Link>
          <IconButton
            icon="star"
            label={board.starred ? t('boards.starRemove') : t('boards.starAdd')}
            aria-pressed={board.starred}
            className={board.starred ? 'lf-star is-on' : 'lf-star'}
            onClick={() => star.mutate({id: board.id, starred: !board.starred})}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="app-page screen-boards">
      <PageHeader title={t('boards.title')} description={t('boards.description')} actions={newBoard} />
      {workspacePending || boards.isPending ? (
        workspacePending || workspaceId > 0 ? <LoadingBlock rows={3} /> : null
      ) : boards.error ? (
        <>
          <ErrorNote error={boards.error} title={t('states.loadError')} />
          <Button variant="secondary" icon="refresh" pending={boards.isFetching} pendingLabel={t('common.loading')} onClick={() => void boards.refetch()}>
            {t('common.retry')}
          </Button>
        </>
      ) : sorted && sorted.length === 0 ? (
        <>
          <Card>
            <EmptyState icon="layout-kanban" title={t('boards.emptyTitle')} action={newBoard}>
              {t('boards.emptyBody')}
            </EmptyState>
          </Card>
          {canCreate && workspaceId > 0 && <TemplatesStrip workspaceId={workspaceId} />}
        </>
      ) : (
        <>
          <div className="lf-list-tools">
            <SearchInput label={t('bx.list.search')} placeholder={t('bx.list.search')} value={filter} onChange={event => setFilter(event.target.value)} autoComplete="off" />
          </div>
          {visible && visible.length === 0 && <p className="lf-settings-sub" role="status">{t('bx.list.noMatch', {query: filter.trim()})}</p>}
          {starredList.length > 0 && (
            <section className="lf-list-section" aria-labelledby="lf-starred-title">
              <h2 id="lf-starred-title">{t('boards.starred')}</h2>
              {grid(starredList)}
            </section>
          )}
          {restList.length > 0 && (
            <section className="lf-list-section" aria-labelledby="lf-all-title">
              <h2 id="lf-all-title">{t('boards.all')}</h2>
              {grid(restList)}
            </section>
          )}
          {boards.hasNextPage && (
            <div className="load-more">
              <Button variant="secondary" pending={boards.isFetchingNextPage} pendingLabel={t('common.loading')} onClick={() => void boards.fetchNextPage()}>
                {t('boards.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
      {workspaceId > 0 && !boards.isPending && <ArchivedBoardsSection workspaceId={workspaceId} />}
      <GuestBoardsSection />
      {canCreate && workspaceId > 0 && <NewBoardModal workspaceId={workspaceId} open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}

/**
 * Boards of other workspaces I was added to as a GUEST (invited by email or link): I see only those boards there.
 * Hidden when there are none.
 */
function GuestBoardsSection() {
  const t = useT();
  const guest = useQuery(guestBoardsQuery);
  if (guest.isError) return <ErrorNote error={guest.error} title={t('states.loadError')} />;
  const items = guest.data ?? [];
  if (items.length === 0) return null;
  return (
    <section className="lf-list-section" aria-labelledby="lf-guest-title">
      <h2 id="lf-guest-title">{t('boards.guestTitle')}</h2>
      <p className="lf-settings-sub">{t('boards.guestHint')}</p>
      <ul className="lf-board-grid" aria-labelledby="lf-guest-title">
        {items.map(board => (
          <li key={board.id} className="lf-board-tile">
            <Link to="/b/$boardId" params={{boardId: String(board.id)}} className="lf-board-link" preload="intent">
              <span className="lf-board-swatch" data-bg={board.bgKind} ref={node => backgroundStyle(node, board)} aria-hidden="true" />
              <span className="lf-board-name" dir="auto">{board.name}</span>
              <span className="lf-board-ws" dir="auto">{board.workspaceName}</span>
              <Badge tone="warning">{t('boards.share.guest')}</Badge>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
