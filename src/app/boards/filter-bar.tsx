import {useCallback, useEffect, useId, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {DatePicker} from '../../portal/ui/popover';
import {Button, Icon, IconButton, Select, Switch} from '../../portal/ui';
import {useMe} from '../../portal/shared';
import {activeCount, type BoardFilter, cleanFilter, DUE_OPTIONS, filterStorageKey, PRIORITY_OPTIONS} from './filter-logic';
import {isEmptyFilter, SavedFiltersMenu} from './saved-filters';
import {isMyCards, toggleMyCards} from './saved-filter-groups';
import './filter-bar.css';

/** The unsaved filter, per board per user, kept in sessionStorage (blocked storage: it lasts until the page closes). */
export function useBoardFilter(userId: number | null, boardId: number): [BoardFilter, (next: BoardFilter) => void] {
  const key = filterStorageKey(userId, boardId);
  const read = (): BoardFilter => {
    try {
      const raw = window.sessionStorage.getItem(key);
      return raw ? cleanFilter(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  };
  const [filter, setFilter] = useState<BoardFilter>(read);
  useEffect(() => setFilter(read()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback(
    (next: BoardFilter) => {
      const clean = cleanFilter(next);
      setFilter(clean);
      try {
        if (isEmptyFilter(clean)) window.sessionStorage.removeItem(key);
        else window.sessionStorage.setItem(key, JSON.stringify(clean));
      } catch {
        /* storage blocked */
      }
    },
    [key]
  );
  return [filter, update];
}

/** "Collapse lists with no matching cards": a per-board view choice, kept for the tab (blocked storage: until the page closes). */
export function useCollapseEmpty(boardId: number): [boolean, (on: boolean) => void] {
  const key = `lanefold.filterCollapse.${boardId}`;
  const read = () => {
    try {
      return window.sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  };
  const [on, setOn] = useState(read);
  useEffect(() => setOn(read()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback(
    (next: boolean) => {
      setOn(next);
      try {
        if (next) window.sessionStorage.setItem(key, '1');
        else window.sessionStorage.removeItem(key);
      } catch {
        /* storage blocked */
      }
    },
    [key]
  );
  return [on, update];
}

type Option = {id: number; name: string; colorHex?: string};

const toggleIn = <T,>(list: T[] | undefined, item: T): T[] => ((list ?? []).includes(item) ? (list ?? []).filter(x => x !== item) : [...(list ?? []), item].slice(0, 20));

function Check({label, checked, onChange, children}: {label: string; checked: boolean; onChange: () => void; children?: React.ReactNode}) {
  return (
    <label className="lf-fp-opt">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {children ?? <span>{label}</span>}
    </label>
  );
}

/**
 * The board's filter: a "Filter" button (count badge, "Clear all", saved filters) that opens a side panel with
 * Keyword, Members, Card status, Due date, Labels, Priority, "Collapse lists with no matching cards" and
 * "Any match / All match". Esc or the close button closes it and gives the focus back. The result count is announced politely.
 */
export function FilterBar({
  boardId,
  filter,
  onChange,
  labels,
  members,
  canSave,
  collapseEmpty,
  onCollapseEmpty,
  shown,
  total,
}: {
  boardId: number;
  filter: BoardFilter;
  onChange: (next: BoardFilter) => void;
  labels: Option[];
  members: Option[];
  canSave: boolean;
  collapseEmpty: boolean;
  onCollapseEmpty: (on: boolean) => void;
  shown: number;
  total: number;
}) {
  const t = useT();
  const {locale, firstDayOfWeek} = useI18n();
  const meId = useMe().data?.viewer.id ?? null;
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(filter.text ?? '');
  const trigger = useRef<HTMLButtonElement>(null);
  const keyword = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({filter, onChange});
  latest.current = {filter, onChange};
  // An outside change (saved filter applied, cleared, board switched) replaces what is typed.
  useEffect(() => setText(filter.text ?? ''), [filter.text]);
  useEffect(() => {
    if (text.trim() === (latest.current.filter.text ?? '').trim()) return;
    const timer = window.setTimeout(() => latest.current.onChange({...latest.current.filter, text: text.trim() || undefined}), 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (open) keyword.current?.focus();
  }, [open]);
  // A dropdown: a press outside the filter bar closes it (focus stays where the press landed).
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const count = activeCount(filter) + (text.trim() && !filter.text?.trim() ? 1 : 0);
  const set = (patch: BoardFilter) => onChange({...filter, ...patch});
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const clear = () => {
    setText('');
    onChange({});
  };
  const announce = count > 0 ? t('filters.result', {shown, total}) : '';
  const status = filter.status;
  // "Custom dates" stays ticked while no date is picked yet; a range set from outside (saved filter) ticks it.
  const hasRange = !!(filter.dueFrom || filter.dueTo);
  const [customDue, setCustomDue] = useState(hasRange);
  useEffect(() => {
    if (hasRange) setCustomDue(true);
  }, [hasRange]);

  return (
    <div ref={root} className="lf-fb" role="search" aria-label={t('filters.label')}>
      <Button ref={trigger} variant="secondary" size="sm" icon="filter" aria-expanded={open} aria-controls={panelId} onClick={() => (open ? close() : setOpen(true))}>
        {t('filters.title')}
        {count > 0 && <span className="lf-fb-count">{count}</span>}
      </Button>
      {count > 0 && (
        <Button variant="ghost" size="sm" icon="x" onClick={clear}>
          {t('filters.clearAll')}
        </Button>
      )}
      <SavedFiltersMenu boardId={boardId} current={filter} canSave={canSave} onApply={f => onChange(cleanFilter(f))} />
      <p className="lf-fb-result" role="status" aria-live="polite">
        {announce}
      </p>
      {open && (
        <aside id={panelId} className="lf-fp" role="complementary" aria-label={t('filters.title')} onKeyDown={e => e.key === 'Escape' && (e.stopPropagation(), close())}>
          <header className="lf-fp-head">
            <h2>{t('filters.title')}</h2>
            <IconButton icon="x" label={t('common.close')} onClick={close} />
          </header>
          <div className="lf-fp-body">
            <section className="lf-fp-sec">
              <label className="lf-fp-h" htmlFor={`${panelId}-kw`}>
                {t('filters.keyword')}
              </label>
              <div className="lf-fb-search">
                <Icon name="search" size={16} />
                <input id={`${panelId}-kw`} ref={keyword} className="input" type="search" value={text} maxLength={80} placeholder={t('filters.keywordPlaceholder')} autoComplete="off" onChange={e => setText(e.target.value)} />
              </div>
              <p className="lf-fp-hint">{t('filters.keywordHint')}</p>
            </section>

            <fieldset className="lf-fp-sec">
              <legend className="lf-fp-h">{t('filters.members')}</legend>
              <Check label={t('filters.noMembers')} checked={!!filter.noMembers} onChange={() => set({noMembers: !filter.noMembers})} />
              {meId !== null && <Check label={t('filters.assignedToMe')} checked={!!filter.memberIds?.includes(meId)} onChange={() => set({memberIds: toggleIn(filter.memberIds, meId)})} />}
              {members.filter(m => m.id !== meId).map(m => (
                <Check key={m.id} label={m.name} checked={!!filter.memberIds?.includes(m.id)} onChange={() => set({memberIds: toggleIn(filter.memberIds, m.id)})} />
              ))}
            </fieldset>

            <fieldset className="lf-fp-sec">
              <legend className="lf-fp-h">{t('filters.status')}</legend>
              <Check label={t('filters.status.complete')} checked={status === 'complete'} onChange={() => set({status: status === 'complete' ? undefined : 'complete'})} />
              <Check label={t('filters.status.incomplete')} checked={status === 'incomplete'} onChange={() => set({status: status === 'incomplete' ? undefined : 'incomplete'})} />
            </fieldset>

            <fieldset className="lf-fp-sec">
              <legend className="lf-fp-h">{t('filters.due')}</legend>
              {DUE_OPTIONS.map(d => (
                <Check key={d} label={t(`filters.due.${d}` as 'filters.due.none')} checked={!!filter.dues?.includes(d)} onChange={() => set({dues: toggleIn(filter.dues, d)})} />
              ))}
              <Check
                label={t('filters.due.custom')}
                checked={customDue}
                onChange={() => {
                  if (customDue) set({dueFrom: undefined, dueTo: undefined});
                  setCustomDue(!customDue);
                }}
              />
              {customDue && (
                <div className="lf-fp-range">
                  <div className="lf-fp-range-field">
                    <label className="lf-fp-range-label" htmlFor={`${panelId}-due-from`}>
                      {t('filters.due.from')}
                    </label>
                    <DatePicker id={`${panelId}-due-from`} value={filter.dueFrom ?? ''} label={t('filters.due.from')} clearable max={filter.dueTo} locale={locale} firstDayOfWeek={firstDayOfWeek as 0} placeholder={t('filters.due.anyDate')} onChange={v => set({dueFrom: v || undefined})} />
                  </div>
                  <div className="lf-fp-range-field">
                    <label className="lf-fp-range-label" htmlFor={`${panelId}-due-to`}>
                      {t('filters.due.to')}
                    </label>
                    <DatePicker id={`${panelId}-due-to`} value={filter.dueTo ?? ''} label={t('filters.due.to')} clearable min={filter.dueFrom} locale={locale} firstDayOfWeek={firstDayOfWeek as 0} placeholder={t('filters.due.anyDate')} onChange={v => set({dueTo: v || undefined})} />
                  </div>
                </div>
              )}
            </fieldset>

            <fieldset className="lf-fp-sec">
              <legend className="lf-fp-h">{t('filters.labels')}</legend>
              <Check label={t('filters.noLabels')} checked={!!filter.noLabels} onChange={() => set({noLabels: !filter.noLabels})} />
              {labels.length === 0 && <p className="lf-fb-none">{t('filters.noOptions')}</p>}
              {labels.map(l => (
                <Check key={l.id} label={l.name} checked={!!filter.labelIds?.includes(l.id)} onChange={() => set({labelIds: toggleIn(filter.labelIds, l.id)})}>
                  <span className="lf-fp-label" data-color={l.colorHex} ref={n => n?.style.setProperty('--label', l.colorHex ?? 'transparent')}>
                    {l.name}
                  </span>
                </Check>
              ))}
            </fieldset>

            <section className="lf-fp-sec">
              <label className="lf-fp-h" htmlFor={`${panelId}-pr`}>
                {t('filters.priority')}
              </label>
              <Select
                id={`${panelId}-pr`}
                value={filter.priority ?? ''}
                onChange={e => set({priority: (e.target.value || undefined) as BoardFilter['priority']})}
                options={[{value: '', label: t('filters.priorityAny')}, ...PRIORITY_OPTIONS.map(p => ({value: p, label: t(`filters.priority.${p}` as 'filters.priority.low')}))]}
              />
            </section>
          </div>
          <footer className="lf-fp-foot">
            <Switch label={t('filters.collapseEmpty')} checked={collapseEmpty} onChange={onCollapseEmpty} />
            <Select
              aria-label={t('filters.matchLabel')}
              value={filter.match ?? 'any'}
              onChange={e => set({match: e.target.value === 'all' ? 'all' : undefined})}
              options={[
                {value: 'any', label: t('filters.matchAny')},
                {value: 'all', label: t('filters.matchAll')},
              ]}
            />
          </footer>
        </aside>
      )}
    </div>
  );
}
