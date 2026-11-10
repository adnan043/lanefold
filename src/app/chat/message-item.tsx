import {useMutation} from '@tanstack/react-query';
import {memo, type ReactNode, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Avatar, Badge, Button, Icon, IconButton, Menu, type MenuItem, useConfirm, useToast} from '../../portal/ui';
import {Popover} from '../../portal/ui/popover';
import {call} from '../api';
import {Link} from '../nav';
import {useWriteCooldown} from '../write-cooldown';
import {CardChips} from './card-chip';
import {CreateCardDialog} from './create-card-dialog';
import {displayName, type MemberT, type MessageT, type ReactionT} from './api';
import {MAX_BODY, mentionedIds, segments} from './mentions';
import type {PendingMessage} from './use-message-feed';

export const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '🙏', '👎', '👏', '🔥', '🚀', '✅', '👀', '😀', '😍', '🤔', '😅', '😢', '😡', '💯', '💡', '⭐', '🙌', '🤝', '🐛'];

export function Body({message, people}: {message: Pick<MessageT, 'body' | 'mentions' | 'numberRefs'>; people: ReadonlyMap<number, MemberT>}) {
  const t = useT();
  const names = message.mentions.map(id => people.get(id)?.name ?? '').filter(Boolean);
  const refs = message.numberRefs;
  const numbers = refs && Object.keys(refs).length > 0 ? new Set(Object.keys(refs).map(Number)) : undefined;
  return (
    <p className="chat-body" dir="auto">
      {segments(message.body, names, numbers).map((part, i): ReactNode =>
        part.kind === 'card' ? (
          // The server resolved it for THIS viewer: a card of this board they may open. The title is plain text.
          <Link key={i} to={`/b/${refs![part.number]!.boardId}/c/${refs![part.number]!.id}` as never} className="chat-card-number" title={refs![part.number]!.title} aria-label={t('chat.openCard', {title: refs![part.number]!.title})}>
            {part.value}
          </Link>
        ) : part.kind === 'mention' ? (
          <span key={i} className="chat-mention">
            <bdi>{part.value}</bdi>
          </span>
        ) : part.kind === 'link' ? (
          <a key={i} href={part.value} target="_blank" rel="noopener noreferrer">
            {part.value}
          </a>
        ) : (
          part.value
        )
      )}
    </p>
  );
}

type ItemProps = {
  message: MessageT;
  /** Same sender as the message above, close in time: no name or avatar. */
  grouped: boolean;
  people: ReadonlyMap<number, MemberT>;
  peopleList: readonly MemberT[];
  me: number | undefined;
  canWrite: boolean;
  canModerate: boolean;
  /** Pin / unpin is offered (the server decides again: admins in channels and board chats, anyone in a DM or group). */
  canPin?: boolean;
  /** Not offered inside a thread (one level only). */
  onReply?: (message: MessageT) => void;
  onChange: (id: string, change: (m: MessageT) => MessageT) => void;
  /** "Create card" is offered when set: the workspace, and the board of a board chat (the dialog's default). */
  cardTarget?: {workspaceId: number; boardId: number | null};
};

/** One message: who, when, the text, reactions, and its actions (react, reply in thread, edit, delete). */
function MessageItemInner({message, grouped, people, peopleList, me, canWrite, canModerate, canPin, onReply, onChange, cardTarget}: ItemProps) {
  const t = useT();
  const {formatDate, formatDateTime, errorMessage} = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState('');
  const [picker, setPicker] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const own = message.sender.id === me;
  const name = displayName(message.sender.name, t('chat.deletedUser'));
  // Workspace owners and admins get a small role badge next to their name (from the member directory already loaded).
  const senderRole = message.sender.id != null ? people.get(message.sender.id)?.role : undefined;

  const react = useMutation({
    mutationFn: ({emoji, on}: {emoji: string; on: boolean}) =>
      call<{reactions: ReactionT[]}>(on ? 'PUT' : 'DELETE', `/messages/${message.id}/reactions`, {emoji}),
    onSuccess: ({reactions}) => onChange(message.id, m => ({...m, reactions})),
    onError: error => toast.danger(errorMessage(error)),
  });
  const pin = useMutation({
    mutationFn: (on: boolean) => call<{pinned: boolean}>(on ? 'PUT' : 'DELETE', `/messages/${message.id}/pin`),
    onSuccess: ({pinned}) => {
      onChange(message.id, m => ({...m, pinned}));
      toast.success(pinned ? t('chat.pinnedToast') : t('chat.unpinnedToast'));
    },
    onError: error => toast.danger(errorMessage(error)),
  });
  const cooldown = useWriteCooldown();
  const edit = useMutation({
    mutationFn: (body: string) => {
      // Mentions travel only when they changed; linked cards are never sent (the server keeps them when absent).
      const ids = mentionedIds(body, peopleList);
      const before = new Set(message.mentions);
      const changed = ids.length !== before.size || ids.some(id => !before.has(id));
      return call<{message: MessageT}>('PATCH', `/messages/${message.id}`, {body, ...(changed ? {mentions: ids} : {})});
    },
    onSuccess: ({message: next}) => {
      onChange(message.id, () => next);
      setEditing(false);
      setEditError('');
    },
    onError: error => setEditError(errorMessage(error)),
  });

  const remove = () =>
    void confirm({
      title: t('chat.deleteTitle'),
      body: t('chat.deleteBody'),
      confirmLabel: t('chat.delete'),
      pendingLabel: t('chat.deleting'),
      action: async () => {
        await call('DELETE', `/messages/${message.id}`);
        onChange(message.id, m => ({...m, deleted: true, body: '', reactions: [], mentions: [], replyCount: m.replyCount}));
      },
    });

  const startEdit = () => {
    setDraft(message.body);
    setEditError('');
    setEditing(true);
  };
  const saveEdit = () => {
    const body = draft.trim();
    if (!body) return setEditError(t('chat.writeSomething'));
    if (body.length > MAX_BODY) return setEditError(t('chat.tooLong', {n: body.length - MAX_BODY}));
    edit.mutate(body);
  };

  const menu: MenuItem[] = [];
  if (own && canWrite && !message.deleted) menu.push({label: t('chat.edit'), icon: 'pencil', onSelect: startEdit});
  if (cardTarget && !message.deleted && message.kind !== 'system' && (message.cardIds?.length ?? 0) < 10) menu.push({label: t('chat.createCard'), icon: 'layout-kanban', onSelect: () => setCardOpen(true)});
  if (canPin && !message.deleted && !pin.isPending) menu.push({label: message.pinned ? t('chat.unpin') : t('chat.pin'), icon: 'pin', onSelect: () => pin.mutate(!message.pinned)});
  if ((own || canModerate) && !message.deleted) menu.push({label: t('chat.delete'), icon: 'trash', danger: true, onSelect: remove});

  const time = formatDate(message.createdAt, {hour: 'numeric', minute: '2-digit'});

  if (message.deleted) {
    return (
      <li className="chat-msg chat-msg-deleted" data-grouped={grouped ? '' : undefined}>
        <span className="chat-msg-gutter" />
        <p className="chat-body muted">
          <Icon name="trash" size={14} /> {t('chat.deleted')}
          {message.replyCount > 0 && onReply && (
            <Button variant="link" size="sm" onClick={() => onReply(message)}>
              {t('chat.replies', {n: message.replyCount})}
            </Button>
          )}
        </p>
      </li>
    );
  }

  return (
    <li id={`msg-${message.id}`} tabIndex={-1} className="chat-msg" data-grouped={grouped ? '' : undefined} data-pinned={message.pinned ? '' : undefined}>
      <span className="chat-msg-gutter">{!grouped && <Avatar name={message.sender.name ?? ''} size="sm" />}</span>
      <div className="chat-msg-main">
        {!grouped && (
          <p className="chat-msg-head">
            <strong><bdi>{name}</bdi></strong>
            {senderRole === 'owner' || senderRole === 'admin' ? <span className="chat-role-badge">{t(`members.role.${senderRole}`)}</span> : null}
            <time dateTime={message.createdAt} title={formatDateTime(message.createdAt)}>
              {time}
            </time>
            {message.pinned && (
              <Badge icon="pin" tone="info">
                {t('chat.pinned')}
              </Badge>
            )}
          </p>
        )}
        {editing ? (
          <div className="chat-edit">
            <label className="visually-hidden" htmlFor={`edit-${message.id}`}>
              {t('chat.editLabel')}
            </label>
            <textarea
              id={`edit-${message.id}`}
              className="chat-edit-text"
              dir="auto"
              rows={3}
              value={draft}
              disabled={edit.isPending}
              aria-invalid={editError ? true : undefined}
              aria-describedby={editError ? `edit-error-${message.id}` : undefined}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape' && !edit.isPending) setEditing(false);
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveEdit();
              }}
              autoFocus
            />
            {editError && (
              <p id={`edit-error-${message.id}`} className="field-error" role="alert">
                {editError}
              </p>
            )}
            <div className="chat-edit-actions">
              <Button size="sm" variant="secondary" disabled={edit.isPending} onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" pending={edit.isPending} pendingLabel={t('common.saving')} disabled={cooldown.blocked} onClick={saveEdit}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Body message={message} people={people} />
            <CardChips cardIds={message.cardIds ?? []} />
            {message.edited && <span className="chat-edited muted">{t('chat.edited')}</span>}
          </>
        )}
        {message.reactions.length > 0 && (
          <div className="chat-reactions" role="group" aria-label={t('chat.reactions')}>
            {message.reactions.map(r => (
              <button
                key={r.emoji}
                type="button"
                className="chat-reaction"
                aria-pressed={r.mine}
                aria-label={t('chat.reactionLabel', {emoji: r.emoji, n: r.count})}
                disabled={!canWrite || react.isPending}
                onClick={() => react.mutate({emoji: r.emoji, on: !r.mine})}>
                <span aria-hidden="true">{r.emoji}</span> {r.count}
              </button>
            ))}
          </div>
        )}
        {onReply && message.replyCount > 0 && (
          <Button variant="link" size="sm" className="chat-thread-link" onClick={() => onReply(message)}>
            <Icon name="reply" size={14} /> {t('chat.replies', {n: message.replyCount})}
          </Button>
        )}
      </div>
      {!editing && (
        <div className="chat-msg-actions" role="toolbar" aria-label={t('chat.messageActions')}>
          {canWrite && (
            <>
              <button
                ref={pickerButton}
                type="button"
                className="button button-ghost button-sm icon-button"
                aria-label={t('chat.react')}
                title={t('chat.react')}
                aria-haspopup="dialog"
                aria-expanded={picker}
                disabled={react.isPending}
                onClick={() => setPicker(open => !open)}>
                {react.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="smile" size={16} />}
              </button>
              <Popover open={picker} onClose={() => setPicker(false)} anchor={pickerButton} label={t('chat.react')} align="end">
                <div className="chat-emoji-grid">
                  {QUICK_EMOJI.map(emoji => {
                    const mine = message.reactions.find(r => r.emoji === emoji)?.mine ?? false;
                    return (
                      <button
                        key={emoji}
                        type="button"
                        className="chat-emoji"
                        aria-pressed={mine}
                        aria-label={emoji}
                        onClick={() => {
                          setPicker(false);
                          react.mutate({emoji, on: !mine});
                        }}>
                        {emoji}
                      </button>
                    );
                  })}
                </div>
              </Popover>
            </>
          )}
          {onReply && canWrite && <IconButton icon="reply" size="sm" label={t('chat.replyInThread')} onClick={() => onReply(message)} />}
          {menu.length > 0 && <Menu label={t('chat.moreActions')} items={menu} />}
        </div>
      )}
      {cardTarget && (
        <CreateCardDialog
          open={cardOpen}
          onClose={() => setCardOpen(false)}
          message={message}
          workspaceId={cardTarget.workspaceId}
          defaultBoardId={cardTarget.boardId}
          onCreated={cardId => onChange(message.id, m => ({...m, cardIds: [...(m.cardIds ?? []), cardId]}))}
        />
      )}
    </li>
  );
}

export const MessageItem = memo(MessageItemInner);

/** A message that is still on its way, or failed: its text stays on screen with Retry (same key, never twice). */
export function PendingItem({pending, onRetry, onDiscard}: {pending: PendingMessage; onRetry: (clientId: string) => void; onDiscard: (clientId: string) => void}) {
  const t = useT();
  const failed = pending.status === 'failed';
  return (
    <li className="chat-msg chat-msg-pending" data-failed={failed ? '' : undefined} aria-busy={!failed || undefined}>
      <span className="chat-msg-gutter" />
      <div className="chat-msg-main">
        <p className="chat-body" dir="auto">{pending.body}</p>
        {failed ? (
          <p className="chat-pending-note" role="alert">
            <Icon name="alert" size={14} /> {pending.error || t('errors.unknown')}
            <Button size="sm" variant="secondary" onClick={() => onRetry(pending.clientId)}>
              {t('chat.retry')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDiscard(pending.clientId)}>
              {t('chat.discard')}
            </Button>
          </p>
        ) : (
          <p className="chat-pending-note muted">
            <span className="spinner" aria-hidden="true" /> {t('chat.sending')}
          </p>
        )}
      </div>
    </li>
  );
}
