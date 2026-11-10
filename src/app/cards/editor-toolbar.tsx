import {type RefObject, useRef, useState} from 'react';

import {useT} from '../../i18n';
import {Button, Icon, IconButton, type IconName, Menu} from '../../portal/ui';
import {Popover} from '../../portal/ui/popover';


type Edit = {before: string; after?: string; placeholder?: string; lines?: 'bullet' | 'number' | string};

/** What the help button lists: markdown syntax is the same in every language. */
const SYNTAX = ['**bold**', '_italic_', '`code`', '## heading', '> quote', '- list', '1. list', '[text](https://…)'];

/**
 * The formatting bar above a comment or the description: it edits the markdown in the textarea (the comment is still stored and shown
 * as markdown), so it needs no editor library. Bold, italic, lists, headings, quote, code, link, attach, help.
 */
export function EditorToolbar({area, text, setText, disabled, onMention}: {area: RefObject<HTMLTextAreaElement | null>; text: string; setText: (value: string) => void; disabled: boolean; onMention?: () => void}) {
  const t = useT();
  const [help, setHelp] = useState(false);
  const helpAnchor = useRef<HTMLButtonElement>(null);

  const apply = ({before, after = '', placeholder = '', lines}: Edit) => {
    const el = area.current;
    if (!el) return;
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    let next: string;
    let from: number;
    let to: number;
    if (lines) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const block = text.slice(lineStart, end) || placeholder;
      const prefixed = block
        .split('\n')
        .map((line, i) => `${lines === 'bullet' ? '- ' : lines === 'number' ? `${i + 1}. ` : lines}${line}`)
        .join('\n');
      next = text.slice(0, lineStart) + prefixed + text.slice(end);
      from = lineStart;
      to = lineStart + prefixed.length;
    } else {
      const chosen = text.slice(start, end) || placeholder;
      next = text.slice(0, start) + before + chosen + after + text.slice(end);
      from = start + before.length;
      to = from + chosen.length;
    }
    setText(next);
    window.setTimeout(() => {
      el.focus();
      el.setSelectionRange(from, to);
    }, 0);
  };

  return (
    <div className="cd-editor-bar" role="toolbar" aria-label={t('cd.fmtText')}>
      <Menu
        label={t('cd.fmtText')}
        disabled={disabled}
        align="start"
        trigger={
          <>
            <Icon name="type" size={16} />
            <Icon name="chevron-down" size={12} />
          </>
        }
        items={[
          {label: t('cd.fmtHeading'), onSelect: () => apply({before: '', lines: '## ', placeholder: t('cd.fmtHeading')})},
          {label: t('cd.fmtQuote'), onSelect: () => apply({before: '', lines: '> ', placeholder: t('cd.fmtQuote')})},
        ]}
      />
      <span className="cd-editor-sep" aria-hidden="true" />
      <IconButton icon="bold" size="sm" variant="ghost" label={t('cd.fmtBold')} disabled={disabled} onClick={() => apply({before: '**', after: '**', placeholder: t('cd.fmtBold')})} />
      <IconButton icon="italic" size="sm" variant="ghost" label={t('cd.fmtItalic')} disabled={disabled} onClick={() => apply({before: '_', after: '_', placeholder: t('cd.fmtItalic')})} />
      <span className="cd-editor-sep" aria-hidden="true" />
      <Menu
        label={t('cd.fmtList')}
        disabled={disabled}
        align="start"
        trigger={
          <>
            <Icon name="list" size={16} />
            <Icon name="chevron-down" size={12} />
          </>
        }
        items={[
          {label: t('cd.fmtBullets'), icon: 'list', onSelect: () => apply({before: '', lines: 'bullet', placeholder: t('cd.fmtBullets')})},
          {label: t('cd.fmtNumbered'), icon: 'list-ordered', onSelect: () => apply({before: '', lines: 'number', placeholder: t('cd.fmtNumbered')})},
        ]}
      />
      <span className="cd-editor-sep" aria-hidden="true" />
      <InsertMenu
        disabled={disabled}
        onLink={() => apply({before: '[', after: '](https://)', placeholder: t('cd.fmtLink')})}
        onImage={() => document.querySelector<HTMLElement>('.cd-panel #cd-attachments-add')?.click()}
        onAttachLink={() => document.querySelector<HTMLElement>('.cd-panel #cd-attachments-link')?.click()}
        onMention={onMention}
        onEmoji={emoji => apply({before: emoji})}
        onCode={() => apply({before: '```\n', after: '\n```', placeholder: t('cd.fmtCode')})}
        onQuote={() => apply({before: '', lines: '> ', placeholder: t('cd.fmtQuote')})}
      />
      <span className="cd-spacer" />
      <IconButton
        icon="paperclip"
        size="sm"
        variant="ghost"
        label={t('cd.fmtAttach')}
        disabled={disabled}
        onClick={() => document.querySelector<HTMLElement>('.cd-panel #cd-attachments-add')?.click()}
      />
      <IconButton ref={helpAnchor} icon="help-circle" size="sm" variant="ghost" label={t('cd.fmtHelp')} aria-haspopup="dialog" aria-expanded={help} onClick={() => setHelp(o => !o)} />
      <Popover open={help} onClose={() => setHelp(false)} anchor={helpAnchor} label={t('cd.fmtHelp')} align="end" className="cd-pop">
        <ul className="cd-syntax">
          {SYNTAX.map(line => (
            <li key={line}>
              <code>{line}</code>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}

const EMOJI = ['😀', '😂', '🙂', '😍', '🤔', '😅', '😢', '😡', '👍', '👎', '👏', '🙏', '🎉', '🔥', '✅', '❌', '⚠️', '💡', '🚀', '❤️', '👀', '🐛', '⭐', '📌'];

type Row = {id: string; icon: IconName | null; title: string; desc: string; hint?: string; run: () => void; keepOpen?: boolean};

/** The "+" button: a searchable list of things to insert (link, image, mention, emoji, code, quote), like Trello's. */
function InsertMenu({
  disabled,
  onLink,
  onImage,
  onAttachLink,
  onMention,
  onEmoji,
  onCode,
  onQuote,
}: {
  disabled: boolean;
  onLink: () => void;
  onImage: () => void;
  onAttachLink: () => void;
  /** Absent (the description): no Mention row. */
  onMention?: () => void;
  onEmoji: (emoji: string) => void;
  onCode: () => void;
  onQuote: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'list' | 'emoji'>('list');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setView('list');
    setQuery('');
    setActive(0);
  };
  const rows: Row[] = [
    {id: 'link', icon: 'link', title: t('cd.fmtLink'), desc: t('cd.insLinkDesc'), run: onLink},
    {id: 'image', icon: 'image', title: t('cd.insImage'), desc: t('cd.insImageDesc'), run: onImage},
    {id: 'attach-link', icon: 'paperclip', title: t('cd.attachLink'), desc: '', run: onAttachLink},
    ...(onMention ? [{id: 'mention', icon: 'user-plus' as const, title: t('cd.mention'), desc: t('cd.insMentionDesc'), hint: '@', run: onMention}] : []),
    {id: 'emoji', icon: 'smile', title: t('cd.insEmoji'), desc: t('cd.insEmojiDesc'), hint: ':', run: () => setView('emoji'), keepOpen: true},
    {id: 'code', icon: 'command', title: t('cd.insCode'), desc: t('cd.insCodeDesc'), hint: '```', run: onCode},
    {id: 'quote', icon: 'message', title: t('cd.fmtQuote'), desc: t('cd.insQuoteDesc'), hint: '>', run: onQuote},
  ];
  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter(r => `${r.title} ${r.desc}`.toLowerCase().includes(needle)) : rows;
  const pick = (row: Row) => {
    row.run();
    if (!row.keepOpen) close();
  };
  return (
    <>
      <IconButton
        ref={anchor}
        icon="plus"
        size="sm"
        variant="ghost"
        label={t('cd.fmtInsert')}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      />
      <Popover open={open} onClose={close} anchor={anchor} label={t('cd.fmtInsert')} className="cd-pop cd-insert">
        {view === 'emoji' ? (
          <div className="cd-emoji">
            <Button size="sm" variant="ghost" icon="arrow-left" onClick={() => setView('list')}>
              {t('common.back')}
            </Button>
            <div className="cd-emoji-grid">
              {EMOJI.map(emoji => (
                <button
                  key={emoji}
                  type="button"
                  className="cd-emoji-pick"
                  aria-label={emoji}
                  onClick={() => {
                    onEmoji(emoji);
                    close();
                  }}>
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div className="cd-insert-search">
              <Icon name="search" size={16} />
              <input
                type="search"
                role="combobox"
                aria-expanded="true"
                aria-controls="cd-insert-list"
                aria-activedescendant={shown[active] ? `cd-ins-${shown[active]!.id}` : undefined}
                aria-label={t('cd.insSearch')}
                placeholder={t('cd.insSearch')}
                value={query}
                autoComplete="off"
                onChange={event => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActive(i => (shown.length ? (i + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length : 0));
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    const row = shown[active];
                    if (row) pick(row);
                  }
                }}
              />
            </div>
            <ul id="cd-insert-list" className="cd-insert-list" role="listbox" aria-label={t('cd.fmtInsert')}>
              {shown.map((row, i) => (
                <li key={row.id} id={`cd-ins-${row.id}`} role="option" aria-selected={i === active}>
                  <button type="button" tabIndex={-1} className="cd-insert-row" data-active={i === active ? '' : undefined} onMouseEnter={() => setActive(i)} onClick={() => pick(row)}>
                    <span className="cd-insert-tile">{row.icon && <Icon name={row.icon} size={18} />}</span>
                    <span className="cd-insert-text">
                      <strong>{row.title}</strong>
                      {row.desc && <span>{row.desc}</span>}
                    </span>
                    {row.hint && <kbd dir="ltr">{row.hint}</kbd>}
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="cd-none cd-insert-none">{t('cd.insNone')}</li>}
            </ul>
          </>
        )}
      </Popover>
    </>
  );
}
