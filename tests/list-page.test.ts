import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {listUrl} from '../src/lib/list-page';

describe('a list page', () => {
  it('asks for the plain route with no filters, so the preload is used', () => {
    expect(listUrl('/site-api/jobs', new URLSearchParams())).toBe('/site-api/jobs');
    expect(listUrl('/site-api/jobs', new URLSearchParams('search=&type='))).toBe('/site-api/jobs');
  });

  it('keeps filters, and the next page wins over a cursor in the URL', () => {
    const params = new URLSearchParams('type=contract&before=40&remote=1');
    expect(listUrl('/site-api/jobs', params)).toBe('/site-api/jobs?type=contract&remote=1&before=40');
    expect(listUrl('/site-api/jobs', params, 'before', 12)).toBe('/site-api/jobs?type=contract&remote=1&before=12');
  });

  // Lanefold has no job board (migration drop_job_board), so only the helper itself is checked here.
  it('never builds a row from HTML', () => {
    const helper = readFileSync(new URL('../src/lib/list-page.ts', import.meta.url), 'utf8');
    expect(helper).not.toMatch(/innerHTML|set:html|insertAdjacentHTML/);
  });
});
