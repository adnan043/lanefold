import {type KeyboardEvent, useEffect, useId, useMemo, useRef, useState} from 'react';

import {defaultActive, groupResults} from './command-order';
import {bestScore} from './fuzzy';
import {Icon, type IconName} from './icon';

export type CommandItem = {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  /** Section heading; items keep their first-seen group order. */
  group?: string;
  /** Extra words that match but are not shown. */
  keywords?: string[];
  /** Shown whatever the query is, after the matches (results that came from a server search). */
  always?: boolean;
  /** A last-resort action (e.g. "Create ..."): listed after everything else and never the Enter default while other results exist. */
  fallback?: boolean;
  onSelect: () => void;
};

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
  placeholder?: string;
  /** Accessible name of the dialog. */
  label?: string;
  emptyText?: string;
  /** Called with the text as it changes (and with '' when the palette opens): drives a server search. */
  onQueryChange?: (query: string) => void;
  /** True while a server search for the typed text is pending: Enter does not run the default row yet. */
  busy?: boolean;
};

/** Filters and ranks items for a query (exported for tests and custom UIs). */
export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  if (!query.trim()) return items;
  const always = items.filter(item => item.always);
  const matched = items
    .filter(item => !item.always)
    .map((item, order) => ({item, order, score: bestScore(query, [item.label, item.hint, ...(item.keywords ?? [])])}))
    .filter((r): r is {item: CommandItem; order: number; score: number} => r.score !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(r => r.item);
  return [...matched, ...always];
}

/**
 * Cmd/Ctrl+K style palette in a native `<dialog>` (focus trapped and
 * returned, Esc closes). Controlled: the screen owns `open` and the shortcut
 * (`useCommandShortcut`). Type to filter (fuzzy), arrows move, Enter runs,
 * Home / End jump. Combobox + listbox semantics with `aria-activedescendant`
 * so focus stays in the input.
 */
export function CommandPalette({open, onClose, items, placeholder = 'Type a command or search…', label = 'Command palette', emptyText = 'No results.', onQueryChange, busy = false}: CommandPaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [moved, setMoved] = useState<number | null>(null);
  const id = useId();

  const results = useMemo(() => {
    // Group in first-seen order (ungrouped first-seen too), keeping rank inside a group; fallbacks last.
    return groupResults(filterCommands(items, query));
  }, [items, query]);
  const active = moved !== null && moved < results.length ? moved : defaultActive(results, query);
  const setActive = (next: number) => setMoved(next);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    if (open) {
      setQuery('');
      setMoved(null);
    }
  }, [open]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', cancel);
    return () => el.removeEventListener('cancel', cancel);
  }, [onClose]);

  useEffect(() => setMoved(null), [query]);
  const notify = useRef(onQueryChange);
  notify.current = onQueryChange;
  useEffect(() => notify.current?.(open ? query : ''), [query, open]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest'});
  }, [active, results]);

  const run = (item: CommandItem | undefined) => {
    if (!item) return;
    onClose();
    item.onSelect();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const last = results.length - 1;
    if (event.key === 'ArrowDown') setActive(active >= last ? 0 : active + 1);
    else if (event.key === 'ArrowUp') setActive(active <= 0 ? last : active - 1);
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(Math.max(0, last));
    else if (event.key === 'Enter') {
      if (!(busy && moved === null)) run(results[active]);
    }
    else return;
    event.preventDefault();
  };

  let lastGroup: string | undefined;
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label={label}
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}>
      {open && (
        <div className="palette-box">
          <div className="palette-search">
            <Icon name="search" size={18} />
            <input
              className="palette-input"
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={results[active] ? `${id}-${results[active].id}` : undefined}
              aria-label={label}
              placeholder={placeholder}
              value={query}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <kbd className="palette-kbd">Esc</kbd>
          </div>
          <div ref={list} id={`${id}-list`} role="listbox" aria-label={label} className="palette-list">
            {results.map((item, i) => {
              const heading = item.group !== lastGroup && item.group ? item.group : null;
              lastGroup = item.group;
              return (
                <div key={item.id} role="presentation">
                  {heading && (
                    <div className="palette-group" role="presentation">
                      {heading}
                    </div>
                  )}
                  <div
                    id={`${id}-${item.id}`}
                    role="option"
                    aria-selected={i === active}
                    className="palette-item"
                    onPointerMove={() => i !== active && setActive(i)}
                    onClick={() => run(item)}>
                    {item.icon && <Icon name={item.icon} size={18} />}
                    <span className="palette-label">{item.label}</span>
                    {item.hint && <span className="palette-hint">{item.hint}</span>}
                  </div>
                </div>
              );
            })}
            {results.length === 0 && (
              <p className="palette-empty" role="status">
                {emptyText}
              </p>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}

/** Calls `toggle` on Cmd/Ctrl+K (and stops the browser's own handler). */
export function useCommandShortcut(toggle: () => void) {
  const ref = useRef(toggle);
  ref.current = toggle;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ref.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
