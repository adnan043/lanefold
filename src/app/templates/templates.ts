import {queryOptions} from '@tanstack/react-query';

import {call} from '../api';

/** Mirrors `TemplatePayload` in `src/server/routes/card-templates.ts`. */
export type CardTemplatePayload = {
  title: string;
  description: string;
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  estimateMinutes: number | null;
  checklists: {title: string; items: string[]}[];
  labels: string[];
};
export type CardTemplate = {id: number; name: string; payload: CardTemplatePayload; mine: boolean; createdAt: string};
export type CardTemplateList = {items: CardTemplate[]; max: number; canManage: boolean};

export const cardTemplatesQuery = (workspaceId: number) =>
  queryOptions({
    queryKey: ['card-templates', workspaceId],
    queryFn: () => call<CardTemplateList>('GET', `/workspaces/${workspaceId}/card-templates`),
    staleTime: 60_000,
  });

/** `{date}` in a title pattern becomes today's date (local, YYYY-MM-DD); nothing else is interpreted. */
export function expandTitle(pattern: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return pattern.replaceAll('{date}', day).trim().slice(0, 200);
}

export const applyTemplate = (cardId: number, templateId: number) => call('POST', `/cards/${cardId}/apply-template`, {templateId});
