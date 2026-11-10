import type {MessageKey} from '../i18n';
import {call} from './api';

/** Starter boards: only lane names, made through the ordinary `POST /workspaces/:id/boards` (no server change). */
export type TemplateId = 'blank' | 'sprint' | 'content' | 'personal';

export const TEMPLATES: {id: TemplateId; title: MessageKey; description: MessageKey; lanes: MessageKey[]}[] = [
  {id: 'blank', title: 'tpl.blank', description: 'tpl.blank.desc', lanes: []},
  {id: 'sprint', title: 'tpl.sprint', description: 'tpl.sprint.desc', lanes: ['tpl.lane.backlog', 'tpl.lane.inProgress', 'tpl.lane.review', 'tpl.lane.done']},
  {id: 'content', title: 'tpl.content', description: 'tpl.content.desc', lanes: ['tpl.lane.ideas', 'tpl.lane.drafting', 'tpl.lane.review', 'tpl.lane.scheduled', 'tpl.lane.published']},
  {id: 'personal', title: 'tpl.personal', description: 'tpl.personal.desc', lanes: ['tpl.lane.todo', 'tpl.lane.doing', 'tpl.lane.done']},
];

export type Intent = 'team' | 'personal' | 'school';
export const INTENT_TEMPLATE: Record<Intent, TemplateId> = {team: 'sprint', personal: 'personal', school: 'blank'};

export async function createBoardFromTemplate(workspaceId: number, id: TemplateId, name: string, t: (key: MessageKey) => string): Promise<number> {
  const template = TEMPLATES.find(item => item.id === id) ?? TEMPLATES[0]!;
  const {board} = await call<{board: {id: number}}>('POST', `/workspaces/${workspaceId}/boards`, {
    name,
    visibility: 'workspace',
    lanes: template.lanes.map(lane => t(lane)),
  });
  return board.id;
}
