import {siteFetch} from '../platform/browser';

/**
 * BROWSER: a list page. The page itself is a static shell (title, text, filters, skeleton rows) and
 * its rows come from a JSON route, so a filter, a search or "load more" fetches only the data
 * (docs/agent/performance.md "Which kind of page"). Filters live in the URL, so a result is a real link and
 * the back button works. Every row is built with `textContent`: nothing from an answer is parsed as HTML.
 *
 * What it looks for inside `root`:
 *   form[data-list-filters]        its fields become the query string
 *   ul[data-list-items]            the rows go here
 *   template[data-list-item]       one row; `render` fills a copy
 *   [data-list-skeleton]           shown while loading
 *   [data-list-empty]              no rows, no filters
 *   [data-list-no-match]           no rows with these filters
 *   [data-list-error]              the data could not be read; a [data-list-retry] button inside it
 *   [data-list-more]               the "load more" button
 *   [data-list-clear]              clears the filters, shown only with filters on
 */
export interface ListPageOptions<Body, Item> {
  root: HTMLElement;
  /** The JSON route (`/site-api/jobs`). */
  endpoint: string;
  items: (body: Body) => Item[];
  /** The cursor of the next page, or null on the last one. */
  next: (body: Body) => string | number | null;
  /** The query parameter that carries the cursor. Default `before`. */
  cursorParam?: string;
  render: (row: DocumentFragment, item: Item) => void;
}

const SEARCH_DELAY_MS = 300;

/** The route's address: empty values dropped, so the plain list is exactly `endpoint` (see `preloadData`). */
export function listUrl(endpoint: string, params: URLSearchParams, cursorParam = 'before', cursor?: string | number | null): string {
  const query = new URLSearchParams();
  for (const [key, value] of params) if (value !== '' && key !== cursorParam) query.append(key, value);
  const at = cursor ?? params.get(cursorParam);
  if (at !== null && at !== undefined && at !== '') query.set(cursorParam, String(at));
  const text = query.toString();
  return text ? `${endpoint}?${text}` : endpoint;
}

export function bindListPage<Body, Item>(options: ListPageOptions<Body, Item>): void {
  const {root, endpoint, cursorParam = 'before'} = options;
  if (root.dataset.bound) return;
  root.dataset.bound = '1';
  const part = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-list-${name}]`);
  const form = part<HTMLFormElement>('filters');
  const list = part<HTMLElement>('items')!;
  const template = root.querySelector<HTMLTemplateElement>('template[data-list-item]')!;
  const skeleton = part('skeleton');
  const empty = part('empty');
  const noMatch = part('no-match');
  const error = part('error');
  const more = part<HTMLButtonElement>('more');
  const clear = part('clear');
  const stop = new AbortController();
  let current: AbortController | null = null;
  let cursor: string | number | null = null;
  let typing: ReturnType<typeof setTimeout> | undefined;

  const show = (el: HTMLElement | null, on: boolean) => {
    if (el) el.hidden = !on;
  };
  const urlParams = () => new URLSearchParams(location.search);
  const filtersOn = () => [...urlParams().keys()].some(key => key !== cursorParam);

  /** The form as the URL says: the shell was built once, without any filters. */
  function fillForm(): void {
    if (!form) return;
    const params = urlParams();
    for (const field of Array.from(form.elements) as HTMLInputElement[]) {
      if (!field.name) continue;
      if (field.type === 'checkbox') field.checked = params.get(field.name) === field.value;
      else field.value = params.get(field.name) ?? '';
    }
  }

  function formParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (form) for (const [key, value] of new FormData(form)) if (typeof value === 'string' && value.trim()) params.append(key, value.trim());
    return params;
  }

  async function load(append: boolean): Promise<void> {
    current?.abort();
    const request = (current = new AbortController());
    const signal = AbortSignal.any([request.signal, stop.signal]);
    list.setAttribute('aria-busy', 'true');
    show(error, false);
    if (more) more.disabled = append;
    if (!append) {
      list.replaceChildren();
      show(skeleton, true);
      for (const el of [empty, noMatch, more]) show(el, false);
      show(clear, filtersOn());
    }
    try {
      const url = listUrl(endpoint, urlParams(), cursorParam, append ? cursor : undefined);
      const res = await siteFetch(url, {headers: {accept: 'application/json'}, signal});
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Body;
      if (request.signal.aborted) return;
      const rows = options.items(body);
      for (const item of rows) {
        const row = template.content.cloneNode(true) as DocumentFragment;
        options.render(row, item);
        list.append(row);
      }
      cursor = options.next(body);
      show(more, cursor !== null);
      if (!append && !rows.length) show(filtersOn() ? noMatch : empty, true);
    } catch {
      if (signal.aborted) return;
      show(error, true);
    } finally {
      if (!request.signal.aborted) {
        show(skeleton, false);
        list.removeAttribute('aria-busy');
        if (more) more.disabled = false;
      }
    }
  }

  /** New filters: a new URL, the rows again. While typing, the same history entry. */
  function apply(replace: boolean): void {
    const query = formParams().toString();
    const url = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
    // Keep the router's state: back and forward are then its job, and it brings this page up again from
    // the static shell, which reads the filters from the URL.
    if (replace) history.replaceState(history.state, '', url);
    else history.pushState(history.state, '', url);
    void load(false);
  }

  const on = {signal: stop.signal};
  form?.addEventListener(
    'submit',
    event => {
      event.preventDefault();
      clearTimeout(typing);
      apply(false);
    },
    on
  );
  form?.addEventListener(
    'change',
    event => {
      if ((event.target as HTMLInputElement).type === 'search') return;
      clearTimeout(typing);
      apply(false);
    },
    on
  );
  form?.addEventListener(
    'input',
    event => {
      if ((event.target as HTMLInputElement).type !== 'search') return;
      clearTimeout(typing);
      typing = setTimeout(() => apply(true), SEARCH_DELAY_MS);
    },
    on
  );
  clear?.addEventListener(
    'click',
    event => {
      event.preventDefault();
      form?.reset();
      for (const field of form ? (Array.from(form.elements) as HTMLInputElement[]) : []) if (field.type === 'search') field.value = '';
      apply(false);
    },
    on
  );
  more?.addEventListener('click', () => void load(true), on);
  part('retry')?.addEventListener('click', () => void load(false), on);
  // The next page replaces this one: nothing keeps running for a list that is gone.
  document.addEventListener(
    'astro:before-swap',
    () => {
      clearTimeout(typing);
      current?.abort();
      stop.abort();
    },
    {once: true}
  );

  fillForm();
  void load(false);
}
