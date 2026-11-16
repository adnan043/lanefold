import {queryOptions, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useState, type ComponentType} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, Drawer, ErrorNote, LoadingBlock, useToast} from '../../portal/ui';
import {type ApiError, type BoardT, call} from '../api';
import {createLoader} from '../lazy';
import type {Members, SharePanel as SharePanelT} from './share-board';

/**
 * The board header's "Join board" and "Share" buttons: on screen with the board, so they stay small. The Share
 * drawer's content (people, invites, the invite link: `share-board.tsx`) loads on hover, focus or first open.
 */

export const boardMembersQuery = (boardId: number) =>
  queryOptions({
    queryKey: ['board-members', boardId],
    queryFn: () => call<Members>('GET', `/boards/${boardId}/members`),
    staleTime: 30_000,
  });

const sharePanel = createLoader<ComponentType<Parameters<typeof SharePanelT>[0]>>(() => import('./share-board').then(m => m.SharePanel));
const preloadSharePanel = () => void sharePanel.load();

/** "Join board" in the board header: a workspace member takes a seat on a board they can already see. */
export function JoinBoardButton({board}: {board: BoardT}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const info = useQuery({...boardMembersQuery(board.id), enabled: !board.guest && !board.archived});
  const [busy, setBusy] = useState(false);
  if (!info.data?.canJoin) return null;
  const join = async () => {
    setBusy(true);
    try {
      await call('POST', `/boards/${board.id}/join`, {});
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['board-members', board.id]}),
        queryClient.invalidateQueries({queryKey: ['board-people', board.id]}),
        queryClient.invalidateQueries({queryKey: ['board', board.id]}),
      ]);
      toast.success(t('boards.share.joined'));
    } catch (e) {
      toast.danger(errorMessage(e as ApiError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" size="sm" icon="user-plus" pending={busy} pendingLabel={t('boards.share.joining')} onClick={() => void join()}>
      {t('boards.share.join')}
    </Button>
  );
}

/** The drawer's content once its code is here: a loading block meanwhile, an error with Retry if it cannot load. */
function LazySharePanel({board, onLeft}: {board: BoardT; onLeft: () => void}) {
  const t = useT();
  const [Panel, setPanel] = useState(() => sharePanel.loaded());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (Panel || failed) return;
    let live = true;
    void sharePanel.load().then(loaded => {
      if (!live) return;
      if (loaded) setPanel(() => loaded);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [Panel, failed]);
  if (Panel) return <Panel board={board} onLeft={onLeft} />;
  if (failed) {
    return (
      <>
        <ErrorNote error={new Error(t('states.loadError'))} />
        <Button variant="secondary" icon="refresh" onClick={() => setFailed(false)}>
          {t('common.retry')}
        </Button>
      </>
    );
  }
  return <LoadingBlock rows={4} />;
}

/**
 * "Share" in the board header: who is on the board and with which role. Board admins (and members, when the board
 * allows it) add workspace people, invite anyone by email (they join as a guest) or share an invite link; admins change
 * roles, remove people and set who may add people. Everyone can leave. The server checks every action again.
 */
export function ShareBoardButton({board}: {board: BoardT}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon="user-plus"
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={preloadSharePanel}
        onFocus={preloadSharePanel}
        onClick={() => setOpen(true)}>
        {t('boards.share.button')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('boards.share.title')}
        description={board.visibility === 'private' ? t('boards.share.descPrivate') : t('boards.share.descWorkspace')}>
        {open && <LazySharePanel board={board} onLeft={() => setOpen(false)} />}
      </Drawer>
    </>
  );
}
