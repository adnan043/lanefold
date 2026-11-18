import {readdirSync, readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {FLOW_PROBLEMS, parseActions, parseConditions, parseName, parseTrigger, readConfig, references, selfLoop, type Errors} from '../src/server/flows/config';
import {addDays} from '../src/server/jobs/flows';

describe('flows config validation', () => {
  it('accepts every trigger and action', () => {
    const e: Errors = {};
    expect(parseTrigger({kind: 'card_moved', laneId: 3}, e)).toEqual({kind: 'card_moved', laneId: 3});
    expect(parseTrigger({kind: 'card_created'}, e)).toEqual({kind: 'card_created', laneId: null});
    expect(parseTrigger({kind: 'daily_due', dueInDays: 2, laneId: 5}, e)).toEqual({kind: 'daily_due', dueInDays: 2, laneId: 5});
    expect(
      parseActions(
        [{type: 'assign', userId: 1}, {type: 'add_label', labelId: 2}, {type: 'move', laneId: 3}, {type: 'comment', body: ' hi '}, {type: 'notify', target: 'assignees'}],
        e
      )
    ).toBeNull(); // 5 actions: too many
    expect(Object.keys(e)).toEqual(['actions']);
    expect(parseActions([{type: 'comment', body: ' hi '}, {type: 'notify', target: 'user', userId: 9}], {})).toEqual([
      {type: 'comment', body: 'hi'},
      {type: 'notify', target: 'user', userId: 9},
    ]);
  });

  it('refuses bad input with field names the builder can place', () => {
    const e: Errors = {};
    expect(parseTrigger({kind: 'card_moved'}, e)).toBeNull();
    expect(parseTrigger({kind: 'daily_due', dueInDays: 31}, e)).toBeNull();
    expect(parseTrigger({kind: 'nope'}, e)).toBeNull();
    expect(parseActions([{type: 'assign', userId: '1'}, {type: 'comment', body: ''}, {type: 'move', laneId: 0}], e)).toBeNull();
    expect(parseName('  ', e)).toBeNull();
    expect(Object.keys(e).sort()).toEqual(['actions.0.userId', 'actions.1.body', 'actions.2.laneId', 'name', 'trigger', 'trigger.dueInDays', 'trigger.laneId']);
    const long: Errors = {};
    parseActions([{type: 'comment', body: 'x'.repeat(501)}], long);
    expect(long['actions.0.body']?.code).toBe('too_long');
  });

  it('detects a move straight back into the trigger lane, and lists references', () => {
    const trigger = {kind: 'card_moved', laneId: 4} as const;
    expect(selfLoop(trigger, [{type: 'move', laneId: 4}])).toBe(true);
    expect(selfLoop(trigger, [{type: 'move', laneId: 5}])).toBe(false);
    expect(selfLoop({kind: 'card_created', laneId: 4}, [{type: 'move', laneId: 4}])).toBe(false);
    const refs = references({trigger, conditions: parseConditions({labelId: 8}, {}), actions: [{type: 'assign', userId: 2}, {type: 'add_label', labelId: 8}, {type: 'move', laneId: 9}]});
    expect(refs).toEqual({laneIds: [4, 9], labelIds: [8], userIds: [2]});
  });

  it('re-reads stored config defensively', () => {
    expect(readConfig(null)).toBeNull();
    expect(readConfig({trigger: {kind: 'card_created'}, actions: []})).toBeNull();
    expect(readConfig({trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'ok'}]})).toEqual({
      trigger: {kind: 'card_created', laneId: null},
      conditions: {labelId: null},
      actions: [{type: 'comment', body: 'ok'}],
    });
  });

  it('adds days across a month end in UTC', () => {
    expect(addDays('2026-11-29', 3)).toBe('2026-12-02');
  });

  it('has a message for every problem code in every locale', () => {
    const dir = new URL('../src/i18n/messages/', import.meta.url);
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const file of files) {
      const messages = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Record<string, string>;
      for (const code of FLOW_PROBLEMS) expect(messages[`flows.problem.${code}`], `${file} flows.problem.${code}`).toBeTruthy();
    }
  });
});
