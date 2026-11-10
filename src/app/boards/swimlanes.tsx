import {useEffect, useMemo, useState} from 'react';

import {useT} from '../../i18n';
import {Icon, Select} from '../../portal/ui';
import type {BoardData, CardT} from '../api';
import type {BoardActions, Undoable} from './actions';
import {BoardCanvas} from './canvas';
import type {LaneHandlers} from './lane';
import {buildSwimGroups, GROUP_BYS, type GroupBy, groupByStorageKey, isGroupBy, type SwimGroup} from './swimlane-logic';
import './swimlanes.css';

/** The chosen grouping, remembered per board per user in localStorage ("none", the plain board, is the default). */
export function useGroupBy(userId: number | null, boardId: number): [GroupBy, (by: GroupBy) => void] {
  const key = groupByStorageKey(userId, boardId);
  const read = (): GroupBy => {
    try {
      const value = window.localStorage.getItem(key);
      return isGroupBy(value) ? value : 'none';
    } catch {
      return 'none';
    }
  };
  const [by, setBy] = useState<GroupBy>(read);
  useEffect(() => setBy(read()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (next: GroupBy) => {
    setBy(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      /* private mode: the choice lasts until the page closes */
    }
  };
  return [by, choose];
}

/** The "Group by" select of the board toolbar (labelled, keyboard native). */
export function GroupBySelect({value, onChange}: {value: GroupBy; onChange: (by: GroupBy) => void}) {
  const t = useT();
  return (
    <div className="lf-groupby">
      <span id="lf-groupby-label">{t('sw.groupBy')}</span>
      <Select
        aria-labelledby="lf-groupby-label"
        value={value}
        onChange={e => isGroupBy(e.target.value) && onChange(e.target.value)}
        options={GROUP_BYS.map(g => ({value: g, label: t(`sw.by.${g}` as 'sw.by.none')}))}
      />
    </div>
  );
}

function useGroupName() {
  const t = useT();
  return (group: SwimGroup): string => {
    if (group.name) return group.name;
    if (group.kind === 'priority') return t(`sw.p.${group.key.slice(2)}` as 'sw.p.none');
    return t(group.kind === 'assignee' ? 'sw.unassigned' : 'sw.noLabel');
  };
}

/**
 * Horizontal rows by assignee, label or priority. Each row is a normal board canvas holding only that row's cards,
 * so dragging between lanes (mouse, touch, keyboard) works exactly as on the board; a card moves between lanes
 * inside its row. Changing a card's assignee, label or priority is done in the card, not by dragging across rows.
 */
export function Swimlanes({
  data,
  by,
  actions,
  handlers,
  onUndoable,
  match,
}: {
  data: BoardData;
  by: Exclude<GroupBy, 'none'>;
  actions: BoardActions;
  handlers: Omit<LaneHandlers, 'onAddCards' | 'onLoadMore'>;
  onUndoable: (label: string, undo: Undoable) => void;
  match: ((card: CardT) => boolean) | null;
}) {
  const t = useT();
  const nameOf = useGroupName();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => buildSwimGroups(data.lanes, by, match), [data.lanes, by, match]);
  // Rows only exist once cards are known: load the lanes the board answer left empty.
  const {loadLane} = actions;
  const unloaded = data.lanes.filter(l => !l.loaded).map(l => l.id).join(',');
  useEffect(() => {
    for (const id of unloaded ? unloaded.split(',') : []) void loadLane(Number(id));
  }, [unloaded, loadLane]);

  if (groups.length === 0) return <p className="lf-empty">{t('sw.empty')}</p>;
  return (
    <div className="lf-swim" role="list" aria-label={t('sw.rows')}>
      {groups.map(group => {
        const name = nameOf(group);
        const open = !closed.has(group.key);
        const regionId = `swim-${by}-${group.key.replace(/[^a-z0-9]/gi, '-')}`;
        return (
          <section key={group.key} className="lf-swim-row" role="listitem" aria-labelledby={`${regionId}-h`}>
            <h3 className="lf-swim-head" id={`${regionId}-h`}>
              <button
                type="button"
                className="lf-swim-toggle"
                aria-expanded={open}
                aria-controls={regionId}
                onClick={() => setClosed(cur => {
                  const next = new Set(cur);
                  if (!next.delete(group.key)) next.add(group.key);
                  return next;
                })}>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
                {group.colorHex && <span className="lf-swim-dot" ref={n => n?.style.setProperty('background', group.colorHex!)} aria-hidden="true" />}
                <span className="lf-swim-name">{name}</span>
                <span className="lf-swim-count">{group.cardCount}</span>
              </button>
            </h3>
            <div id={regionId} hidden={!open}>
              {open && (
                <BoardCanvas
                  data={{...data, lanes: group.lanes}}
                  actions={actions}
                  handlers={handlers}
                  onUndoable={onUndoable}
                  match={null}
                  swimlane
                  dndId={regionId}
                />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
