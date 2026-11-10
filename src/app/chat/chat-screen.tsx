import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useSearch} from '@tanstack/react-router';
import {Link, useNavigate} from '../nav';
import {useEffect, useMemo, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, EmptyState, ErrorNote, Icon, LoadingBlock, Notice, PageHeader, buttonClass} from '../../portal/ui';
import {call} from '../api';
import {useWorkspace} from '../workspace';
import {conversationQuery, conversationsQuery, type ConversationT, usePulse} from './api';
import {RegionBoundary} from '../region-boundary';
import {ConversationView, conversationTitle} from './conversation-view';
import {NewConversationModal} from './new-conversation';
import './chat.css';

function ConversationLink({c, selected, unread}: {c: ConversationT; selected: boolean; unread: number}) {
  const t = useT();
  const title = conversationTitle(c, t);
  return (
    <li>
      <Link to="/chat" search={{c: c.id} as never} className="chat-conv" aria-current={selected ? 'page' : undefined} data-unread={unread > 0 && !c.muted ? '' : undefined}>
        <Icon name={c.kind === 'channel' ? 'hash' : c.kind === 'board' ? 'layout-kanban' : c.kind === 'group' ? 'users' : 'user'} size={16} />
        <span className="chat-conv-name"><bdi>{title}</bdi></span>
        {c.muted && <Icon name="bell" size={14} />}
        {unread > 0 && (
          <span className="chat-unread" aria-label={t('chat.unreadCount', {n: unread})}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Link>
    </li>
  );
}

/** `/app/chat`: channels, direct messages, groups and board chats of the current workspace. `?c=<id>` is the open one. */
export function Chat() {
  const t = useT();
  const {errorMessage} = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {current, setCurrentId, pending: workspacePending} = useWorkspace();
  const {c: selectedId} = useSearch({strict: false}) as {c?: number};
  const workspaceId = current?.id ?? 0;
  const list = useQuery({...conversationsQuery(workspaceId), enabled: workspaceId > 0});
  const pulse = usePulse(true);
  const [creating, setCreating] = useState(false);
  const isAdmin = current?.role === 'owner' || current?.role === 'admin';

  const items = list.data;
  const unreadOf = useMemo(() => new Map((pulse.data ?? []).map(p => [p.conversationId, p.unread])), [pulse.data]);
  const unread = (c: ConversationT) => (c.id === selectedId ? 0 : (unreadOf.get(c.id) ?? c.unread));

  // A conversation the pulse knows and the list does not (a new DM or group): reload the list.
  useEffect(() => {
    if (!items || !pulse.data) return;
    const known = new Set(items.map(c => c.id));
    if (pulse.data.some(p => p.workspaceId === workspaceId && !known.has(p.conversationId))) void queryClient.invalidateQueries({queryKey: ['chat', 'conversations', workspaceId]});
  }, [pulse.data, items, workspaceId, queryClient]);

  // No channels yet: the first admin to open Chat creates #general (once per workspace per page load).
  const tried = useRef(new Set<number>());
  const general = useMutation({
    mutationFn: () => call<{conversation: ConversationT}>('POST', `/workspaces/${workspaceId}/conversations`, {kind: 'channel', name: 'general'}),
    onSuccess: async ({conversation}) => {
      await queryClient.invalidateQueries({queryKey: ['chat', 'conversations', workspaceId]});
      void navigate({to: '/chat', search: {c: conversation.id} as never, replace: true});
    },
  });
  const noChannels = !!items && !items.some(c => c.kind === 'channel');
  useEffect(() => {
    if (noChannels && isAdmin && workspaceId > 0 && !tried.current.has(workspaceId)) {
      tried.current.add(workspaceId);
      general.mutate();
    }
  }, [noChannels, isAdmin, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A conversation the list does not hold (a notification pointing at a board chat): read it by id.
  const inList = !!selectedId && !!items?.some(c => c.id === selectedId);
  const byId = useQuery({...conversationQuery(selectedId ?? 0), enabled: !!selectedId && !!items && !inList});
  const fetched = byId.data && byId.data.workspaceId === workspaceId ? byId.data : null;
  const selected = items?.find(c => c.id === selectedId) ?? fetched;
  // A notification from another workspace: switch to it, then the conversation resolves in its own list.
  const otherWorkspaceId = byId.data && byId.data.workspaceId !== workspaceId ? byId.data.workspaceId : null;
  useEffect(() => {
    if (otherWorkspaceId) setCurrentId(otherWorkspaceId);
  }, [otherWorkspaceId, setCurrentId]);
  // Two-pane widths (tablets and up, chat.css) open the first channel by default; phones start at the list.
  useEffect(() => {
    if (selected || !items || items.length === 0 || selectedId) return;
    if (window.matchMedia('(min-width: 721px)').matches) {
      const first = items.find(c => c.kind === 'channel') ?? items[0]!;
      void navigate({to: '/chat', search: {c: first.id} as never, replace: true});
    }
  }, [selected, items, selectedId, navigate]);

  if (workspacePending || (workspaceId > 0 && list.isPending)) {
    return (
      <div className="app-page">
        <LoadingBlock rows={5} />
      </div>
    );
  }
  if (!current) return null;
  if (list.error || !items) {
    return (
      <div className="app-page">
        <PageHeader title={t('chat.title')} />
        <ErrorNote error={new Error(errorMessage(list.error))} title={t('states.loadError')} />
        <Button variant="secondary" icon="refresh" pending={list.isFetching} pendingLabel={t('common.loading')} onClick={() => void list.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  const channels = items.filter(c => c.kind === 'channel');
  const direct = items.filter(c => c.kind === 'dm' || c.kind === 'group');
  const boards = items.filter(c => c.kind === 'board');
  const section = (label: string, rows: ConversationT[]) =>
    rows.length > 0 && (
      <div className="chat-section">
        <h3 className="chat-section-label">{label}</h3>
        <ul>
          {rows.map(c => (
            <ConversationLink key={c.id} c={c} selected={c.id === selected?.id} unread={unread(c)} />
          ))}
        </ul>
      </div>
    );

  return (
    <div className="chat-layout" data-open={selected ? '' : undefined}>
      <nav className="chat-list" aria-label={t('chat.conversations')}>
        <div className="chat-list-head">
          <h2>{t('chat.title')}</h2>
          <Button size="sm" variant="secondary" icon="plus" onClick={() => setCreating(true)}>
            {t('chat.new')}
          </Button>
        </div>
        {general.isPending && <p className="muted chat-list-note"><span className="spinner" aria-hidden="true" /> {t('chat.creatingGeneral')}</p>}
        {general.error && (
          <Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => general.mutate()}>{t('common.retry')}</Button>}>
            {errorMessage(general.error)}
          </Notice>
        )}
        {noChannels && !isAdmin && <p className="muted chat-list-note">{t('chat.noChannelsMember')}</p>}
        {section(t('chat.channels'), channels)}
        {section(t('chat.direct'), direct)}
        {section(t('chat.boardChats'), boards)}
        {items.length === 0 && !general.isPending && (
          <EmptyState icon="message" title={t('chat.emptyTitle2')} action={<Link to="/boards" className={buttonClass({variant: 'secondary'})}>{t('boards.backToBoards')}</Link>}>
            {t('chat.emptyBody2')}
          </EmptyState>
        )}
      </nav>
      <div className="chat-pane">
        {selected ? (
          <RegionBoundary region="chat" key={selected.id}>
          <ConversationView
            key={selected.id}
            conversation={selected}
            workspaceId={workspaceId}
            role={current.role}
            onBack={() => void navigate({to: '/chat', search: {} as never})}
          />
          </RegionBoundary>
        ) : (
          <EmptyState icon="message" title={t('chat.pickTitle')} action={items.some(c => c.kind === 'channel') ? undefined : <Link to="/boards" className={buttonClass({variant: 'secondary'})}>{t('boards.backToBoards')}</Link>}>
            {t('chat.pickBody')}
          </EmptyState>
        )}
      </div>
      <NewConversationModal
        workspaceId={workspaceId}
        role={current.role}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={c => void navigate({to: '/chat', search: {c: c.id} as never})}
      />
    </div>
  );
}

