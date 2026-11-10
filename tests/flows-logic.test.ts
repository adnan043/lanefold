import {describe, expect, it} from 'vitest';

import {draftFromFlow, draftToInput, emptyDraft, firstErrorField, moveAction, newAction, serverErrors, validateDraft, type FlowT} from '../src/app/flows/logic';

const valid = () => ({...emptyDraft(), name: 'Assign', actions: [{...newAction('assign'), userId: '5'}]});

describe('flows logic', () => {
  it('accepts a minimal draft and builds the request', () => {
    const d = valid();
    expect(validateDraft(d)).toEqual({});
    expect(draftToInput(d)).toEqual({name: 'Assign', enabled: true, trigger: {kind: 'card_created', laneId: null}, conditions: {labelId: null}, actions: [{type: 'assign', userId: 5}]});
  });

  it('checks the name, the required lane of a move trigger and the due days', () => {
    expect(validateDraft({...valid(), name: ' '}).name).toBe('required');
    expect(validateDraft({...valid(), name: 'x'.repeat(81)}).name).toBe('too_long');
    expect(validateDraft({...valid(), kind: 'card_moved'})['trigger.laneId']).toBe('required');
    expect(validateDraft({...valid(), kind: 'daily_due', dueInDays: '31'})['trigger.dueInDays']).toBe('out_of_range');
    expect(validateDraft({...valid(), kind: 'daily_due', dueInDays: 'a'})['trigger.dueInDays']).toBe('invalid');
    expect(validateDraft({...valid(), kind: 'daily_due', dueInDays: '0'})).toEqual({});
  });

  it('checks each action by position and the action count', () => {
    expect(validateDraft({...valid(), actions: []}).actions).toBe('no_actions');
    expect(validateDraft({...valid(), actions: [newAction(), newAction(), newAction(), newAction()]}).actions).toBe('too_many');
    const errors = validateDraft({...valid(), actions: [{...newAction('assign'), userId: '1'}, newAction('add_label'), {...newAction('comment'), body: ' '}, newAction('notify')]});
    expect(errors['actions.1.labelId']).toBe('required');
    expect(errors['actions.2.body']).toBe('required');
    expect(errors['actions.3.userId']).toBeUndefined(); // notify the assignees needs no person
    expect(validateDraft({...valid(), actions: [{...newAction('notify'), target: 'user'}]})['actions.0.userId']).toBe('required');
    expect(validateDraft({...valid(), actions: [{...newAction('comment'), body: 'x'.repeat(501)}]})['actions.0.body']).toBe('too_long');
  });

  it('refuses a move back into the lane that fired the flow', () => {
    const d = {...valid(), kind: 'card_moved' as const, laneId: '7', actions: [{...newAction('move'), laneId: '7'}]};
    expect(validateDraft(d)['actions.0.laneId']).toBe('loop');
    expect(validateDraft({...d, actions: [{...newAction('move'), laneId: '8'}]})).toEqual({});
  });

  it('round-trips a flow through the draft', () => {
    const flow: FlowT = {
      id: 1, boardId: 2, name: 'Due soon', enabled: false, createdAt: '', updatedAt: '', lastRunOn: null, problems: [],
      trigger: {kind: 'daily_due', dueInDays: 2, laneId: 3}, conditions: {labelId: 9},
      actions: [{type: 'add_label', labelId: 4}, {type: 'notify', target: 'user', userId: 6}, {type: 'comment', body: 'Hi'}],
    };
    const d = draftFromFlow(flow);
    expect(validateDraft(d)).toEqual({});
    const input = draftToInput(d);
    expect(input).toMatchObject({name: 'Due soon', enabled: false, trigger: flow.trigger, conditions: {labelId: 9}, actions: flow.actions});
  });

  it('maps server field codes and finds the first field', () => {
    const errors = serverErrors({'actions.1.laneId': 'not_found', name: 'weird'});
    expect(errors).toEqual({'actions.1.laneId': 'not_found', name: 'invalid'});
    expect(firstErrorField(valid(), errors)).toBe('name');
  });

  it('reorders actions without mutating', () => {
    const list = [1, 2, 3];
    expect(moveAction(list, 0, 1)).toEqual([2, 1, 3]);
    expect(moveAction(list, 0, -1)).toBe(list);
    expect(list).toEqual([1, 2, 3]);
  });
});
