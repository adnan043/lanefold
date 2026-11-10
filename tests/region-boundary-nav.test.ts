import {afterEach, describe, expect, it, vi} from 'vitest';

import {isChunkLoadError, safeErrorLabel} from '../src/app/polish';
import {redirect} from '../src/app/nav';
import {RegionBoundary} from '../src/app/region-boundary';

afterEach(() => vi.restoreAllMocks());

describe('RegionBoundary', () => {
  it('turns a thrown error into failed state and keeps the error for classification', () => {
    const err = new Error('boom');
    expect(RegionBoundary.getDerivedStateFromError(err)).toEqual({error: err, failed: true});
  });

  it('renders children until it fails, then the fallback, and Retry resets it', () => {
    const b = new RegionBoundary({region: 'board', children: 'kids'});
    expect(b.render()).toBe('kids');
    let state: any = b.state;
    b.setState = ((s: any) => {
      state = s;
    }) as never;
    b.state = {error: new Error('x'), failed: true};
    const el = b.render() as any;
    expect(el.props.onRetry).toBeTypeOf('function');
    el.props.onRetry();
    expect(state).toEqual({error: null, failed: false});
  });

  it('logs only the error kind, never the message (which can hold titles or addresses)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = new RegionBoundary({region: 'card panel', children: null});
    const e = new TypeError('Card "Secret plan" for bob@x.com');
    b.componentDidCatch(e);
    const line = String(spy.mock.calls[0]![0]);
    expect(line).toBe('[app] card panel failed: TypeError');
    expect(line).not.toMatch(/Secret|bob/);
  });
});

describe('error classification', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/a.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Loading chunk 12 failed.',
  ])('treats %s as a stale deploy', msg => {
    expect(isChunkLoadError(new Error(msg))).toBe(true);
    expect(isChunkLoadError(msg)).toBe(true);
  });

  it('recognises ChunkLoadError by name text and rejects other inputs', () => {
    expect(isChunkLoadError(new Error('ChunkLoadError: x'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({message: 'Loading chunk 1 failed'})).toBe(false);
  });

  it('safeErrorLabel falls back to Error for odd names and non-errors', () => {
    const odd = new Error('x');
    odd.name = 'Bad Name <script>';
    expect(safeErrorLabel(odd)).toBe('Error');
    const long = new Error('x');
    long.name = 'A'.repeat(41);
    expect(safeErrorLabel(long)).toBe('Error');
    expect(safeErrorLabel('str')).toBe('Error');
    expect(safeErrorLabel(null)).toBe('Error');
    expect(safeErrorLabel(new RangeError('x'))).toBe('RangeError');
  });
});

describe('nav redirect wrapper', () => {
  it('throws-able redirect object carries the target and replace flag', () => {
    const r = redirect({to: '/boards', replace: true}) as any;
    expect(r.options.to).toBe('/boards');
    expect(r.options.replace).toBe(true);
    expect(r.isRedirect ?? r.options).toBeTruthy();
  });
});
