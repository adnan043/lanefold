import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, EmptyState, ErrorNote, Icon, IconButton, LoadingBlock, Notice, useToast} from '../../portal/ui';
import {useMe} from '../../portal/shared';
import {call} from '../api';
import {chatPeopleQuery, type ConversationT, type MemberT, type MessageT, useMarkRead, usePulse} from './api';
import {incomingSince, newestSeq} from './announce';
import {Composer} from './composer';
import {dayKey} from './mentions';
import {MessageItem, PendingItem} from './message-item';
import {type MessageFeed, useMessageFeed} from './use-message-feed';
import './chat.css';

const GROUP_MS = 5 * 60_000;

export const conversationTitle = (c: Pick<ConversationT, 'kind' | 'name' | 'peer'>, t: (key: any) => string) =>
  c.kind === 'dm' ? c.peer?.name || t('chat.deletedUser') : c.name || (c.kind === 'board' ? t('chat.boardChat') : t('chat.untitled'));

type ListProps = {
  feed: MessageFeed;
  people: ReadonlyMap<number, MemberT>;
  peopleList: readonly MemberT[];
  me: number | undefined;
  canModerate: boolean;
  canPin?: boolean;
  onReply?: (message: MessageT) => void;
  /** Called when the person is looking at the newest messages (mark read). */
  onSeen?: (seq: number) => void;
  emptyTitle: string;
  emptyBody: string;
  /** Where new messages land (conversation name): enables the screen-reader announcement of incoming ones. */
  announceIn?: string;
  /** Offers "Create card" on each message. */
  cardTarget?: {workspaceId: number; boardId: number | null};
};

/** The scrolling list: oldest first, "Load older" on top, stays at the bottom for new messages unless the reader scrolled up. */
function MessageList({feed, people, peopleList, me, canModerate, canPin, onReply, onSeen, emptyTitle, emptyBody, announceIn, cardTarget}: ListProps) {
  const t = useT();
  const {errorMessage, formatDate} = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(0);
  const anchor = useRef<{height: number} | null>(null);
  const total = feed.items.length + feed.pending.length;
  const [announcement, setAnnouncement] = useState('');
  const baseSeq = useRef<number | null>(null);
  const incoming = useRef(0);
  const announceTimer = useRef<number>(0);

  // Screen readers hear only NEW messages from others, summarised and debounced: never the history, never your own.
  useEffect(() => {
    if (feed.status !== 'ready' || !announceIn) return;
    if (baseSeq.current === null) {
      baseSeq.current = newestSeq(feed.items);
      return;
    }
    const {count, maxSeq} = incomingSince(feed.items, baseSeq.current, me);
    baseSeq.current = maxSeq;
    if (count === 0) return;
    incoming.current += count;
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => {
      const n = incoming.current;
      incoming.current = 0;
      setAnnouncement(n === 1 ? t('chat.incomingOne', {where: announceIn}) : t('chat.incomingMany', {n, where: announceIn}));
      announceTimer.current = window.setTimeout(() => setAnnouncement(''), 4000);
    }, 1500);
  }, [feed.items, feed.status, me, announceIn, t]);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  const toBottom = useCallback(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setUnseen(0);
  }, []);

  // A failed "Load older" added nothing: drop its anchor so the next new message still sticks to the bottom.
  useEffect(() => {
    if (feed.olderError != null) anchor.current = null;
  }, [feed.olderError]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (anchor.current) {
      // Older messages were added above: keep what the reader was looking at.
      el.scrollTop += el.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else if (total > lastCount.current && lastCount.current > 0) {
      setUnseen(n => n + (total - lastCount.current));
    }
    lastCount.current = total;
  }, [total, feed.status]);

  useEffect(() => {
    if (feed.status === 'ready' && stick.current && !document.hidden) onSeen?.(feed.known);
  }, [feed.known, feed.status, onSeen]);
  useEffect(() => {
    const wake = () => stick.current && !document.hidden && feed.status === 'ready' && onSeen?.(feed.known);
    document.addEventListener('visibilitychange', wake);
    return () => document.removeEventListener('visibilitychange', wake);
  }, [feed.known, feed.status, onSeen]);

  if (feed.status === 'loading') return <div className="chat-list-state"><LoadingBlock rows={5} /></div>;
  if (feed.status === 'error') {
    return (
      <div className="chat-list-state">
        <ErrorNote error={new Error(errorMessage(feed.error))} title={t('states.loadError')} />
        <Button variant="secondary" icon="refresh" onClick={() => void feed.load()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  let previous: MessageT | null = null;
  const rows = feed.items.map(m => {
    const newDay = !previous || dayKey(previous.createdAt) !== dayKey(m.createdAt);
    const grouped = !newDay && !!previous && previous.sender.id === m.sender.id && !previous.deleted && !m.deleted && new Date(m.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_MS;
    previous = m;
    return (
      <li key={m.id} className="chat-row">
        {newDay && (
          <div className="chat-day" role="separator">
            <span>{formatDate(m.createdAt, {dateStyle: 'medium'})}</span>
          </div>
        )}
        <ul className="chat-msgs">
          <MessageItem message={m} grouped={grouped} people={people} peopleList={peopleList} me={me} canWrite={feed.canWrite} canModerate={canModerate} canPin={canPin} onReply={onReply} onChange={feed.patch} cardTarget={cardTarget} />
        </ul>
      </li>
    );
  });

  return (
    <div className="chat-scroll-wrap">
      <p className="visually-hidden" role="status" aria-atomic="true">
        {announcement}
      </p>
      <div
        className="chat-scroll"
        ref={box}
        tabIndex={0}
        role="log"
        aria-label={t('chat.messages')}
        onScroll={event => {
          const el = event.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          if (near) {
            setUnseen(0);
            if (!document.hidden) onSeen?.(feed.known);
          }
        }}>
        {feed.nextBefore !== null && (
          <div className="chat-older">
            <Button
              variant="secondary"
              size="sm"
              icon="chevron-up"
              pending={feed.loadingOlder}
              pendingLabel={t('common.loading')}
              onClick={() => {
                anchor.current = {height: box.current?.scrollHeight ?? 0};
                void feed.loadOlder();
              }}>
              {t('chat.loadOlder')}
            </Button>
            {feed.olderError != null && (
              <p className="field-error" role="alert">
                {errorMessage(feed.olderError)}
              </p>
            )}
          </div>
        )}
        {feed.items.length === 0 && feed.pending.length === 0 ? (
          <EmptyState icon="message" title={emptyTitle}>
            {emptyBody}
          </EmptyState>
        ) : (
          <ul className="chat-rows">
            {rows}
            {feed.pending.map(p => (
              <li key={p.clientId} className="chat-row">
                <ul className="chat-msgs">
                  <PendingItem pending={p} onRetry={feed.retry} onDiscard={feed.discard} />
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
      {unseen > 0 && (
        <Button className="chat-jump" size="sm" icon="chevron-down" onClick={toBottom}>
          {t('chat.newMessages', {n: unseen})}
        </Button>
      )}
    </div>
  );
}

/** The pinned messages among those loaded (newest pin first in the list), one line each; a click jumps to it. */
function PinnedStrip({items}: {items: MessageT[]}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pinned = items.filter(m => m.pinned && !m.deleted && !m.parentId).reverse().slice(0, 5);
  if (pinned.length === 0) return null;
  const shown = open ? pinned : pinned.slice(0, 1);
  return (
    <section className="chat-pinned" aria-label={t('chat.pinnedMessages')}>
      <Icon name="pin" size={14} />
      <ul>
        {shown.map(m => (
          <li key={m.id}>
            <button
              type="button"
              className="chat-pinned-item" title={m.body}
              onClick={() => {
                const el = document.getElementById(`msg-${m.id}`);
                el?.scrollIntoView({block: 'center'});
                el?.focus?.();
              }}>
              <strong>{m.sender.name ?? t('chat.deletedUser')}</strong> {m.body.length > 90 ? `${m.body.slice(0, 90)}…` : m.body}
            </button>
          </li>
        ))}
      </ul>
      {pinned.length > 1 && (
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          {open ? t('chat.pinnedHide') : t('chat.pinnedCount', {n: pinned.length})}
        </Button>
      )}
    </section>
  );
}

function ThreadPanel({workspaceId, boardId, conversationId, parent, people, peopleList, me, canModerate, canWriteMain, onParentChange, onClose, onSent}: {
  workspaceId: number;
  boardId: number | null;
  conversationId: number;
  parent: MessageT;
  people: ReadonlyMap<number, MemberT>;
  peopleList: readonly MemberT[];
  me: number | undefined;
  canModerate: boolean;
  canWriteMain: boolean;
  onParentChange: (id: string, change: (m: MessageT) => MessageT) => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const t = useT();
  const feed = useMessageFeed({conversationId, parentId: parent.id, pollMs: 5000, me});
  return (
    <aside className="chat-thread" aria-label={t('chat.thread')}>
      <div className="chat-thread-head">
        <h3>{t('chat.thread')}</h3>
        <IconButton icon="x" size="sm" label={t('chat.closeThread')} onClick={onClose} />
      </div>
      <ul className="chat-msgs chat-thread-parent">
        <MessageItem message={parent} grouped={false} people={people} peopleList={peopleList} me={me} canWrite={canWriteMain} canModerate={canModerate} onChange={onParentChange} cardTarget={{workspaceId, boardId}} />
      </ul>
      <MessageList
        feed={feed}
        people={people}
        peopleList={peopleList}
        me={me}
        canModerate={canModerate || feed.canModerate}
        cardTarget={{workspaceId, boardId}}
        emptyTitle={t('chat.noRepliesTitle')}
        emptyBody={t('chat.noRepliesBody')}
      />
      {parent.deleted ? null : feed.canWrite ? (
        <Composer
          people={peopleList}
          workspaceId={workspaceId}
          draft={{kind: 'reply', id: Number(parent.id)}}
          label={t('chat.replyLabel')}
          placeholder={t('chat.replyPlaceholder')}
          autoFocus
          onSend={async (body, mentions, cardIds) => {
            const sent = await feed.send(body, mentions, cardIds);
            if (sent) onSent();
          }}
        />
      ) : (
        <Notice tone="info">{t('chat.readOnly')}</Notice>
      )}
    </aside>
  );
}

type ViewProps = {
  conversation: Pick<ConversationT, 'id' | 'kind' | 'name' | 'peer' | 'muted'> & {boardId?: number | null};
  workspaceId: number;
  /** Workspace role of the visitor (decides who may delete others' messages in channels). */
  role: string;
  /** Inside a board: no header title row, threads open over the chat. */
  embedded?: boolean;
  onBack?: () => void;
};

/** One conversation: header, messages, composer, and the open thread. Used by the Chat screen and a board's Chat tab. */
export function ConversationView({conversation, workspaceId, role, embedded, onBack}: ViewProps) {
  const t = useT();
  const toast = useToast();
  const {errorMessage} = useI18n();
  const queryClient = useQueryClient();
  const me = useMe().data?.viewer.id ?? undefined;
  const pulse = usePulse(true);
  const markRead = useMarkRead();
  const people = useQuery(chatPeopleQuery(workspaceId));
  const peopleList = useMemo(() => people.data ?? [], [people.data]);
  const byId = useMemo(() => new Map(peopleList.map(p => [p.userId, p])), [peopleList]);
  const pulseSeq = pulse.data?.find(p => p.conversationId === conversation.id)?.lastSeq;
  const feed = useMessageFeed({conversationId: conversation.id, pulseSeq, me});
  const [thread, setThread] = useState<string | null>(null);
  const [muted, setMuted] = useState(conversation.muted);
  const [muting, setMuting] = useState(false);
  const direct = conversation.kind === 'dm' || conversation.kind === 'group';
  // The server says (`canModerate` on the messages answer: workspace admins, or board admins in a board chat).
  const canModerate = feed.canModerate;
  const canPin = direct ? feed.canWrite : feed.canModerate;
  const title = conversationTitle(conversation, t);

  useEffect(() => setThread(null), [conversation.id]);
  useEffect(() => setMuted(conversation.muted), [conversation.id, conversation.muted]);

  const onSeen = useCallback((seq: number) => markRead(conversation.id, seq), [markRead, conversation.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMute = async () => {
    setMuting(true);
    try {
      await call(muted ? 'DELETE' : 'PUT', `/conversations/${conversation.id}/mute`);
      setMuted(!muted);
      toast.success(muted ? t('chat.unmuted') : t('chat.mutedToast'));
      void queryClient.invalidateQueries({queryKey: ['chat']});
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setMuting(false);
    }
  };

  const parent = thread ? (feed.items.find(m => m.id === thread) ?? null) : null;
  const bumpReply = () => thread && feed.patch(thread, m => ({...m, replyCount: m.replyCount + 1}));

  return (
    <section className="chat-view" data-embedded={embedded ? '' : undefined} aria-label={title}>
      <header className="chat-view-head">
        {onBack && <IconButton className="chat-back" icon="arrow-left" label={t('chat.backToList')} onClick={onBack} />}
        {!embedded && (
          <h2 className="chat-view-title">
            <Icon name={conversation.kind === 'channel' ? 'hash' : conversation.kind === 'board' ? 'layout-kanban' : 'message'} size={18} /> <bdi>{title}</bdi>
          </h2>
        )}
        <span className="chat-view-spacer" />
        <Button variant="ghost" size="sm" icon="bell" aria-pressed={muted} pending={muting} pendingLabel={muted ? t('chat.unmuting') : t('chat.muting')} onClick={() => void toggleMute()}>
          {muted ? t('chat.unmute') : t('chat.mute')}
        </Button>
      </header>
      <div className="chat-view-body" data-thread={thread ? '' : undefined}>
        <div className="chat-main">
          <PinnedStrip items={feed.items} />
          <MessageList
            feed={feed}
            people={byId}
            peopleList={peopleList}
            me={me}
            canModerate={canModerate}
            canPin={canPin}
            onReply={message => setThread(message.id)}
            onSeen={onSeen}
            emptyTitle={t('chat.emptyConversationTitle')}
            emptyBody={t('chat.emptyConversationBody')}
            announceIn={title}
            cardTarget={{workspaceId, boardId: conversation.boardId ?? null}}
          />
          {feed.status === 'ready' &&
            (feed.canWrite ? (
              <Composer people={peopleList} workspaceId={workspaceId} draft={{kind: 'chat', id: conversation.id}} label={t('chat.composerLabel')} placeholder={t('chat.composerPlaceholder', {name: title})} onSend={(body, mentions, cardIds) => feed.send(body, mentions, cardIds)} />
            ) : (
              <Notice tone="info">{t('chat.readOnly')}</Notice>
            ))}
        </div>
        {thread && parent && (
          <ThreadPanel
            key={parent.id}
            workspaceId={workspaceId}
            boardId={conversation.boardId ?? null}
            conversationId={conversation.id}
            parent={parent}
            people={byId}
            peopleList={peopleList}
            me={me}
            canModerate={canModerate}
            canWriteMain={feed.canWrite}
            onParentChange={feed.patch}
            onClose={() => setThread(null)}
            onSent={bumpReply}
          />
        )}
      </div>
    </section>
  );
}
