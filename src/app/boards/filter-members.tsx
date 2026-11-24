import {useEffect, useId, useRef, useState} from 'react';

import {useT} from '../../i18n';
import {Avatar, Icon} from '../../portal/ui';
import {fold} from './filter-logic';

type Person = {id: number; name: string};

/**
 * The filter panel's "Select members": a type-to-search combobox whose list has a checkbox, an avatar, the name and
 * how many loaded cards each person is on. Picks stay open for more; Esc or a click outside closes the list only.
 * Keyboard: ↓/↑ move, Enter or Space ticks, Esc closes.
 */
export function MemberSelect({
  people,
  selected,
  counts,
  onToggle,
}: {
  people: Person[];
  selected: number[];
  counts: Map<number, number> | null;
  onToggle: (id: number) => void;
}) {
  const t = useT();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const q = fold(query.trim());
  const shown = q ? people.filter(p => fold(p.name).includes(q)) : people;
  const current = shown.length ? Math.min(active, shown.length - 1) : 0;
  const picked = people.filter(p => selected.includes(p.id));
  const summary = picked.length === 0 ? '' : picked.length <= 2 ? picked.map(p => p.name).join(', ') : t('filters.membersPicked', {n: picked.length});

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Keeps the highlighted row in view while moving with the arrows.
  useEffect(() => {
    if (open) document.getElementById(`${id}-o${current}`)?.scrollIntoView({block: 'nearest'});
  }, [open, current, id]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={root} className="lf-ms">
      <div className="lf-ms-field" data-open={open ? '' : undefined}>
        <input
          ref={input}
          className="lf-ms-input"
          role="combobox"
          aria-label={t('filters.selectMembers')}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && shown.length ? `${id}-o${current}` : undefined}
          placeholder={summary || t('filters.selectMembers')}
          data-picked={summary ? '' : undefined}
          value={query}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={event => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!open) return setOpen(true);
              if (shown.length) setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
            } else if (event.key === 'Enter' || (event.key === ' ' && open && query === '')) {
              const person = shown[current];
              if (open && person) {
                event.preventDefault();
                onToggle(person.id);
              }
            } else if (event.key === 'Escape' && open) {
              event.preventDefault();
              event.stopPropagation(); // closes the list, not the filter panel
              close();
            }
          }}
        />
        <button type="button" className="lf-ms-caret" tabIndex={-1} aria-hidden="true" onClick={() => (open ? close() : input.current?.focus())}>
          <Icon name="chevron-down" size={16} />
        </button>
      </div>
      {open && (
        <ul id={`${id}-list`} className="lf-ms-list" role="listbox" aria-multiselectable="true" aria-label={t('filters.selectMembers')}>
          {shown.length === 0 && <li className="lf-ms-none">{t('filters.noMembersMatch')}</li>}
          {shown.map((person, index) => {
            const on = selected.includes(person.id);
            return (
              <li
                key={person.id}
                id={`${id}-o${index}`}
                role="option"
                aria-selected={on}
                data-active={index === current ? '' : undefined}
                onPointerDown={event => event.preventDefault() /* the focus stays in the search box */}
                onClick={() => {
                  setActive(index);
                  onToggle(person.id);
                }}>
                <span className="lf-ms-check" data-on={on ? '' : undefined} aria-hidden="true">
                  {on && <Icon name="check" size={12} />}
                </span>
                <Avatar name={person.name} size="sm" />
                <span className="lf-ms-name">{person.name}</span>
                {counts && <span className="lf-fp-count" data-zero={(counts.get(person.id) ?? 0) === 0 ? '' : undefined}>{counts.get(person.id) ?? 0}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
