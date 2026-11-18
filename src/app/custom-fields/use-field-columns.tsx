import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useRef} from 'react';

import {useI18n, useT} from '../../i18n';
import {Badge} from '../../portal/ui';
import {type Column} from '../../portal/ui';
import {call} from '../api';
import {type FieldValuesPage, type FieldValuesT, loadFieldValues, revNewer} from './field-values';

export type {FieldValuesT} from './field-values';

/**
 * A board's custom fields and every card's values (`GET /boards/:id/field-values`). Read in full (page by page) once,
 * then, each time the board's revision moves past what we hold, only the cards that changed since (one small read).
 */
export function useFieldValues(boardId: number, rev: string) {
  const qc = useQueryClient();
  const key = ['field-values', boardId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => loadFieldValues(q => call<FieldValuesPage>('GET', `/boards/${boardId}/field-values${q ? `?${q}` : ''}`), qc.getQueryData<FieldValuesT>(key)),
    // Refreshed by the revision below, never on a timer or on focus.
    staleTime: Infinity,
    gcTime: 60_000,
  });
  const held = query.data?.rev;
  const asked = useRef('');
  const {refetch, isFetching} = query;
  useEffect(() => {
    // One read per revision: a delta that answers an older revision (never expected) cannot loop.
    if (held === undefined || isFetching || !revNewer(rev, held) || asked.current === `${boardId}:${rev}`) return;
    asked.current = `${boardId}:${rev}`;
    void refetch();
  }, [boardId, rev, held, isFetching, refetch]);
  return query;
}

/** One Table column per custom field; the cell shows the card's value in the field's type. */
export function useFieldColumns<Row extends {card: {id: number}}>(boardId: number, rev: string): Column<Row>[] {
  const t = useT();
  const {formatDate} = useI18n();
  const {data} = useFieldValues(boardId, rev);
  if (!data) return [];
  return data.fields.map(field => ({
    key: `field-${field.id}`,
    header: field.name,
    hideOnMobile: true,
    cell: ({card}: Row) => {
      const v = data.values[String(card.id)]?.[String(field.id)];
      if (v === undefined) return null;
      if (field.type === 'checkbox') return v === true ? <span aria-label={t('cf.yes')}>✓</span> : null;
      if (field.type === 'date' && typeof v === 'string') return formatDate(`${v}T00:00:00Z`, {dateStyle: 'medium', timeZone: 'UTC'});
      if (field.type === 'dropdown') {
        const option = field.options.find(o => o.id === v);
        return option ? <Badge>{option.name}</Badge> : null;
      }
      return String(v);
    },
  }));
}
