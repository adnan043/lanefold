import {beforeAll, describe, expect, it} from 'vitest';

import {app} from '../src/server/app';
import {cleanBody, dmKeyOf, isEmoji, unreadOf} from '../src/server/routes/chat';
import {Browser, configureEnv} from './integration/support/harness';

describe('chat helpers', () => {
  it('unread math never goes negative', () => {
    expect(unreadOf(10n, 4n)).toBe(6);
    expect(unreadOf(4, 4)).toBe(0);
    expect(unreadOf(3n, 9n)).toBe(0);
  });
  it('DM key is the same for both people', () => {
    expect(dmKeyOf(7, 3)).toBe('3:7');
    expect(dmKeyOf(3, 7)).toBe('3:7');
  });
  it('cleans control characters and trims', () => {
    expect(cleanBody('  hi\u0000 there\r\nline‮  ')).toBe('hi there\nline');
  });
  it('accepts emoji only', () => {
    expect(isEmoji('👍')).toBe(true);
    expect(isEmoji('👍🏽')).toBe(true);
    expect(isEmoji('a')).toBe(false);
    expect(isEmoji('<b>')).toBe(false);
    expect(isEmoji('')).toBe(false);
    expect(isEmoji('👍'.repeat(20))).toBe(false);
  });
});

describe('chat routes (signed out)', () => {
  beforeAll(configureEnv);
  for (const path of ['/chat/pulse', '/workspaces/1/conversations', '/boards/1/conversation', '/conversations/1/messages']) {
    it(`GET ${path} is 401`, async () => {
      expect((await new Browser(app).get(`/site-api${path}`)).status).toBe(401);
    });
  }
  it('writes are refused before a handler', async () => {
    const browser = new Browser(app);
    for (const [method, path] of [['POST', '/conversations/1/messages'], ['PATCH', '/messages/1'], ['DELETE', '/messages/1'], ['PUT', '/messages/1/reactions'], ['POST', '/conversations/1/read'], ['PUT', '/conversations/1/mute']] as const) {
      const res = await browser.request(method, `/site-api${path}`, {body: 'x'});
      expect([401, 422], `${method} ${path}`).toContain(res.status);
    }
  });
});
