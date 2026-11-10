import {useQuery} from '@tanstack/react-query';

import {useI18n, useT} from '../../i18n';
import {Badge} from '../../portal/ui';
import {type Column} from '../../portal/ui';
import {call} from '../api';
import type {FieldT} from '../cards/use-card';

type Value = string | number | boolean;
export type FieldValuesT = {fields: FieldT[]; values: Record<string, Record<string, Value>>};

/** A board's custom fields and every card's values (`GET /boards/:id/field-values`), re-read when the board's revision moves. */
export function useFieldValues(boardId: number, rev: string) {
  return useQuery({
    queryKey: ['field-values', boardId, rev],
    queryFn: () => call<FieldValuesT>('GET', `/boards/${boardId}/field-values`),
    staleTime: 30_000,
    placeholderData: previous => previous,
  });
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
