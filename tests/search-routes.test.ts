import {beforeAll, describe, expect, it} from 'vitest';

import {app} from '../src/server/app';
import {filterCommands, type CommandItem} from '../src/portal/ui/command';
import {Browser, configureEnv} from './integration/support/harness';

/** No database needed: search, My Day and Inbox refuse a signed-out visitor, and the routes are mounted. */
describe('search, my day and inbox routes (signed out)', () => {
  beforeAll(configureEnv);
  for (const path of ['/workspaces/1/search?q=roadmap', '/my-day', '/workspaces/1/inbox']) {
    it(`GET ${path} is 401`, async () => {
      expect((await new Browser(app).get(`/site-api${path}`)).status).toBe(401);
    });
  }
  it('writes are refused before they reach a handler', async () => {
    const browser = new Browser(app);
    for (const path of ['/workspaces/1/inbox/cards', '/inbox/cards/1/triage']) {
      const res = await browser.request('POST', `/site-api${path}`, {title: 'x', laneId: 1});
      expect([401, 422], path).toContain(res.status);
    }
  });
});

describe('command palette filtering', () => {
  const item = (id: string, label: string, always = false): CommandItem => ({id, label, always, onSelect: () => {}});
  it('keeps server results whatever was typed, after the matches', () => {
    const items = [item('a', 'Boards'), item('b', 'My Day'), item('c', 'Quarterly numbers', true)];
    expect(filterCommands(items, 'zzzz').map(i => i.id)).toEqual(['c']);
    expect(filterCommands(items, 'bo').map(i => i.id)).toEqual(['a', 'c']);
    expect(filterCommands(items, '').map(i => i.id)).toEqual(['a', 'b', 'c']);
  });
});
