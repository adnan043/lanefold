import type {TFunction} from '../../i18n/core';
import type {FlowAction, FlowT} from './logic';

/** What the flow's own ids resolve to; an id that is not in the maps reads as "(missing)". */
export type Names = {lane: (id: number) => string; label: (id: number) => string; user: (id: number) => string};

export function describeTrigger(t: TFunction, flow: FlowT, names: Names): string {
  const trigger = flow.trigger;
  const lane = trigger.laneId ? names.lane(trigger.laneId) : '';
  if (trigger.kind === 'card_moved') return t('flows.sum.moved', {lane});
  if (trigger.kind === 'card_created') return lane ? t('flows.sum.createdIn', {lane}) : t('flows.sum.created');
  const base = trigger.dueInDays === 0 ? t('flows.sum.dueToday') : trigger.dueInDays === 1 ? t('flows.sum.dueTomorrow') : t('flows.sum.dueIn', {days: trigger.dueInDays});
  return lane ? `${base} ${t('flows.sum.inLane', {lane})}` : base;
}

export function describeAction(t: TFunction, action: FlowAction, names: Names): string {
  switch (action.type) {
    case 'assign':
      return t('flows.sum.assign', {name: names.user(action.userId)});
    case 'add_label':
      return t('flows.sum.addLabel', {name: names.label(action.labelId)});
    case 'move':
      return t('flows.sum.move', {lane: names.lane(action.laneId)});
    case 'comment':
      return t('flows.sum.comment', {text: action.body.length > 40 ? `${action.body.slice(0, 40)}…` : action.body});
    default:
      return action.target === 'user' && action.userId ? t('flows.sum.notifyUser', {name: names.user(action.userId)}) : t('flows.sum.notifyAssignees');
  }
}

export function describeFlow(t: TFunction, flow: FlowT, names: Names): string {
  const when = describeTrigger(t, flow, names);
  const cond = flow.conditions.labelId ? ` ${t('flows.sum.ifLabel', {label: names.label(flow.conditions.labelId)})}` : '';
  return `${when}${cond}: ${flow.actions.map(a => describeAction(t, a, names)).join(', ')}`;
}
