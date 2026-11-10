import {useMutation, useQueryClient} from '@tanstack/react-query';
import {useParams} from '@tanstack/react-router';
import {Link, useNavigate} from '../nav';
import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, buttonClass, Card, EmptyState, Notice, useToast} from '../../portal/ui';
import {ApiError, call} from '../api';
import {useWorkspace} from '../workspace';
import {useWriteCooldown} from '../write-cooldown';
import './members.css';

const TOKEN_RE = /^(lj|iv|bl)_[A-Za-z0-9_-]{43}$/;

/**
 * `/app/join/<token>`: accept a join link or an invite (a workspace's, or a board's: those open the board, as a guest
 * when the person is not a member of its workspace). Nothing happens on opening the page (a link is not a
 * sign-in and never joins by itself): the person presses Join. A signed-out visitor is sent to sign in by the
 * shell and comes back here.
 */
export function JoinWorkspace() {
  const t = useT();
  const {errorMessage} = useI18n();
  const {token: raw} = useParams({strict: false}) as {token: string};
  const token = (raw ?? '').trim();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const {setCurrentId} = useWorkspace();
  const [failure, setFailure] = useState<ApiError | null>(null);
  // A board's invite link, or a board invite email (`?b=1`, a wording hint only): the page speaks of a board.
  const forBoard = token.startsWith('bl_') || new URLSearchParams(window.location.search).get('b') === '1';
  const [already, setAlready] = useState(false);

  const cooldown = useWriteCooldown();
  const accept = useMutation({
    mutationFn: () =>
      call<{workspaceId: number; role: string | null; alreadyMember: boolean; boardId?: number; guest?: boolean}>('POST', '/invites/accept', {token}),
    onSuccess: async res => {
      // A board invite or link: straight to that board (a guest keeps their own workspace as the current one).
      if (res.boardId) {
        if (!res.guest) setCurrentId(res.workspaceId);
        await Promise.all([queryClient.invalidateQueries({queryKey: ['guest-boards']}), queryClient.invalidateQueries({queryKey: ['boards']})]);
        if (!res.alreadyMember) toast.success(t('join.joinedBoard'));
        void navigate({to: '/b/$boardId', params: {boardId: String(res.boardId)}});
        return;
      }
      setCurrentId(res.workspaceId);
      await queryClient.invalidateQueries({queryKey: ['workspaces']});
      if (res.alreadyMember) {
        setAlready(true);
        return;
      }
      toast.success(t('join.joined'));
      void navigate({to: '/boards'});
    },
    onError: error => setFailure(error instanceof ApiError ? error : new ApiError(errorMessage(error), 0)),
  });

  if (!TOKEN_RE.test(token) || (failure && failure.status === 404)) {
    return (
      <div className="app-page">
        <div className="join-card">
          <EmptyState icon="link" title={t('join.invalidTitle')} action={<Link to="/boards" className={buttonClass({variant: 'secondary'})}>{t('boards.backToBoards')}</Link>}>
            {t('join.invalidBody')}
          </EmptyState>
        </div>
      </div>
    );
  }
  if (already) {
    return (
      <div className="app-page">
        <div className="join-card">
          <EmptyState icon="check-circle" title={t('join.alreadyTitle')} action={<Link to="/boards" className={buttonClass({})}>{t('boards.backToBoards')}</Link>}>
            {t('join.alreadyBody')}
          </EmptyState>
        </div>
      </div>
    );
  }
  return (
    <div className="app-page">
      <div className="join-card">
        <Card title={forBoard ? t('join.boardTitle') : t('join.title')} description={forBoard ? t('join.boardDescription') : t('join.description')}>
          <div className="lf-form">
            {failure && <Notice tone="danger">{errorMessage(failure)}</Notice>}
            <Button
              icon="user-plus"
              pending={accept.isPending}
              pendingLabel={t('join.joining')}
              disabled={cooldown.blocked}
              onClick={() => {
                setFailure(null);
                accept.mutate();
              }}>
              {failure ? t('common.retry') : forBoard ? t('join.boardAccept') : t('join.accept')}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
