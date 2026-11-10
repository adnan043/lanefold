import {beforeAll, describe, expect, it} from 'vitest';

import {cardRefsKey, parseCardRefIds} from '../src/lib/card-refs';
import {app} from '../src/server/app';
import {Browser, configureEnv} from './integration/support/harness';

describe('chat extras (signed out)', () => {
  beforeAll(configureEnv);
  for (const path of ['/conversations/1', '/workspaces/1/members/search?q=a', '/cards/refs?ids=1,2']) {
    it(`GET ${path} is 401`, async () => {
      expect((await new Browser(app).get(`/site-api${path}`)).status).toBe(401);
    });
  }
});

describe('card refs batching helpers', () => {
  it('dedupes, sorts and validates ids', () => {
    expect(parseCardRefIds('3,1,3, 2')).toEqual([1, 2, 3]);
    expect(parseCardRefIds(['2', '1'])).toEqual([1, 2]);
    for (const bad of ['', '0', '-1', '1,a', '1.5', '1,,2', '99999999999', undefined]) expect(parseCardRefIds(bad)).toBeNull();
    expect(parseCardRefIds(Array.from({length: 20}, (_, i) => i + 1).join(','))).toHaveLength(20);
    expect(parseCardRefIds(Array.from({length: 21}, (_, i) => i + 1).join(','))).toBeNull();
    expect(parseCardRefIds('1,1,1')).toEqual([1]);
  });
  it('keys a batch by its sorted unique ids', () => {
    expect(cardRefsKey([3, 1, 3])).toEqual(cardRefsKey([1, 3]));
    expect(cardRefsKey([1, 2])).not.toEqual(cardRefsKey([1, 3]));
  });
});
