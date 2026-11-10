import type {FieldError} from '../validation';

/**
 * The shape of a Flow's `config` (docs/product/flows-api.md) and its PURE validation: no database here.
 * The route checks that referenced lanes, labels and people belong to the board; the engine re-checks at run time.
 */

export const TRIGGER_KINDS = ['card_created', 'card_moved', 'daily_due'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export type Trigger =
  | {kind: 'card_created'; laneId: number | null}
  | {kind: 'card_moved'; laneId: number}
  | {kind: 'daily_due'; dueInDays: number; laneId: number | null};

export type Conditions = {labelId: number | null};

export type FlowAction =
  | {type: 'assign'; userId: number}
  | {type: 'add_label'; labelId: number}
  | {type: 'move'; laneId: number}
  | {type: 'comment'; body: string}
  | {type: 'notify'; target: 'assignees' | 'user'; userId: number | null};

export type FlowConfig = {trigger: Trigger; conditions: Conditions; actions: FlowAction[]};

export const MAX_ACTIONS = 3;
export const MAX_DUE_DAYS = 30;
export const MAX_COMMENT = 500;
export const MAX_NAME = 80;
export const MAX_FLOWS_PER_BOARD = 30;

export type Errors = Record<string, FieldError>;

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const bad = (errors: Errors, field: string, code: string, message: string): null => {
  errors[field] ??= {code, message};
  return null;
};

export function parseName(v: unknown, errors: Errors): string | null {
  if (typeof v !== 'string' || !v.trim()) return bad(errors, 'name', 'required', 'Give the flow a name.');
  const name = v.trim();
  if (name.length > MAX_NAME) return bad(errors, 'name', 'too_long', `Use at most ${MAX_NAME} characters.`);
  return name;
}

function optionalLane(v: unknown, field: string, errors: Errors): number | null {
  if (v === undefined || v === null) return null;
  if (!isId(v)) {
    bad(errors, field, 'invalid', 'Pick a lane.');
    return null;
  }
  return v;
}

export function parseTrigger(v: unknown, errors: Errors): Trigger | null {
  const t = obj(v);
  if (!t || !TRIGGER_KINDS.includes(t.kind as TriggerKind)) return bad(errors, 'trigger', 'invalid', 'Pick when the flow runs.');
  if (t.kind === 'card_moved') {
    if (!isId(t.laneId)) return bad(errors, 'trigger.laneId', 'required', 'Pick the lane a card moves into.');
    return {kind: 'card_moved', laneId: t.laneId};
  }
  if (t.kind === 'card_created') {
    const laneId = optionalLane(t.laneId, 'trigger.laneId', errors);
    return errors['trigger.laneId'] ? null : {kind: 'card_created', laneId};
  }
  const days = t.dueInDays;
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 0 || days > MAX_DUE_DAYS) {
    return bad(errors, 'trigger.dueInDays', 'out_of_range', `Use a whole number from 0 to ${MAX_DUE_DAYS}.`);
  }
  const laneId = optionalLane(t.laneId, 'trigger.laneId', errors);
  return errors['trigger.laneId'] ? null : {kind: 'daily_due', dueInDays: days, laneId};
}

export function parseConditions(v: unknown, errors: Errors): Conditions {
  if (v === undefined || v === null) return {labelId: null};
  const c = obj(v);
  if (!c) {
    bad(errors, 'conditions', 'invalid', 'Conditions are not valid.');
    return {labelId: null};
  }
  if (c.labelId === undefined || c.labelId === null) return {labelId: null};
  if (!isId(c.labelId)) {
    bad(errors, 'conditions.labelId', 'invalid', 'Pick a label.');
    return {labelId: null};
  }
  return {labelId: c.labelId};
}

export function parseActions(v: unknown, errors: Errors): FlowAction[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_ACTIONS) {
    return bad(errors, 'actions', 'out_of_range', `Add 1 to ${MAX_ACTIONS} actions.`);
  }
  const out: FlowAction[] = [];
  v.forEach((raw, i) => {
    const a = obj(raw);
    const f = (name: string) => `actions.${i}.${name}`;
    if (!a) return void bad(errors, `actions.${i}`, 'invalid', 'Pick what to do.');
    switch (a.type) {
      case 'assign':
        if (!isId(a.userId)) return void bad(errors, f('userId'), 'required', 'Pick a person.');
        return void out.push({type: 'assign', userId: a.userId});
      case 'add_label':
        if (!isId(a.labelId)) return void bad(errors, f('labelId'), 'required', 'Pick a label.');
        return void out.push({type: 'add_label', labelId: a.labelId});
      case 'move':
        if (!isId(a.laneId)) return void bad(errors, f('laneId'), 'required', 'Pick a lane.');
        return void out.push({type: 'move', laneId: a.laneId});
      case 'comment': {
        const body = typeof a.body === 'string' ? a.body.trim() : '';
        if (!body) return void bad(errors, f('body'), 'required', 'Write the comment.');
        if (body.length > MAX_COMMENT) return void bad(errors, f('body'), 'too_long', `Use at most ${MAX_COMMENT} characters.`);
        return void out.push({type: 'comment', body});
      }
      case 'notify': {
        if (a.target !== 'assignees' && a.target !== 'user') return void bad(errors, f('target'), 'invalid', 'Pick who to notify.');
        if (a.target === 'user') {
          if (!isId(a.userId)) return void bad(errors, f('userId'), 'required', 'Pick a person.');
          return void out.push({type: 'notify', target: 'user', userId: a.userId});
        }
        return void out.push({type: 'notify', target: 'assignees', userId: null});
      }
      default:
        return void bad(errors, `actions.${i}`, 'invalid', 'Pick what to do.');
    }
  });
  return out.length === v.length ? out : null;
}

/** A card_moved flow into lane X that moves the card to X again: the engine would skip it, so it is refused up front. */
export function selfLoop(trigger: Trigger, actions: readonly FlowAction[]): boolean {
  return trigger.kind === 'card_moved' && actions.some(a => a.type === 'move' && a.laneId === trigger.laneId);
}

/** Every lane, label and person a config names (the route proves each belongs to the board). */
export function references(config: FlowConfig): {laneIds: number[]; labelIds: number[]; userIds: number[]} {
  const lanes = new Set<number>();
  const labels = new Set<number>();
  const users = new Set<number>();
  if (config.trigger.laneId) lanes.add(config.trigger.laneId);
  if (config.conditions.labelId) labels.add(config.conditions.labelId);
  for (const a of config.actions) {
    if (a.type === 'move') lanes.add(a.laneId);
    else if (a.type === 'add_label') labels.add(a.labelId);
    else if (a.type === 'assign') users.add(a.userId);
    else if (a.type === 'notify' && a.userId) users.add(a.userId);
  }
  return {laneIds: [...lanes], labelIds: [...labels], userIds: [...users]};
}

/** Re-reads a stored `config` (Json, never trusted): the parsed config, or null when it does not parse. */
export function readConfig(raw: unknown): FlowConfig | null {
  const r = obj(raw);
  if (!r) return null;
  const errors: Errors = {};
  const trigger = parseTrigger(r.trigger, errors);
  const conditions = parseConditions(r.conditions, errors);
  const actions = parseActions(r.actions, errors);
  if (!trigger || !actions || Object.keys(errors).length) return null;
  return {trigger, conditions, actions};
}
