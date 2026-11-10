import {useMemo, useState} from 'react';

import {useI18n, useT} from '../../../i18n';
import {Badge, EmptyState} from '../../../portal/ui';
import {type Column, DataTable} from '../../../portal/ui';
import type {BoardData, CardT} from '../../api';
import type {BoardActions} from '../actions';
import {useFieldColumns} from '../../custom-fields/use-field-columns';
import {nextSort, type Row, type SortDir, type SortKey, sortRows, tableRows} from './view-logic';
import {LoadMoreBar, useFirstPages} from './use-lanes-loaded';

/** The board as a sortable table. Same data as the board (the cached query, kept fresh by the sync poll). */
export function TableView({data, actions, onOpenCard}: {data: BoardData; actions: BoardActions; onOpenCard: (card: CardT) => void}) {
  const t = useT();
  const {locale, formatDate} = useI18n();
  const [sort, setSort] = useState<{key: SortKey; dir: SortDir}>({key: 'lane', dir: 'asc'});
  useFirstPages(data.lanes, actions);
  const rows = useMemo(() => sortRows(tableRows(data.lanes), sort.key, sort.dir, locale), [data.lanes, sort, locale]);

  const head = (key: SortKey, label: string) => {
    const on = sort.key === key;
    return (
      <button type="button" className="lf-vt-sort" aria-label={`${t('views.table.sortBy', {column: label})}${on ? `, ${t(sort.dir === 'asc' ? 'views.table.sortedAsc' : 'views.table.sortedDesc')}` : ''}`} onClick={() => setSort(cur => nextSort(cur, key))}>
        {label}
        <span aria-hidden="true" className="lf-vt-arrow">{on ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    );
  };

  const fieldColumns = useFieldColumns<Row>(data.board.id, data.board.rev);
  const columns: Column<Row>[] = [
    {
      key: 'number',
      header: head('number', t('views.table.number')),
      width: 'shrink',
      cell: ({card}) => (card.number == null ? null : <span className="lf-vt-num">#{card.number}</span>),
    },
    {
      key: 'title',
      header: head('title', t('views.table.title')),
      cell: ({card}) => (
        <button type="button" className="lf-vt-open" aria-label={t('views.table.openCard', {title: card.title})} dir="auto" onClick={() => onOpenCard(card)}>
          {card.title}
        </button>
      ),
    },
    {key: 'lane', header: head('lane', t('views.table.lane')), cell: r => r.laneName, hideOnMobile: true},
    {
      key: 'due',
      header: head('due', t('views.table.due')),
      width: 'shrink',
      cell: ({card}) => (card.dueDate ? formatDate(`${card.dueDate}T00:00:00Z`, {dateStyle: 'medium', timeZone: 'UTC'}) : <span className="lf-vt-muted">{t('views.table.noDue')}</span>),
    },
    {
      key: 'labels',
      header: head('labels', t('views.table.labels')),
      hideOnMobile: true,
      cell: ({card}) => (card.labels?.length ? <span className="lf-vt-tags">{card.labels.map(l => <Badge key={l.id}>{l.name}</Badge>)}</span> : null),
    },
    {
      key: 'members',
      header: head('members', t('views.table.assignees')),
      hideOnMobile: true,
      cell: ({card}) => (card.members?.length ? card.members.map(m => m.name).join(', ') : null),
    },
    {
      key: 'priority',
      header: head('priority', t('views.table.priority')),
      width: 'shrink',
      cell: ({card}) => (card.priority === 'none' ? null : t(`card.priority.${card.priority}` as 'card.priority.low')),
    },
    ...fieldColumns,
  ];

  return (
    <div className="lf-vw lf-vw-table">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={r => r.card.id}
        caption={t('views.table.caption')}
        virtualize={{estimate: 52}}
        loading={data.lanes.some(l => !l.loaded) && rows.length === 0}
        empty={data.lanes.some(l => !l.loaded || l.hasMore) ? undefined : <EmptyState icon="list" title={t('views.table.empty')}>{t('views.table.emptyBody')}</EmptyState>}
      />
      <LoadMoreBar lanes={data.lanes} actions={actions} />
    </div>
  );
}
