import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';

import {useT} from '../../i18n';
import {type DraftKind} from '../draft-store';
import {useDraft} from '../use-draft';
import {Avatar, Button, Icon, IconButton} from '../../portal/ui';
import {type CardHitT, cardSearchQuery, memberSearchQuery, useDebounced} from './api';
import {ALL_TOKEN} from '../../lib/mention-all';
import {cardTagAt, insertMention, matchPeople, MAX_BODY, MAX_CARDS, mentionAt, mentionedIds, type PersonRef, removeCardTag} from './mentions';

/** The `@all` row of the list: not a person (id 0 is never a user, so it never travels as a mention id). */
const ALL_OPTION: PersonRef = {userId: 0, name: ALL_TOKEN};

type Props = {
  /** The directory already loaded (resolves @names when the text is sent). */
  people: readonly PersonRef[];
  /** With it the `@` list comes from the members search (names only, 20 at most). */
  workspaceId?: number;
  /** Resolves when the message is on its way (the composer clears at once: a failure keeps the text in the pending bubble). */
  onSend: (body: string, mentions: number[], cardIds: number[]) => unknown;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  /** Keeps the unsent text across a forced sign-in: `chat` + conversation id, or `reply` + parent message id. */
  draft?: {kind: Extract<DraftKind, 'chat' | 'reply'>; id: number};
};

/**
 * The message box: Enter sends, Shift+Enter is a new line, `@` opens the people list (arrows, Enter or Tab to
 * pick, Esc closes). Same 4000-character limit as the server; the over-limit message says how many to remove.
 */
export function Composer({people, workspaceId, onSend, label, placeholder, autoFocus, draft}: Props) {
  const t = useT();
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
  const over = text.trim().length - MAX_BODY;
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
    window.requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  /** The "attach a card" button: types the `#` for the person and opens the same list. */
  const startCardTag = () => {
    const el = area.current;
    const at = el?.selectionStart ?? text.length;
    const lead = at > 0 && !/\s/.test(text[at - 1]!) ? ' ' : '';
    const next = text.slice(0, at) + lead + '#' + text.slice(at);
    const pos = at + lead.length + 1;
    setText(next);
    setCaret(pos);
    setDismissed(false);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const submit = () => {
    setTried(true);
    const body = text.trim();
    if (!body || over > 0) return;
    void onSend(body, mentionedIds(body, [...chosen, ...people]), cards.map(c => c.id));
    setChosen([]);
    setCards([]);
    setText('');
    setCaret(0);
    setTried(false);
  };

  const error = over > 0 ? t('chat.tooLong', {n: over}) : tried && !text.trim() ? t('chat.writeSomething') : '';

  return (
    <form
      className="chat-composer"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}>
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
          aria-describedby={[error ? `${id}-error` : cards.length ? `${id}-cards` : '', listOpen ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined}
          aria-activedescendant={listOpen ? `${id}-p${active}` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={event => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setDismissed(false);
          }}
          onSelect={event => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={event => {
            if (listOpen) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActive(i => (i + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                if (cardHits.length > 0) pickCard(cardHits[active]!);
                else pick(options[active]!);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <IconButton icon="hash" size="sm" label={t('chat.attachCard')} disabled={cards.length >= MAX_CARDS || !workspaceId} onClick={startCardTag} />
        <Button type="submit" size="sm" icon="arrow-right" disabled={!text.trim()} aria-label={t('chat.send')}>
          <span className="chat-send-label">{t('chat.send')}</span>
        </Button>
        {cardHits.length > 0 && (
          <ul className="chat-mention-list" role="listbox" id={`${id}-cardlist`} aria-label={t('chat.cardList')}>
            {cardHits.map((card, index) => (
              <li
                key={card.id}
                id={`${id}-p${index}`}
                role="option"
                aria-selected={index === active}
                data-active={index === active ? '' : undefined}
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
                aria-selected={index === active}
                data-active={index === active ? '' : undefined}
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
