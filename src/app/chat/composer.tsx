import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';

import {QUICK_EMOJI} from '../emoji';
import {Popover} from '../../portal/ui/popover';

import {useI18n, useT} from '../../i18n';
import {CHAT_FILE_ACCEPT, CHAT_FILE_MAX_BYTES, CHAT_FILE_TYPES, CHAT_FILES_PER_MESSAGE, type ChatFileT, chatFileType} from '../../lib/chat-files';
import {bytesLabel} from '../cards/parts';
import {type DraftKind} from '../draft-store';
import {useDraft} from '../use-draft';
import {Avatar, Button, Icon, IconButton} from '../../portal/ui';
import {type CardHitT, cardSearchQuery, memberSearchQuery, removeUnsentFile, uploadChatFile, useDebounced} from './api';
import {ALL_TOKEN} from '../../lib/mention-all';
import {cardTagAt, insertMention, matchPeople, MAX_BODY, MAX_CARDS, mentionAt, mentionedIds, type PersonRef, removeCardTag} from './mentions';

/** The `@all` row of the list: not a person (id 0 is never a user, so it never travels as a mention id). */
const ALL_OPTION: PersonRef = {userId: 0, name: ALL_TOKEN};

/** A file in the composer's tray: uploading, ready to send (with its server row), or failed (with the reason). */
type TrayFile = {key: number; name: string; size: number; image: boolean; status: 'uploading' | 'ready' | 'failed'; file?: ChatFileT; error?: string; abort: AbortController};
let trayKey = 0;

type Props = {
  /** The directory already loaded (resolves @names when the text is sent). */
  people: readonly PersonRef[];
  /** With it the `@` list comes from the members search (names only, 20 at most). */
  workspaceId?: number;
  /** With it files can be attached (they upload into this conversation's workspace before the message is sent). */
  conversationId?: number;
  /** Resolves when the message is on its way (the composer clears at once: a failure keeps the text in the pending bubble). */
  onSend: (body: string, mentions: number[], cardIds: number[], files: ChatFileT[]) => unknown;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  /** The send button's text (default "Send"; a thread says "Reply"). */
  submitLabel?: string;
  /** Keeps the unsent text across a forced sign-in: `chat` + conversation id, or `reply` + parent message id. */
  draft?: {kind: Extract<DraftKind, 'chat' | 'reply'>; id: number};
};

/**
 * The message box: Enter sends, Shift+Enter is a new line, `@` opens the people list (arrows, Enter or Tab to
 * pick, Esc closes). Same 4000-character limit as the server; the over-limit message says how many to remove.
 */
export function Composer({people, workspaceId, conversationId, onSend, label, placeholder, autoFocus, submitLabel, draft}: Props) {
  const t = useT();
  const {errorMessage, formatNumber} = useI18n();
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  useDraft(draft?.kind ?? 'chat', draft?.id ?? 0, text, setText, '', !!draft);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [tried, setTried] = useState(false);

  const mention = mentionAt(text, caret);
  const [chosen, setChosen] = useState<PersonRef[]>([]);
  const query = useDebounced(mention && !dismissed ? mention.query.trim() : null);
  const search = useQuery({...memberSearchQuery(workspaceId ?? 0, query ?? ''), enabled: !!workspaceId && query !== null, placeholderData: keepPreviousData});
  const hits: PersonRef[] = search.data ? search.data.filter(p => !p.isMe) : mention ? matchPeople(people, mention.query) : [];
  const tag = mention ? null : cardTagAt(text, caret);
  const [cards, setCards] = useState<CardHitT[]>([]);
  const cardQuery = useDebounced(tag && !dismissed && workspaceId && cards.length < MAX_CARDS ? tag.query.trim() : null);
  const cardSearch = useQuery({...cardSearchQuery(workspaceId ?? 0, cardQuery ?? ''), enabled: !!workspaceId && cardQuery !== null && cardQuery.length >= 2, placeholderData: keepPreviousData});
  const cardHits = tag && !dismissed && cardQuery !== null && cardQuery.length >= 2 ? (cardSearch.data ?? []).filter(c => !cards.some(x => x.id === c.id)).slice(0, 6) : [];
  // `@all` (everyone in this conversation) leads the list while what is typed could still be "all".
  const offerAll = !!mention && ALL_TOKEN.startsWith(mention.query.toLowerCase());
  const options: PersonRef[] = mention && !dismissed ? [...(offerAll ? [ALL_OPTION] : []), ...hits].slice(0, 6) : [];
  const listOpen = options.length > 0 || cardHits.length > 0;
  const count = cardHits.length > 0 ? cardHits.length : options.length;
  // The results can shrink under a highlight that was moved first (a slower search answers): keep it on a row.
  const current = count > 0 ? Math.min(active, count - 1) : 0;
  const over = text.trim().length - MAX_BODY;

  // Files: they upload as soon as they are picked, and go with the next message once ready.
  const [tray, setTray] = useState<TrayFile[]>([]);
  const [fileError, setFileError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const trayRef = useRef(tray);
  trayRef.current = tray;
  const readyFiles = tray.filter(f => f.status === 'ready' && f.file).map(f => f.file!);
  const uploading = tray.some(f => f.status === 'uploading');
  const patchTray = (key: number, change: Partial<TrayFile>) => setTray(list => list.map(f => (f.key === key ? {...f, ...change} : f)));
  const addFiles = (picked: File[]) => {
    if (!conversationId || picked.length === 0) return;
    setFileError('');
    const room = CHAT_FILES_PER_MESSAGE - trayRef.current.filter(f => f.status !== 'failed').length;
    if (picked.length > room) setFileError(t('chat.tooManyFiles', {n: CHAT_FILES_PER_MESSAGE}));
    for (const file of picked.slice(0, Math.max(0, room))) {
      // The same rules as the server, checked first for a quick answer (the server checks again).
      if (!CHAT_FILE_TYPES.includes(chatFileType(file.name, file.type))) {
        setFileError(t('chat.fileTypeRefused', {name: file.name}));
        continue;
      }
      if (file.size < 1 || file.size > CHAT_FILE_MAX_BYTES) {
        setFileError(t('chat.fileTooBig', {name: file.name, max: '100 MB'}));
        continue;
      }
      const key = ++trayKey;
      const abort = new AbortController();
      const image = chatFileType(file.name, file.type).startsWith('image/');
      setTray(list => [...list, {key, name: file.name, size: file.size, image, status: 'uploading', abort}]);
      uploadChatFile(conversationId, file, abort.signal).then(
        done => {
          // Taken out while it uploaded: drop the file it became.
          if (abort.signal.aborted || !trayRef.current.some(f => f.key === key)) return void removeUnsentFile(done.id);
          patchTray(key, {status: 'ready', file: done});
        },
        error => {
          if (abort.signal.aborted) return;
          patchTray(key, {status: 'failed', error: errorMessage(error)});
        }
      );
    }
  };
  const removeFile = (key: number) => {
    const f = trayRef.current.find(x => x.key === key);
    if (!f) return;
    f.abort.abort();
    if (f.status === 'ready' && f.file) void removeUnsentFile(f.file.id);
    setTray(list => list.filter(x => x.key !== key));
    window.requestAnimationFrame(() => area.current?.focus());
  };
  // Leaving the conversation with files not sent: stop the uploads and take the files out.
  useEffect(
    () => () => {
      for (const f of trayRef.current) {
        f.abort.abort();
        if (f.status === 'ready' && f.file) void removeUnsentFile(f.file.id);
      }
    },
    []
  );
  const listId = cardHits.length > 0 ? `${id}-cardlist` : `${id}-people`;

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [autoFocus]);
  useEffect(() => setActive(0), [mention?.query, tag?.query]);

  const pick = (person: PersonRef) => {
    if (!mention || !person.name) return;
    if (person.userId !== ALL_OPTION.userId) setChosen(list => (list.some(p => p.userId === person.userId) ? list : [...list, person].slice(-20)));
    const next = insertMention(text, caret, mention.start, person.name);
    setText(next.text);
    setCaret(next.caret);
    // `@Ann Lee ` still reads as an `@` query: close the list so the next Enter sends (typing opens it again).
    setDismissed(true);
    window.requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const pickCard = (card: CardHitT) => {
    if (!tag) return;
    setCards(list => (list.some(c => c.id === card.id) ? list : [...list, card].slice(0, MAX_CARDS)));
    const next = removeCardTag(text, caret, tag.start);
    setText(next.text);
    setCaret(next.caret);
    setDismissed(true);
    window.requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  /** Types `token` at the caret (after a space when glued to a word) and puts the caret after it. */
  const typeAtCaret = (token: string, spaced: boolean) => {
    const el = area.current;
    const at = el?.selectionStart ?? text.length;
    const lead = spaced && at > 0 && !/\s/.test(text[at - 1]!) ? ' ' : '';
    const next = text.slice(0, at) + lead + token + text.slice(at);
    const pos = at + lead.length + token.length;
    setText(next);
    setCaret(pos);
    setDismissed(false);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };
  /** The "attach a card" button: types the `#` for the person and opens the same list. */
  const startCardTag = () => typeAtCaret('#', true);
  /** The "mention" button: types the `@` and opens the people list. */
  const startMention = () => typeAtCaret('@', true);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiButton = useRef<HTMLButtonElement>(null);

  const submit = () => {
    setTried(true);
    const body = text.trim();
    if (uploading) return setFileError(t('chat.waitForUploads'));
    if ((!body && readyFiles.length === 0) || over > 0) return;
    void onSend(body, body ? mentionedIds(body, [...chosen, ...people]) : [], cards.map(c => c.id), readyFiles);
    setChosen([]);
    setCards([]);
    setTray([]);
    setFileError('');
    setText('');
    setCaret(0);
    setTried(false);
  };

  const error = over > 0 ? t('chat.tooLong', {n: over}) : fileError || (tried && !text.trim() && readyFiles.length === 0 ? t('chat.writeSomething') : '');

  return (
    <form
      className="chat-composer"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
      onDragOver={event => {
        if (conversationId && event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={event => {
        if (!conversationId || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        addFiles([...event.dataTransfer.files]);
      }}>
      {tray.length > 0 && (
        <ul className="chat-card-chips chat-card-tray chat-file-tray" id={`${id}-files`} aria-label={t('chat.filesToSend')}>
          {tray.map(f => (
            <li key={f.key} className="chat-card-chip chat-file-chip" data-failed={f.status === 'failed' ? '' : undefined} aria-busy={f.status === 'uploading' || undefined}>
              {f.status === 'uploading' ? <span className="spinner" aria-hidden="true" /> : <Icon name={f.status === 'failed' ? 'alert' : f.image ? 'image' : 'file'} size={14} />}
              <span className="chat-card-chip-title" title={f.name}>{f.name}</span>
              <span className="chat-file-chip-meta muted">
                {f.status === 'uploading' ? t('chat.uploadingFile') : f.status === 'failed' ? (f.error ?? t('chat.uploadFailed')) : bytesLabel(f.size, formatNumber)}
              </span>
              <IconButton icon="x" size="sm" label={t('chat.removeFile', {name: f.name})} onClick={() => removeFile(f.key)} />
            </li>
          ))}
        </ul>
      )}
      {cards.length > 0 && (
        <ul className="chat-card-chips chat-card-tray" id={`${id}-cards`} aria-label={t('chat.attachedCards')}>
          {cards.map(card => (
            <li key={card.id} className="chat-card-chip">
              <Icon name="checklist" size={14} />
              <span className="chat-card-chip-title" title={card.title}>{card.title}</span>
              <IconButton icon="x" size="sm" label={t('chat.removeCard', {title: card.title})} onClick={() => setCards(list => list.filter(c => c.id !== card.id))} />
            </li>
          ))}
        </ul>
      )}
      <div className="chat-composer-box" data-invalid={error ? '' : undefined}>
        {listOpen && (
          <p className="visually-hidden" id={`${id}-hint`} role="status">
            {t('chat.suggestionsHint', {n: count})}
          </p>
        )}
        <label className="visually-hidden" htmlFor={`${id}-text`}>
          {label}
        </label>
        <textarea
          id={`${id}-text`}
          ref={area}
          dir="auto"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-controls={listOpen ? listId : undefined}
          aria-describedby={[error ? `${id}-error` : cards.length ? `${id}-cards` : '', tray.length ? `${id}-files` : '', listOpen ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined}
          aria-activedescendant={listOpen ? `${id}-p${current}` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={event => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setDismissed(false);
          }}
          onSelect={event => setCaret(event.currentTarget.selectionStart)}
          onPaste={event => {
            // A pasted screenshot or copied file is attached; pasted text stays text.
            if (!conversationId || event.clipboardData.files.length === 0) return;
            event.preventDefault();
            addFiles([...event.clipboardData.files]);
          }}
          onKeyDown={event => {
            // An input method (Japanese, Chinese, Korean…) is composing: its Enter and arrows are its own.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (listOpen) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                const card = cardHits[current];
                const person = options[current];
                if (cardHits.length > 0 && card) pickCard(card);
                else if (person) pick(person);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat-composer-tools">
          {conversationId !== undefined && (
            <>
              <IconButton icon="paperclip" size="sm" label={t('chat.attachFile')} disabled={tray.filter(f => f.status !== 'failed').length >= CHAT_FILES_PER_MESSAGE} onClick={() => picker.current?.click()} />
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                accept={CHAT_FILE_ACCEPT}
                onChange={event => {
                  addFiles([...(event.target.files ?? [])]);
                  event.target.value = '';
                }}
              />
              <span className="chat-composer-sep" aria-hidden="true" />
            </>
          )}
          <IconButton icon="hash" size="sm" label={t('chat.attachCard')} disabled={cards.length >= MAX_CARDS || !workspaceId} onClick={startCardTag} />
          <span className="chat-composer-sep" aria-hidden="true" />
          <IconButton icon="at-sign" size="sm" label={t('chat.mentionSomeone')} onClick={startMention} />
          <span className="chat-composer-sep" aria-hidden="true" />
          <IconButton ref={emojiButton} icon="smile" size="sm" label={t('chat.insertEmoji')} aria-haspopup="dialog" aria-expanded={emojiOpen} onClick={() => setEmojiOpen(open => !open)} />
          <Popover open={emojiOpen} onClose={() => setEmojiOpen(false)} anchor={emojiButton} label={t('chat.insertEmoji')}>
            <div className="chat-emoji-grid">
              {QUICK_EMOJI.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  className="chat-emoji"
                  aria-label={emoji}
                  onClick={() => {
                    setEmojiOpen(false);
                    typeAtCaret(emoji, false);
                  }}>
                  {emoji}
                </button>
              ))}
            </div>
          </Popover>
          <Button type="submit" size="sm" icon="send" disabled={(!text.trim() && readyFiles.length === 0) || uploading} aria-label={submitLabel ?? t('chat.send')}>
            <span className="chat-send-label">{submitLabel ?? t('chat.send')}</span>
          </Button>
        </div>
        {cardHits.length > 0 && (
          <ul className="chat-mention-list" role="listbox" id={`${id}-cardlist`} aria-label={t('chat.cardList')}>
            {cardHits.map((card, index) => (
              <li
                key={card.id}
                id={`${id}-p${index}`}
                role="option"
                aria-selected={index === current}
                data-active={index === current ? '' : undefined}
                onPointerDown={event => {
                  event.preventDefault();
                  pickCard(card);
                }}>
                <Icon name="checklist" size={14} />
                <span className="chat-card-hit">
                  <span>{card.title}</span>
                  <span className="muted">{card.boardName}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {options.length > 0 && cardHits.length === 0 && (
          <ul className="chat-mention-list" role="listbox" id={`${id}-people`} aria-label={t('chat.mentionList')}>
            {options.map((person, index) => (
              <li
                key={person.userId}
                id={`${id}-p${index}`}
                role="option"
                aria-selected={index === current}
                data-active={index === current ? '' : undefined}
                onPointerDown={event => {
                  event.preventDefault();
                  pick(person);
                }}>
                {person.userId === ALL_OPTION.userId ? (
                  <>
                    <span className="chat-mention-all-icon" aria-hidden="true">
                      <Icon name="users" size={14} />
                    </span>
                    <span className="chat-card-hit">
                      <span>@{ALL_TOKEN}</span>
                      <span className="muted">{t('chat.mentionAll')}</span>
                    </span>
                  </>
                ) : (
                  <>
                    <Avatar name={person.name ?? ''} size="sm" />
                    {person.name}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p className="field-error" id={`${id}-error`} role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      )}
    </form>
  );
}
