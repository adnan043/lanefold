import {useQuery} from '@tanstack/react-query';

import {useI18n, useT} from '../../i18n';
import {Button, ErrorNote, IconButton, LoadingBlock} from '../../portal/ui';
import {boardConversationQuery} from './api';
import {ConversationView} from './conversation-view';
import './chat.css';

/** A board's Chat tab: the board's own conversation (created on first open), over the right edge of the board. */
export function BoardChat({boardId, workspaceId, role, onClose}: {boardId: number; workspaceId: number; role: string; onClose: () => void}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const query = useQuery(boardConversationQuery(boardId));
  return (
    <aside className="lf-board-chat" aria-label={t('chat.boardChat')}>
      <div className="lf-board-chat-head">
        <h2>{t('chat.boardChat')}</h2>
        <IconButton icon="x" size="sm" label={t('chat.closeBoardChat')} onClick={onClose} />
      </div>
      {query.isPending ? (
        <div className="lf-board-chat-state">
          <LoadingBlock rows={4} />
        </div>
      ) : query.error || !query.data ? (
        <div className="lf-board-chat-state">
          <ErrorNote error={new Error(errorMessage(query.error))} title={t('states.loadError')} />
          <Button variant="secondary" icon="refresh" pending={query.isFetching} pendingLabel={t('common.loading')} onClick={() => void query.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <ConversationView conversation={{...query.data, name: query.data.name}} workspaceId={workspaceId} role={role} embedded />
      )}
    </aside>
  );
}
