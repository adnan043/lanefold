import {type ReactNode, useEffect, useId, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Avatar, Button, Icon, Menu, useConfirm, useToast} from '../../portal/ui';
import {Popover} from '../../portal/ui/popover';
import {QUICK_EMOJI} from '../emoji';
import {useDraft, usePeekDraft} from '../use-draft';
import {useWriteCooldown} from '../write-cooldown';
import {MdView} from './description';
import {EditorToolbar} from './editor-toolbar';
import {PeoplePopover} from './pickers';
import {useAction} from './parts';
import {insertMention, mentionAt} from '../chat/mentions';
import {useMe} from '../../portal/shared';
import type {ActivityT, CardActions, CommentT, DetailT, PersonT} from './use-card';
import {useActivity, usePeople} from './use-card';

const MAX = 5000;

/** Markdown subset rendered as React elements (never HTML), with the `@Name` of mentioned people in bold. */
function Body({body, mentions}: {body: string; mentions: PersonT[]}) {
  return <MdView source={body} mentions={mentions.map(m => m.name).filter(Boolean)} />;
}

/**
 * The text split into plain parts and the `@Name` of picked people (whole words, longest names first), for the
 * highlight drawn behind the text box.
 */
export function mentionParts(text: string, names: readonly string[]): {text: string; mention: boolean}[] {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const out: {text: string; mention: boolean}[] = [];
  let plain = '';
  let i = 0;
  const wordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  while (i < text.length) {
    const name =
      text[i] === '@' && !wordChar(text[i - 1]) ? sorted.find(n => text.startsWith(n, i + 1) && !wordChar(text[i + 1 + n.length])) : undefined;
    if (name) {
      if (plain) out.push({text: plain, mention: false});
      plain = '';
      out.push({text: `@${name}`, mention: true});
      i += name.length + 1;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) out.push({text: plain, mention: false});
  return out;
}

/** Box metrics the highlight layer copies from the text box, so each chip sits exactly under its `@Name`. */
const MIRRORED = ['font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'text-transform', 'word-spacing', 'tab-size', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'direction'] as const;

/**
 * A layer BEHIND the comment box that draws a coloured chip under each `@Name` (a text box cannot colour part of
 * its text). Its letters are invisible: the box's own text stays on top, so typing, selecting and the caret are
 * untouched. Follows the box's size, scroll and font (copied from its computed style: no inline style attribute).
 */
function MentionBackdrop({area, text, names}: {area: React.RefObject<HTMLTextAreaElement | null>; text: string; names: string[]}) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = area.current;
    const back = layer.current;
    if (!box || !back) return;
    const sync = () => {
      const cs = getComputedStyle(box);
      for (const prop of MIRRORED) back.style.setProperty(prop, cs.getPropertyValue(prop));
      back.style.setProperty('top', `${box.offsetTop}px`);
      back.style.setProperty('left', `${box.offsetLeft}px`);
      // The box's width without its scrollbar (the layer has none), so the lines wrap at the same place.
      back.style.setProperty('width', `${box.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`);
      back.style.setProperty('height', `${box.offsetHeight}px`);
      back.scrollTop = box.scrollTop;
    };
    sync();
    const onScroll = () => {
      back.scrollTop = box.scrollTop;
    };
    box.addEventListener('scroll', onScroll);
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    watch?.observe(box);
    return () => {
      box.removeEventListener('scroll', onScroll);
      watch?.disconnect();
    };
  }, [area]);
  // After each change of the text the box may have scrolled (a new line at the bottom).
  useEffect(() => {
    if (layer.current && area.current) layer.current.scrollTop = area.current.scrollTop;
  }, [text, area]);
  const parts = names.length ? mentionParts(text, names) : [];
  return (
    <div ref={layer} className="cd-mention-backdrop" aria-hidden="true">
      {parts.map((part, i) => (part.mention ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
      {/* A trailing line break still takes a line in the box: keep the heights equal. */}
      {'\n '}
    </div>
  );
}

/** `value`, once it has stayed the same for `ms` (the people search runs on a pause in typing, not every key). */
function useDebouncedValue<T>(value: T, ms = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The text box with a Mention button, and an `@` list while a name is typed; the ids sent are the people whose
 * `@Name` is still in the text.
 */
function Composer({
  cardId,
  editId,
  initial,
  initialMentions,
  submitLabel,
  pendingLabel,
  pending,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  cardId: number;
  /** Set when editing an existing comment: the draft is kept under this comment's id. */
  editId?: number;
  initial?: string;
  initialMentions?: PersonT[];
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  onSubmit: (body: string, mentions: number[]) => Promise<boolean>;
  onCancel?: () => void;
  /** Opened from the one-line "Write a comment…" box: the cursor goes straight into the editor. */
  autoFocus?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState(initial ?? '');
  const clearDraft = useDraft(editId === undefined ? 'comment' : 'cedit', editId ?? cardId, text, setText, initial ?? '');
  const {blocked} = useWriteCooldown();
  const cancel = onCancel && (() => {
    clearDraft();
    onCancel();
  });
  const [picked, setPicked] = useState<PersonT[]>(initialMentions ?? []);
  const [error, setError] = useState('');
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  // Typing `@` lists the people of this card's board (names only, from the server), like the chat composer.
  const listId = useId();
  const meId = useMe().data?.viewer.id ?? null;
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const typing = dismissed || pending ? null : mentionAt(text, caret);
  const query = useDebouncedValue(typing ? typing.query.trim() : null);
  const people = usePeople(cardId, query ?? '', query !== null);
  const options = typing && query !== null ? (people.data?.items ?? []).filter(p => p.id !== meId).slice(0, 8) : [];
  const listOpen = options.length > 0;
  const current = listOpen ? Math.min(active, options.length - 1) : 0;
  const pickTyped = (person: PersonT) => {
    if (!typing) return;
    const next = insertMention(text, caret, typing.start, person.name);
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    setPicked(list => (list.some(p => p.id === person.id) ? list : [...list, {id: person.id, name: person.name}]));
    window.requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      // Only while nothing was typed since the pick: a fast key would otherwise be left behind the caret.
      if (el.value === next.text) el.setSelectionRange(next.caret, next.caret);
    });
  };
  useEffect(() => {
    if (!autoFocus) return;
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);
  const submit = async () => {
    if (blocked) return;
    const body = text.trim();
    if (!body) return setError(t('cd.commentRequired'));
    if (body.length > MAX) return setError(t('cd.commentTooLong'));
    setError('');
    const ids = mentionedIn(body, picked);
    if (await onSubmit(body, ids)) {
      clearDraft();
      setText('');
      setPicked([]);
    }
  };
  const mention = (person: PersonT) => {
    setPicked(list => (list.some(p => p.id === person.id) ? list : [...list, person]));
    setText(value => `${value}${value && !/\s$/.test(value) ? ' ' : ''}@${person.name} `);
    setOpen(false);
    window.setTimeout(() => area.current?.focus(), 0);
  };
  return (
    <form
      className="cd-composer"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}>
      <div className="cd-editor-wrap">
      <div ref={anchor} className="cd-editor">
      <EditorToolbar area={area} text={text} setText={setText} disabled={pending} onMention={() => setOpen(true)} />
      {listOpen && (
        <p className="visually-hidden" id={`${listId}-hint`} role="status">
          {t('chat.suggestionsHint', {n: options.length})}
        </p>
      )}
      <MentionBackdrop area={area} text={text} names={picked.map(p => p.name)} />
      <textarea
        ref={area}
        className="cd-mention-input"
        value={text}
        rows={3}
        aria-label={t('cd.commentLabel')}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errorId : '', listOpen ? `${listId}-hint` : ''].filter(Boolean).join(' ') || undefined}
        aria-controls={listOpen ? listId : undefined}
        aria-activedescendant={listOpen ? `${listId}-p${current}` : undefined}
        placeholder={t('cd.commentPlaceholder')}
        disabled={pending}
        onChange={event => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setDismissed(false);
          if (error) setError('');
        }}
        onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setDismissed(true)}
        onFocus={() => setDismissed(false)}
        onKeyDown={event => {
          // An input method (Japanese, Chinese, Korean…) is composing: its Enter and arrows are its own.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (listOpen) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
              return;
            }
            if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
              event.preventDefault();
              const person = options[current];
              if (person) pickTyped({id: person.id, name: person.name});
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation(); // closes the list only, not the card
              setDismissed(true);
              return;
            }
          }
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          } else if (event.key === 'Escape' && cancel) {
            event.stopPropagation();
            event.preventDefault(); // the modal's native Esc must not also fire
            cancel();
          }
        }}
      />
      </div>
      {listOpen && (
        <ul className="cd-mention-list" role="listbox" id={listId} aria-label={t('chat.mentionList')}>
          {options.map((person, index) => (
            <li
              key={person.id}
              id={`${listId}-p${index}`}
              role="option"
              aria-selected={index === current}
              data-active={index === current ? '' : undefined}
              onPointerDown={event => {
                event.preventDefault(); // keeps the focus (and the caret) in the text box
                pickTyped({id: person.id, name: person.name});
              }}>
              <Avatar name={person.name} size="sm" />
              <span className="cd-mention-name">{person.name}</span>
            </li>
          ))}
        </ul>
      )}
      </div>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="cd-composer-actions">
        <span className="cd-spacer" />
        {onCancel && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={cancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!text.trim() || blocked} pending={pending} pendingLabel={pendingLabel}>
          {submitLabel}
        </Button>
      </div>
      <PeoplePopover cardId={cardId} open={open} onClose={() => setOpen(false)} anchor={anchor} label={t('cd.mention')} isOn={id => picked.some(p => p.id === id)} onPick={mention} />
    </form>
  );
}

/** The reaction chips under a comment and the 😊 button that adds one (👍 is the usual "seen"). */
function useReact(comment: CommentT, actions: CardActions) {
  const {errorMessage} = useI18n();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const react = async (emoji: string, on: boolean) => {
    if (pending) return;
    setPending(true);
    try {
      await actions.reactComment(comment.id, emoji, on);
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return {pending, react};
}

function ReactButton({comment, pending, react}: {comment: CommentT; pending: boolean; react: (emoji: string, on: boolean) => void}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="button button-ghost button-sm icon-button"
        aria-label={t('chat.react')}
        title={t('chat.react')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={pending || undefined}
        disabled={pending}
        onClick={() => setOpen(v => !v)}>
        {pending ? <span className="spinner" aria-hidden="true" /> : <Icon name="smile" size={16} />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={button} label={t('chat.react')} align="end">
        <div className="cd-emoji-grid">
          {QUICK_EMOJI.map(emoji => {
            const mine = comment.reactions.find(r => r.emoji === emoji)?.mine ?? false;
            return (
              <button
                key={emoji}
                type="button"
                className="cd-emoji"
                aria-pressed={mine}
                aria-label={emoji}
                onClick={() => {
                  setOpen(false);
                  react(emoji, !mine);
                }}>
                {emoji}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

function CommentRow({comment, detail, actions, busy, run}: {comment: CommentT; detail: DetailT; actions: CardActions; busy: string | null; run: ReturnType<typeof useAction>['run']}) {
  const t = useT();
  const {formatRelative, formatDateTime} = useI18n();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(usePeekDraft('cedit', comment.id));
  const name = comment.authorName ?? t('cd.deletedUser');
  const canEdit = comment.mine && detail.canWrite;
  const canDelete = detail.canWrite && (comment.mine || detail.canAdmin);
  const {pending: reacting, react} = useReact(comment, actions);
  return (
    <li className="cd-comment">
      <Avatar name={name} size="sm" />
      <div className="cd-comment-main">
        <div className="cd-comment-head">
          <strong>{name}</strong>
          <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>
            {formatRelative(comment.createdAt)}
          </time>
          {comment.edited && <span className="cd-none">{t('cd.commentEdited')}</span>}
          <span className="cd-spacer" />
          {detail.canWrite && !editing && <ReactButton comment={comment} pending={reacting} react={(emoji, on) => void react(emoji, on)} />}
          {(canEdit || canDelete) && !editing && (
            <Menu
              label={t('cd.commentMenu')}
              items={[
                ...(canEdit ? [{label: t('cd.commentEdit'), icon: 'pencil' as const, onSelect: () => setEditing(true)}] : []),
                ...(canDelete
                  ? [
                      {
                        label: t('cd.commentDelete'),
                        icon: 'trash' as const,
                        danger: true,
                        onSelect: () =>
                          void confirm({
                            title: t('cd.commentDeleteTitle'),
                            body: t('cd.commentDeleteBody'),
                            confirmLabel: t('cd.commentDelete'),
                            action: () => actions.deleteComment(comment.id),
                          }),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </div>
        {!editing && <Body body={comment.body} mentions={comment.mentions} />}
        {!editing && comment.reactions.length > 0 && (
          <div className="cd-reactions" role="group" aria-label={t('chat.reactions')}>
            {comment.reactions.map(r => (
              <button
                key={r.emoji}
                type="button"
                className="cd-reaction"
                aria-pressed={r.mine}
                aria-label={t('chat.reactionLabel', {emoji: r.emoji, n: r.count})}
                disabled={!detail.canWrite || reacting}
                onClick={() => void react(r.emoji, !r.mine)}>
                <span aria-hidden="true">{r.emoji}</span> {r.count}
              </button>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <Composer
          cardId={detail.card.id}
          editId={comment.id}
          initial={comment.body}
          initialMentions={comment.mentions}
          submitLabel={t('common.save')}
          pendingLabel={t('common.saving')}
          pending={busy === `c-${comment.id}`}
          onCancel={() => setEditing(false)}
          onSubmit={async (body, ids) => {
            const ok = await run(`c-${comment.id}`, () => actions.editComment(comment.id, body, ids));
            if (ok) setEditing(false);
            return ok;
          }}
        />
      )}
    </li>
  );
}

/**
 * Who a comment really names: `@Name` as a whole word, longest names first, and a match is used up so "@Ann Lee"
 * does not also count "@Ann", nor "@Annabel" count "@Ann".
 */
function mentionedIn(body: string, picked: PersonT[]): number[] {
  let rest = body;
  const ids: number[] = [];
  for (const person of [...picked].sort((a, b) => b.name.length - a.name.length)) {
    const escaped = person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?![\\p{L}\\p{N}_])`, 'u').exec(rest);
    if (!found) continue;
    ids.push(person.id);
    const at = found.index + found[1]!.length;
    rest = `${rest.slice(0, at)}${' '.repeat(person.name.length + 1)}${rest.slice(at + person.name.length + 1)}`;
  }
  return ids;
}

/** `children` (the attachments) sit right under the comment box, above the comments. */
export function Comments({detail, actions, children}: {detail: DetailT; actions: CardActions; children?: ReactNode}) {
  const t = useT();
  const {busy, run} = useAction();
  const {comments, canWrite} = detail;
  // A one-line "Write a comment…" box first; a click (or Enter) opens the full editor. A kept half-written comment
  // opens the editor straight away so it is never hidden.
  const kept = usePeekDraft('comment', detail.card.id);
  const [composing, setComposing] = useState(kept);
  const [focusEditor, setFocusEditor] = useState(false);
  return (
    <div className="cd-feed">
      {canWrite &&
        (composing ? (
          <Composer
            cardId={detail.card.id}
            submitLabel={t('cd.commentAdd')}
            pendingLabel={t('cd.commentAdding')}
            pending={busy === 'new'}
            autoFocus={focusEditor}
            onCancel={() => setComposing(false)}
            onSubmit={async (body, ids) => {
              const ok = await run('new', () => actions.addComment(body, ids));
              if (ok) setComposing(false);
              return ok;
            }}
          />
        ) : (
          <button
            type="button"
            className="cd-comment-fake"
            aria-label={t('cd.commentLabel')}
            onClick={() => {
              setFocusEditor(true);
              setComposing(true);
            }}>
            {t('cd.commentWrite')}
          </button>
        ))}
      {children}
      {comments.items.length === 0 ? (
        <p className="cd-none">{t('cd.commentsNone')}</p>
      ) : (
        <ul className="cd-comments">
          {comments.items.map(c => (
            <CommentRow key={c.id} comment={c} detail={detail} actions={actions} busy={busy} run={run} />
          ))}
        </ul>
      )}
      {comments.next !== null && (
        <Button variant="secondary" size="sm" pending={busy === 'more'} pendingLabel={t('common.loading')} onClick={() => void run('more', actions.moreComments)}>
          {t('cd.commentMore')}
        </Button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- activity */

/** The activity kind's family picks the sentence (a few keys cover every kind). */
const FAMILY: [prefix: string, key: string][] = [
  ['card.created', 'created'],
  ['card.moved', 'moved'],
  ['card.archived', 'archived'],
  ['card.restored', 'restored'],
  ['card.label', 'label'],
  ['card.member', 'member'],
  ['card.cover', 'cover'],
  ['card.field', 'field'],
  ['field.', 'field'],
  ['card.dependency', 'dependency'],
  ['card.', 'updated'],
  ['checklist.', 'checklist'],
  ['comment.', 'comment'],
  ['attachment.', 'attachment'],
];
const familyOf = (kind: string) => FAMILY.find(([prefix]) => kind.startsWith(prefix))?.[1] ?? 'other';

export function ActivityLog({cardId, open}: {cardId: number; open: boolean}) {
  const t = useT();
  const {formatRelative, formatDateTime} = useI18n();
  const [before, setBefore] = useState('');
  const [older, setOlder] = useState<ActivityT[]>([]);
  const query = useActivity(cardId, open, before);
  // The previous page stays as placeholder while the next loads: keep each row once.
  const rows = [...new Map([...older, ...(query.data?.items ?? [])].map(r => [r.id, r])).values()];
  const next = query.data?.next ?? null;
  return (
    <div className="cd-feed" id="cd-activity">
      {open && (
        <>
          {query.isError && (
            <p className="field-error" role="alert">
              {t('states.loadError')}
            </p>
          )}
          {query.data && rows.length === 0 && <p className="cd-none">{t('cd.activityNone')}</p>}
          <ul className="cd-activity">
            {rows.map(r => (
              <li key={r.id}>
                <Avatar name={r.actorName ?? '?'} size="sm" />
                <span className="cd-activity-text">{t(`cd.act.${familyOf(r.kind)}` as 'cd.act.other', {name: r.actorName ?? t('cd.deletedUser')})}</span>
                <time dateTime={r.createdAt} title={formatDateTime(r.createdAt)}>
                  {formatRelative(r.createdAt)}
                </time>
              </li>
            ))}
          </ul>
          {next && (
            <Button
              size="sm"
              variant="secondary"
              pending={query.isFetching}
              pendingLabel={t('common.loading')}
              onClick={() => {
                setOlder(rows);
                setBefore(next);
              }}>
              {t('cd.activityMore')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
