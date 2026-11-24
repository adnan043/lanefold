import {queryOptions, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Avatar, Badge, Button, buttonClass, ErrorNote, Icon, LoadingBlock, Menu, useToast} from '../../portal/ui';
import {Popover} from '../../portal/ui/popover';
import {useMe} from '../../portal/shared';
import {siteFetch} from '../../platform/browser';
import {type ApiError, type BoardT, call} from '../api';
import {Link} from '../nav';
import {boardMembersQuery} from './share-board-header';
import './access-request.css';

/**
 * Asking to join a board you cannot open, and answering those requests (server: routes/board-access-requests.ts).
 *
 * The requester's screen never names the board: the server answers the same for a board that does not exist.
 * The admins' "Access requests" button shows only for those who may add people, when requests wait.
 */

type MyRequest = {status: 'none' | 'pending' | 'member'};
type RequestRow = {id: number; userId: number; name: string; guest: boolean; requestedAt: string};

const myRequestQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['board-access-request', boardId],
    queryFn: () => call<MyRequest>('GET', `/boards/${boardId}/access-request`),
    staleTime: 0,
  });

export const accessRequestsQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['board-access-requests', boardId],
    queryFn: () => call<{items: RequestRow[]; canAnswer: boolean}>('GET', `/boards/${boardId}/access-requests`),
    staleTime: 15_000,
  });

/** Signs out, then opens sign-in coming back HERE: the other account is the one asking for this board. */
async function switchAccount() {
  await siteFetch('/site-api/auth/logout', {method: 'POST'}).catch(() => null);
  window.location.replace(`/account/login/?next=${encodeURIComponent(window.location.pathname)}`);
}

/** In place of the board when it cannot be opened: who is signed in, and "Send request". */
export function RequestAccess({boardId, onGranted}: {boardId: number; onGranted: () => void}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const me = useMe().data?.viewer;
  const queryClient = useQueryClient();
  // While a request waits, look again now and then: the board opens here once someone approves it.
  const mine = useQuery({...myRequestQuery(boardId), refetchInterval: q => (q.state.data?.status === 'pending' ? 60_000 : false)});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const status = mine.data?.status;
  // Let in meanwhile (approved, or added another way): load the board.
  useEffect(() => {
    if (status === 'member') onGranted();
  }, [status, onGranted]);
  const send = async () => {
    setSending(true);
    setError('');
    try {
      const out = await call<MyRequest>('POST', `/boards/${boardId}/access-request`, {});
      queryClient.setQueryData(myRequestQuery(boardId).queryKey, out);
      if (out.status === 'member') onGranted();
    } catch (e) {
      setError(errorMessage(e as ApiError));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="app-page lf-access">
      <section className="lf-access-card" aria-labelledby="lf-access-title">
        <span className="lf-access-icon" aria-hidden="true">
          <Icon name="lock" size={28} />
        </span>
        <h2 id="lf-access-title">{t('access.title')}</h2>
        <p className="lf-access-body">{status === 'pending' ? t('access.sentBody') : t('access.body')}</p>
        {me && (
          <div className="lf-access-who">
            <div className="lf-access-who-head">
              <span className="muted">{t('access.signedInAs')}</span>
              <button type="button" className="lf-access-switch" onClick={() => void switchAccount()}>
                {t('access.switchAccount')}
              </button>
            </div>
            <div className="lf-access-person">
              <Avatar name={me.name ?? ''} size="md" />
              <span className="lf-access-person-text">
                <span className="lf-access-name">{me.name}</span>
                {me.email && <span className="muted">{me.email}</span>}
              </span>
            </div>
          </div>
        )}
        {mine.isPending ? (
          <LoadingBlock rows={1} />
        ) : status === 'pending' ? (
          <p className="lf-access-sent" role="status">
            <Icon name="check" size={16} /> {t('access.sent')}
          </p>
        ) : (
          <>
            <p className="lf-access-note">{t('access.shareNote')}</p>
            <Button className="lf-access-send" pending={sending} pendingLabel={t('access.sending')} onClick={() => void send()}>
              {t('access.send')}
            </Button>
          </>
        )}
        {(error || mine.isError) && (
          <p className="field-error" role="alert">
            {error || t('states.loadError')}
          </p>
        )}
        <Link to="/boards" className={buttonClass({variant: 'ghost', size: 'sm'})}>
          {t('boards.backToBoards')}
        </Link>
      </section>
    </div>
  );
}

/** The board header's "Access requests (n)": only for those who may add people, only while requests wait. */
export function AccessRequestsButton({board}: {board: BoardT}) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const info = useQuery({...boardMembersQuery(board.id), enabled: !board.guest && !board.archived});
  const count = info.data?.canInvite ? (info.data.accessRequests ?? 0) : 0;
  if (count === 0 && !open) return null;
  return (
    <>
      <Button ref={anchor} variant="secondary" size="sm" icon="user-plus" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {t('access.requests')}
        {count > 0 && <Badge tone="brand">{count > 99 ? '99+' : count}</Badge>}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('access.requests')} align="end" className="lf-access-pop">
        {open && <RequestsList boardId={board.id} onEmpty={() => setOpen(false)} />}
      </Popover>
    </>
  );
}

function RequestsList({boardId, onEmpty}: {boardId: number; onEmpty: () => void}) {
  const t = useT();
  const {errorMessage, formatRelative} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const list = useQuery(accessRequestsQuery(boardId));
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<{id: number; message: string} | null>(null);
  const answer = async (row: RequestRow, action: 'approve' | 'decline', role?: 'member' | 'viewer') => {
    setBusyId(row.id);
    setRowError(null);
    try {
      await call('POST', `/access-requests/${row.id}/${action}`, action === 'approve' ? {role} : {});
      toast.success(action === 'approve' ? t('access.approvedToast', {name: row.name}) : t('access.declinedToast', {name: row.name}));
      const left = (list.data?.items.length ?? 1) - 1;
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['board-access-requests', boardId]}),
        queryClient.invalidateQueries({queryKey: ['board-members', boardId]}),
        queryClient.invalidateQueries({queryKey: ['board-people', boardId]}),
      ]);
      if (left <= 0) onEmpty();
    } catch (e) {
      const err = e as ApiError;
      // Answered by someone else meanwhile: the list is simply out of date.
      if (err.status === 404) await queryClient.invalidateQueries({queryKey: ['board-access-requests', boardId]});
      setRowError({id: row.id, message: errorMessage(err)});
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="lf-access-list">
      <h2 className="lf-access-list-title">{t('access.requests')}</h2>
      {list.isPending ? (
        <LoadingBlock rows={1} />
      ) : list.isError ? (
        <ErrorNote error={list.error} title={t('states.loadError')} />
      ) : list.data.items.length === 0 ? (
        <p className="muted">{t('access.none')}</p>
      ) : (
        <ul>
          {list.data.items.map(row => (
            <li key={row.id} className="lf-access-row">
              <div className="lf-access-person">
                <Avatar name={row.name} size="sm" />
                <span className="lf-access-person-text">
                  <span className="lf-access-name">{row.name}</span>
                  <span className="muted">
                    {row.guest ? t('access.asGuest') : t('access.inWorkspace')} · {formatRelative(row.requestedAt)}
                  </span>
                </span>
              </div>
              <div className="lf-access-actions">
                <Button size="sm" pending={busyId === row.id} pendingLabel={t('access.answering')} disabled={busyId !== null && busyId !== row.id} onClick={() => void answer(row, 'approve', 'member')}>
                  {t('access.approve')}
                </Button>
                <Menu
                  label={t('access.moreFor', {name: row.name})}
                  disabled={busyId !== null}
                  items={[
                    {label: t('access.approveViewer'), icon: 'eye', onSelect: () => void answer(row, 'approve', 'viewer')},
                    {label: t('access.decline'), icon: 'x', onSelect: () => void answer(row, 'decline')},
                  ]}
                />
              </div>
              {rowError?.id === row.id && (
                <p className="field-error" role="alert">
                  {rowError.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

