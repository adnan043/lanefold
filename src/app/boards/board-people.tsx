import {keepPreviousData, queryOptions, useQuery} from '@tanstack/react-query';
import {useRef, useState} from 'react';

import {useT} from '../../i18n';
import {Avatar, ErrorNote, SearchInput} from '../../portal/ui';
import {Popover} from '../../portal/ui/popover';
import {call} from '../api';
import {useDebounced} from '../chat/api';
import './board-people.css';

export type BoardPerson = {id: number; name: string; role: 'admin' | 'member' | 'viewer'};

/** Everyone who can see the board (names and board roles only), at most 200 per answer; `q` narrows by name on the server. */
export const boardPeopleQuery = (boardId: number, q = '') =>
  queryOptions({
    queryKey: ['board-people', boardId, q],
    queryFn: () => call<{items: BoardPerson[]; more: boolean}>('GET', `/boards/${boardId}/people${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    staleTime: 60_000,
  });

/** Avatars shown on the trigger; the rest are one "N+" circle. */
const SHOWN = 2;

const GROUPS = [
  ['admin', 'boards.people.admins'],
  ['member', 'boards.people.members'],
  ['viewer', 'boards.people.viewers'],
] as const;

/**
 * The board's member avatars (first two, then an `N+` circle). Clicking them opens "Board members": a searchable
 * list of everyone on the board, grouped by their role on it.
 */
export function BoardPeople({boardId}: {boardId: number}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const all = useQuery(boardPeopleQuery(boardId));
  const people = all.data?.items ?? [];
  if (!all.data || people.length === 0) return null;
  const count = all.data.more ? `${people.length}+` : String(people.length);
  const shown = people.slice(0, SHOWN);
  const rest = people.length - shown.length;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="lf-people-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('boards.people.open', {count})}
        title={t('boards.people.title')}
        onClick={() => setOpen(v => !v)}>
        <span className="avatar-stack" aria-hidden="true">
          {shown.map(p => (
            <span key={p.id} className="avatar-stack-item" title={p.name || '?'}>
              <Avatar name={p.name || '?'} size="sm" />
            </span>
          ))}
          {rest > 0 && (
            <span className="avatar avatar-sm avatar-more" title={people.slice(SHOWN).map(p => p.name || '?').join(', ')}>
              {rest}+
            </span>
          )}
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={trigger} label={t('boards.people.title')} align="end" className="lf-people-pop">
        <PeopleList boardId={boardId} initial={all.data} />
      </Popover>
    </>
  );
}

function PeopleList({boardId, initial}: {boardId: number; initial: {items: BoardPerson[]; more: boolean}}) {
  const t = useT();
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim().toLowerCase());
  // All loaded already: filter here. More than one page: ask the server for the name.
  const remote = useQuery({...boardPeopleQuery(boardId, term), enabled: initial.more && term !== '', placeholderData: keepPreviousData});
  const source = initial.more && term ? remote.data : {items: initial.items.filter(p => !term || p.name.toLowerCase().includes(term)), more: initial.more};
  const items = source?.items ?? [];

  return (
    <div className="lf-people">
      <h2 className="lf-people-title">
        {t('boards.people.title')}
      </h2>
      <SearchInput label={t('boards.people.search')} placeholder={t('boards.people.search')} value={search} onChange={e => setSearch(e.target.value)} data-autofocus />
      {remote.error && initial.more && term ? <ErrorNote error={remote.error} title={t('states.loadError')} /> : null}
      {source && items.length === 0 && <p className="lf-people-empty">{t('boards.people.none')}</p>}
      {GROUPS.map(([role, heading]) => {
        const group = items.filter(p => p.role === role);
        if (group.length === 0) return null;
        return (
          <section key={role} className="lf-people-group" aria-label={t(heading)}>
            <h3>
              {t(heading)} <span className="lf-people-count">{group.length}</span>
            </h3>
            <ul>
              {group.map(p => (
                <li key={p.id}>
                  <Avatar name={p.name || '?'} size="sm" />
                  <span className="lf-people-name">{p.name || '?'}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {source?.more && <p className="lf-people-empty">{t('boards.people.more')}</p>}
    </div>
  );
}
