import {useQuery, useQueryClient} from '@tanstack/react-query';
import {type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Avatar, Button, EmptyState, ErrorNote, Icon, IconButton, LoadingBlock, Menu, type MenuItem, Notice, useConfirm, useToast} from '../../portal/ui';
import {useMe} from '../../portal/shared';
import {call} from '../api';
import {type ChatPersonT, chatPeopleQuery, type ConversationT, conversationsQuery, type MessageT, type PulseItem, pulseKey, useMarkRead, usePulse} from './api';
import {incomingSince, newestSeq} from './announce';
import {Composer} from './composer';
import {MembersButton} from './members-dialog';
import {dayKey} from './mentions';
import {MessageItem, PendingItem} from './message-item';
import {MAX_KEPT, type MessageFeed, useMessageFeed} from './use-message-feed';
import './chat.css';

const GROUP_MS = 5 * 60_000;
/** Newer rows are dropped while the reader is up the list only once the list is this far past `MAX_KEPT` (no churn per message). */
const TRIM_SLACK = 25;

/** Where the reader is: the first row on screen and how far below the list's top edge it starts. */
type Anchor = {seq: string; offset: number};

/** The first row on screen in `box` (binary search over the rows, which are in order). */
function captureAnchor(box: HTMLElement | null): Anchor | null {
  if (!box) return null;
  const top = box.getBoundingClientRect().top;
  const rows = box.querySelectorAll<HTMLElement>('.chat-rows > li[data-seq]');
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.getBoundingClientRect().bottom > top) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (found < 0) return null;
  const row = rows[found]!;
  return {seq: row.dataset.seq!, offset: row.getBoundingClientRect().top - top};
}

/** Puts the anchored row back where it was on screen (rows were added or dropped above or below it). */
function restoreAnchor(box: HTMLElement, anchor: Anchor) {
  const row = box.querySelector<HTMLElement>(`.chat-rows > li[data-seq="${anchor.seq}"]`);
  if (!row) return;
  box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.offset;
}

export const conversationTitle = (c: Pick<ConversationT, 'kind' | 'name' | 'peer'>, t: (key: any) => string) =>
  c.kind === 'dm' ? c.peer?.name || t('chat.deletedUser') : c.name || (c.kind === 'board' ? t('chat.boardChat') : t('chat.untitled'));

type ListProps = {
  feed: MessageFeed;
  people: ReadonlyMap<number, ChatPersonT>;
  peopleList: readonly ChatPersonT[];
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
  /** Keep every loaded message (an open thread's parent must stay in the list). */
  holdTrim?: boolean;
  /** Shown above the first message once the start of the history is loaded (the main list, not a thread). */
  welcome?: {mark: ReactNode; title: string};
};

/** The scrolling list: oldest first, "Load older" on top, stays at the bottom for new messages unless the reader scrolled up. */
function MessageList({feed, people, peopleList, me, canModerate, canPin, onReply, onSeen, emptyTitle, emptyBody, announceIn, cardTarget, holdTrim, welcome}: ListProps) {
  const t = useT();
  const {errorMessage, formatDate} = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(0);
  /** The reader is at the end of the loaded rows (state twin of `stick`, for the trims below). */
  const [atBottom, setAtBottom] = useState(true);
  const lastNewest = useRef(0);
  const lastPending = useRef(0);
  /** Set right before rows are added or dropped around the reader: the layout effect keeps that row where it was. */
  const anchor = useRef<Anchor | null>(null);
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

  const {hasNewer, reloadNewest} = feed;
  const toBottom = useCallback(() => {
    const el = box.current;
    stick.current = true;
    setAtBottom(true);
    setUnseen(0);
    // Newer rows were dropped: fetch the newest page; the layout effect sticks to the bottom once it is in.
    if (hasNewer) void reloadNewest();
    else if (el) el.scrollTop = el.scrollHeight;
  }, [hasNewer, reloadNewest]);

  // A failed "Load older" added nothing: drop its anchor so the next new message still sticks to the bottom.
  useEffect(() => {
    if (feed.olderError != null) anchor.current = null;
  }, [feed.olderError]);

  const newest = feed.items.length ? feed.items[feed.items.length - 1]!.seq : 0;
  useLayoutEffect(() => {
    const el = box.current;
    const pendingCount = feed.pending.length;
    if (el) {
      if (anchor.current) {
        // Rows were added or dropped around the reader (older page, newer page, a trim): keep what they look at.
        restoreAnchor(el, anchor.current);
        anchor.current = null;
      } else if (stick.current) {
        el.scrollTop = el.scrollHeight;
      } else if (lastNewest.current > 0 && (newest > lastNewest.current || pendingCount > lastPending.current)) {
        // Only messages that arrived at the end count as unseen (never a page loaded above or a refresh).
        const added = feed.items.filter(m => m.seq > lastNewest.current).length + Math.max(0, pendingCount - lastPending.current);
        if (added > 0) setUnseen(n => n + added);
      }
    }
    lastNewest.current = newest;
    lastPending.current = pendingCount;
  }, [feed.items, feed.pending.length, feed.status, newest]);

  useEffect(() => {
    if (feed.status === 'ready' && stick.current && !hasNewer && !document.hidden) onSeen?.(feed.known);
  }, [feed.known, feed.status, hasNewer, onSeen]);

  // A long session keeps at most MAX_KEPT rows. Back at the newest, the oldest are dropped ("Load older" fetches them
  // again). Read further up ("Load older" many times), the newest are dropped once they are well below the screen,
  // and scrolling back down loads them again: the reader's row never moves (anchor).
  const {trim, trimNewest} = feed;
  const tooMany = feed.items.length > MAX_KEPT;
  useEffect(() => {
    if (!tooMany || !atBottom || holdTrim) return;
    if (!stick.current) anchor.current = captureAnchor(box.current);
    trim();
  }, [tooMany, atBottom, holdTrim, trim]);
  useEffect(() => {
    const el = box.current;
    if (!el || atBottom || holdTrim || feed.items.length <= MAX_KEPT + TRIM_SLACK) return;
    const firstDropped = el.querySelector<HTMLElement>(`.chat-rows > li[data-seq="${feed.items[MAX_KEPT]!.seq}"]`);
    if (!firstDropped) return;
    // Still within two screens of the reader: keep it.
    if (firstDropped.getBoundingClientRect().top - el.getBoundingClientRect().top < el.clientHeight * 2) return;
    anchor.current = captureAnchor(el);
    trimNewest();
  }, [feed.items, atBottom, holdTrim, trimNewest]);
  useEffect(() => {
    const wake = () => stick.current && !hasNewer && !document.hidden && feed.status === 'ready' && onSeen?.(feed.known);
    document.addEventListener('visibilitychange', wake);
    return () => document.removeEventListener('visibilitychange', wake);
  }, [feed.known, feed.status, hasNewer, onSeen]);

  const {loadNewer, loadingNewer} = feed;
  const fetchNewer = useCallback(() => {
    if (loadingNewer) return;
    anchor.current = captureAnchor(box.current);
    void loadNewer();
  }, [loadNewer, loadingNewer]);

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
      <li key={m.id} className="chat-row" data-seq={m.seq}>
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
          // At the end of a list that does not reach the newest: load the next newer page, never mark it read.
          stick.current = near && !hasNewer;
          setAtBottom(near);
          if (near && hasNewer) fetchNewer();
          else if (near) {
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
                anchor.current = captureAnchor(box.current);
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
        {welcome && feed.nextBefore === null && (
          <div className="chat-welcome">
            {welcome.mark}
            <h3>
              <bdi>{welcome.title}</bdi>
            </h3>
          </div>
        )}
        {feed.items.length === 0 && feed.pending.length === 0 ? (
          welcome ? (
            <p className="muted chat-welcome-note">{emptyBody}</p>
          ) : (
            <EmptyState icon="message" title={emptyTitle}>
              {emptyBody}
            </EmptyState>
          )
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
        {hasNewer && (
          <div className="chat-older">
            <Button variant="secondary" size="sm" icon="chevron-down" pending={loadingNewer} pendingLabel={t('common.loading')} onClick={fetchNewer}>
              {t('chat.loadNewer')}
            </Button>
          </div>
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

function ThreadPanel({workspaceId, boardId, conversationId, title, parent, pulseSeq, people, peopleList, me, canModerate, canWriteMain, onParentChange, onClose, onSent}: {
  workspaceId: number;
  boardId: number | null;
  conversationId: number;
  /** The conversation's name, under the panel's heading. */
  title: string;
  parent: MessageT;
  /** The conversation's `lastSeq` from the pulse: a reply moves it, so the thread fetches only when it moved. */
  pulseSeq: number | undefined;
  people: ReadonlyMap<number, ChatPersonT>;
  peopleList: readonly ChatPersonT[];
  me: number | undefined;
  canModerate: boolean;
  canWriteMain: boolean;
  onParentChange: (id: string, change: (m: MessageT) => MessageT) => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const t = useT();
  // No timer of its own: a reply moves the conversation's `lastSeq`, so the thread asks for new replies only when
  // the pulse (already running for the open chat) moved; edits in the thread come with its 20 s window refresh.
  const feed = useMessageFeed({conversationId, parentId: parent.id, pulseSeq, me});
  const cardTarget = useMemo(() => ({workspaceId, boardId}), [workspaceId, boardId]);
  return (
    <aside className="chat-thread" aria-label={t('chat.thread')}>
      <div className="chat-thread-head">
        <div className="chat-thread-heading">
          <h3>{t('chat.thread')}</h3>
          <p className="muted">
            <bdi>{title}</bdi>
          </p>
        </div>
        <IconButton icon="x" label={t('chat.closeThread')} onClick={onClose} />
      </div>
      <ul className="chat-msgs chat-thread-parent">
        <MessageItem message={parent} grouped={false} people={people} peopleList={peopleList} me={me} canWrite={canWriteMain} canModerate={canModerate} onChange={onParentChange} cardTarget={cardTarget} />
      </ul>
      {parent.replyCount > 0 && (
        <div className="chat-thread-count" role="presentation">
          <span>{t('chat.replies', {n: parent.replyCount})}</span>
        </div>
      )}
      <MessageList
        feed={feed}
        people={people}
        peopleList={peopleList}
        me={me}
        canModerate={canModerate || feed.canModerate}
        cardTarget={cardTarget}
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
          submitLabel={t('chat.replyLabel')}
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
  const confirm = useConfirm();
  const {errorMessage} = useI18n();
  const queryClient = useQueryClient();
  const me = useMe().data?.viewer.id ?? undefined;
  const pulse = usePulse(true);
  const markRead = useMarkRead();
  // The directory is the workspace's: a guest (a seat on one board) never asks for it.
  const people = useQuery({...chatPeopleQuery(workspaceId), enabled: role !== 'guest'});
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
  // Stable props for the memoised MessageItem: a new function or object here re-renders every message.
  const onReply = useCallback((message: MessageT) => setThread(message.id), []);
  const boardId = conversation.boardId ?? null;
  const cardTarget = useMemo(() => ({workspaceId, boardId}), [workspaceId, boardId]);

  const toggleMute = async () => {
    setMuting(true);
    try {
      await call(muted ? 'DELETE' : 'PUT', `/conversations/${conversation.id}/mute`);
      const next = !muted;
      setMuted(next);
      toast.success(muted ? t('chat.unmuted') : t('chat.mutedToast'));
      // Only what shows the muted flag, in place: never the whole chat cache (that refetched every list and message).
      // Muting also joins a channel I had not joined, so the pulse is read again to pick it up.
      const id = conversation.id;
      const flip = <T extends {id: number; muted: boolean; joined?: boolean}>(c: T): T => (c.id === id ? {...c, muted: next, joined: true} : c);
      queryClient.setQueryData<PulseItem[]>(pulseKey, items => items?.map(p => (p.conversationId === id ? {...p, muted: next} : p)));
      queryClient.setQueriesData<ConversationT[]>({queryKey: ['chat', 'conversations']}, list => list?.map(flip));
      queryClient.setQueriesData<ConversationT>({queryKey: ['chat', 'conversation', id]}, c => (c ? flip(c) : c));
      if (conversation.kind === 'board' && boardId) queryClient.setQueriesData<ConversationT>({queryKey: ['chat', 'board', boardId]}, c => (c ? flip(c) : c));
      void queryClient.invalidateQueries({queryKey: pulseKey});
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setMuting(false);
    }
  };

  // Workspace owners and admins archive a channel (the server checks again) and restore an archived one.
  const canArchive = conversation.kind === 'channel' && (role === 'owner' || role === 'admin') && feed.status === 'ready';
  const [archiving, setArchiving] = useState(false);
  const setArchivedTo = async (archived: boolean) => {
    await call(archived ? 'PUT' : 'DELETE', `/conversations/${conversation.id}/archive`);
    // The open view keeps its conversation (read by id once the list drops it), then the list and the pulse follow.
    const listed = queryClient.getQueryData(conversationsQuery(workspaceId).queryKey)?.find(c => c.id === conversation.id);
    if (listed) queryClient.setQueryData(['chat', 'conversation', conversation.id], {...listed, workspaceId, archived, canWrite: false, canModerate: false});
    await feed.reloadNewest();
    void queryClient.invalidateQueries({queryKey: ['chat', 'conversations', workspaceId]});
    void queryClient.invalidateQueries({queryKey: ['chat', 'conversation', conversation.id]});
    void queryClient.invalidateQueries({queryKey: pulseKey});
  };
  const archiveChannel = () =>
    void confirm({
      title: t('chat.archiveTitle'),
      body: t('chat.archiveBody'),
      confirmLabel: t('chat.archiveChannel'),
      pendingLabel: t('chat.archiving'),
      action: async () => {
        await setArchivedTo(true);
        toast.success(t('chat.archivedToast'));
      },
    });
  const restoreChannel = async () => {
    setArchiving(true);
    try {
      await setArchivedTo(false);
      toast.success(t('chat.restoredToast'));
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setArchiving(false);
    }
  };
  const channelMenu: MenuItem[] = !canArchive
    ? []
    : feed.archived
      ? [{label: t('chat.restoreChannel'), icon: 'refresh', onSelect: () => void restoreChannel(), disabled: archiving}]
      : [{label: t('chat.archiveChannel'), icon: 'archive', danger: true, onSelect: archiveChannel}];

  const parent = thread ? (feed.items.find(m => m.id === thread) ?? null) : null;
  /** The conversation's mark: a DM's person, or a tile with its kind's icon (the board's in the accent). */
  const mark = (size: 'md' | 'lg') =>
    conversation.kind === 'dm' ? (
      <Avatar name={title} size={size === 'lg' ? 'md' : 'sm'} />
    ) : (
      <span className="chat-mark" data-size={size} data-kind={conversation.kind} aria-hidden="true">
        <Icon name={conversation.kind === 'channel' ? 'hash' : conversation.kind === 'board' ? 'layout-kanban' : conversation.kind === 'group' ? 'users' : 'message'} size={size === 'lg' ? 20 : 16} />
      </span>
    );
  const welcomeTitle =
    conversation.kind === 'channel'
      ? t('chat.welcomeChannel', {name: title})
      : conversation.kind === 'dm'
        ? t('chat.welcomeDirect', {name: title})
        : conversation.kind === 'board'
          ? t('chat.welcomeBoard', {name: title})
          : t('chat.welcomeGroup', {name: title});
  const bumpReply = () => thread && feed.patch(thread, m => ({...m, replyCount: m.replyCount + 1}));

  return (
    <section className="chat-view" data-embedded={embedded ? '' : undefined} aria-label={title}>
      <header className="chat-view-head">
        {onBack && <IconButton className="chat-back" icon="arrow-left" label={t('chat.backToList')} onClick={onBack} />}
        {!embedded && (
          <div className="chat-view-heading">
            {mark('md')}
            <h2 className="chat-view-title">
              <bdi>{title}</bdi>
            </h2>
          </div>
        )}
        <span className="chat-view-spacer" />
        {conversation.kind !== 'board' && <MembersButton key={conversation.id} conversationId={conversation.id} kind={conversation.kind} title={title} workspaceId={workspaceId} />}
        <IconButton icon={muted ? 'bell-off' : 'bell'} label={muting ? (muted ? t('chat.unmuting') : t('chat.muting')) : muted ? t('chat.unmute') : t('chat.mute')} aria-pressed={muted} pending={muting} onClick={() => void toggleMute()} />
        {channelMenu.length > 0 && <Menu label={t('chat.channelActions')} items={channelMenu} disabled={archiving} />}
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
            onReply={onReply}
            onSeen={onSeen}
            emptyTitle={t('chat.emptyConversationTitle')}
            emptyBody={t('chat.emptyConversationBody')}
            announceIn={title}
            cardTarget={cardTarget}
            holdTrim={thread !== null}
            welcome={embedded ? undefined : {mark: mark('lg'), title: welcomeTitle}}
          />
          {feed.status === 'ready' &&
            (feed.canWrite ? (
              <Composer people={peopleList} workspaceId={workspaceId} draft={{kind: 'chat', id: conversation.id}} label={t('chat.composerLabel')} placeholder={t('chat.composerPlaceholder', {name: title})} onSend={(body, mentions, cardIds) => feed.send(body, mentions, cardIds)} />
            ) : (
              <Notice tone="info">{feed.archived ? t('chat.archivedNotice') : t('chat.readOnly')}</Notice>
            ))}
        </div>
        {thread && parent && (
          <ThreadPanel
            key={parent.id}
            workspaceId={workspaceId}
            boardId={conversation.boardId ?? null}
            conversationId={conversation.id}
            title={title}
            parent={parent}
            pulseSeq={pulseSeq}
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
