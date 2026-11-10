/**
 * Flows (board automations), pure logic: the wire types (docs/product/flows-api.md), the editor's draft, the
 * client rules (which mirror the server's validation), and the conversion both ways. No React here.
 */

export type FlowTrigger =
  | {kind: 'card_created'; laneId?: number | null}
  | {kind: 'card_moved'; laneId: number}
  | {kind: 'daily_due'; dueInDays: number; laneId?: number | null};

export type FlowAction =
  | {type: 'assign'; userId: number}
  | {type: 'add_label'; labelId: number}
  | {type: 'move'; laneId: number}
  | {type: 'comment'; body: string}
  | {type: 'notify'; target: 'assignees' | 'user'; userId?: number};

export type FlowT = {
  id: number;
  boardId: number;
  name: string;
  enabled: boolean;
  trigger: FlowTrigger;
  conditions: {labelId?: number | null};
  actions: FlowAction[];
  createdAt: string;
  updatedAt: string;
  lastRunOn: string | null;
  problems: string[];
};

export type FlowsAnswer = {items: FlowT[]; limit: {max: number; used: number; boardMax: number}; enabled: boolean};
export type FlowInput = {name: string; enabled?: boolean; trigger: FlowTrigger; conditions: {labelId?: number | null}; actions: FlowAction[]};

export const TRIGGER_KINDS = ['card_created', 'card_moved', 'daily_due'] as const;
export const ACTION_TYPES = ['assign', 'add_label', 'move', 'comment', 'notify'] as const;
export const MAX_ACTIONS = 3;
export const NAME_MAX = 80;
export const COMMENT_MAX = 500;
export const DUE_DAYS_MAX = 30;

/** An action as the form holds it: every field is a string (an empty one is "not chosen"). `key` is a stable React key. */
export type DraftAction = {key: number; type: FlowAction['type']; userId: string; labelId: string; laneId: string; body: string; target: 'assignees' | 'user'};
export type Draft = {
  name: string;
  enabled: boolean;
  kind: FlowTrigger['kind'];
  laneId: string;
  dueInDays: string;
  labelId: string;
  actions: DraftAction[];
};

let nextKey = 1;
export const newAction = (type: FlowAction['type'] = 'assign'): DraftAction => ({key: nextKey++, type, userId: '', labelId: '', laneId: '', body: '', target: 'assignees'});

export const emptyDraft = (): Draft => ({name: '', enabled: true, kind: 'card_created', laneId: '', dueInDays: '1', labelId: '', actions: [newAction()]});

const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

export function draftFromFlow(flow: FlowT): Draft {
  const trigger = flow.trigger;
  return {
    name: flow.name,
    enabled: flow.enabled,
    kind: trigger.kind,
    laneId: str(trigger.laneId),
    dueInDays: trigger.kind === 'daily_due' ? String(trigger.dueInDays) : '1',
    labelId: str(flow.conditions.labelId),
    actions: flow.actions.map(a => ({
      ...newAction(a.type),
      userId: 'userId' in a ? str(a.userId) : '',
      labelId: a.type === 'add_label' ? String(a.labelId) : '',
      laneId: a.type === 'move' ? String(a.laneId) : '',
      body: a.type === 'comment' ? a.body : '',
      target: a.type === 'notify' ? a.target : 'assignees',
    })),
  };
}

export type ErrorCode = 'required' | 'too_long' | 'invalid' | 'out_of_range' | 'not_found' | 'loop' | 'too_many' | 'no_actions';
/** Field name (the server's: `name`, `trigger.laneId`, `trigger.dueInDays`, `conditions.labelId`, `actions`, `actions.0.userId`…) to a code. */
export type Errors = Record<string, ErrorCode>;

const isId = (value: string) => /^\d+$/.test(value) && Number(value) > 0;

/** Client rules; the same as the server's, so a form that passes here is accepted there. */
export function validateDraft(draft: Draft): Errors {
  const errors: Errors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'required';
  else if (name.length > NAME_MAX) errors.name = 'too_long';
  if (draft.kind === 'card_moved' && !isId(draft.laneId)) errors['trigger.laneId'] = 'required';
  if (draft.kind === 'daily_due') {
    const days = draft.dueInDays.trim();
    if (!days) errors['trigger.dueInDays'] = 'required';
    else if (!/^\d+$/.test(days)) errors['trigger.dueInDays'] = 'invalid';
    else if (Number(days) > DUE_DAYS_MAX) errors['trigger.dueInDays'] = 'out_of_range';
  }
  if (draft.actions.length === 0) errors.actions = 'no_actions';
  else if (draft.actions.length > MAX_ACTIONS) errors.actions = 'too_many';
  draft.actions.forEach((a, i) => {
    const at = (field: string) => `actions.${i}.${field}`;
    if (a.type === 'assign' && !isId(a.userId)) errors[at('userId')] = 'required';
    if (a.type === 'add_label' && !isId(a.labelId)) errors[at('labelId')] = 'required';
    if (a.type === 'move') {
      if (!isId(a.laneId)) errors[at('laneId')] = 'required';
      // A flow into lane X that moves the card back to X would run forever.
      else if (draft.kind === 'card_moved' && a.laneId === draft.laneId) errors[at('laneId')] = 'loop';
    }
    if (a.type === 'comment') {
      const body = a.body.trim();
      if (!body) errors[at('body')] = 'required';
      else if (body.length > COMMENT_MAX) errors[at('body')] = 'too_long';
    }
    if (a.type === 'notify' && a.target === 'user' && !isId(a.userId)) errors[at('userId')] = 'required';
  });
  return errors;
}

/** The request body. Call only for a draft that passed `validateDraft`. */
export function draftToInput(draft: Draft): FlowInput {
  const lane = isId(draft.laneId) ? Number(draft.laneId) : null;
  const trigger: FlowTrigger =
    draft.kind === 'card_moved'
      ? {kind: 'card_moved', laneId: lane ?? 0}
      : draft.kind === 'daily_due'
        ? {kind: 'daily_due', dueInDays: Number(draft.dueInDays), laneId: lane}
        : {kind: 'card_created', laneId: lane};
  const actions = draft.actions.map((a): FlowAction => {
    switch (a.type) {
      case 'assign':
        return {type: 'assign', userId: Number(a.userId)};
      case 'add_label':
        return {type: 'add_label', labelId: Number(a.labelId)};
      case 'move':
        return {type: 'move', laneId: Number(a.laneId)};
      case 'comment':
        return {type: 'comment', body: a.body.trim()};
      default:
        return a.target === 'user' ? {type: 'notify', target: 'user', userId: Number(a.userId)} : {type: 'notify', target: 'assignees'};
    }
  });
  return {name: draft.name.trim(), enabled: draft.enabled, trigger, conditions: {labelId: isId(draft.labelId) ? Number(draft.labelId) : null}, actions};
}

/** Server `fieldCodes` (`{'actions.1.laneId': 'not_found'}`) to our codes; unknown codes read as `invalid`. */
export function serverErrors(fieldCodes: Record<string, string> | undefined): Errors {
  const out: Errors = {};
  const known = new Set<string>(['required', 'too_long', 'invalid', 'out_of_range', 'not_found']);
  for (const [field, code] of Object.entries(fieldCodes ?? {})) out[field] = known.has(code) ? (code as ErrorCode) : 'invalid';
  return out;
}

/** The first field with an error, in screen order, for focusing. */
export function firstErrorField(draft: Draft, errors: Errors): string | null {
  const order = ['name', 'trigger.laneId', 'trigger.dueInDays', 'conditions.labelId', 'actions', ...draft.actions.flatMap((_, i) => ['userId', 'labelId', 'laneId', 'body'].map(f => `actions.${i}.${f}`))];
  return order.find(field => errors[field]) ?? Object.keys(errors)[0] ?? null;
}

export function moveAction<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const copy = list.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item!);
  return copy;
}

/** Ids a flow uses that are no longer in the lists (so the editor can still show them as "missing"). */
export function referencedIds(flow: FlowT) {
  const lanes = new Set<number>();
  const labels = new Set<number>();
  const users = new Set<number>();
  if (flow.trigger.laneId) lanes.add(flow.trigger.laneId);
  if (flow.conditions.labelId) labels.add(flow.conditions.labelId);
  for (const a of flow.actions) {
    if (a.type === 'move') lanes.add(a.laneId);
    if (a.type === 'add_label') labels.add(a.labelId);
    if ('userId' in a && a.userId) users.add(a.userId);
  }
  return {lanes, labels, users};
}
