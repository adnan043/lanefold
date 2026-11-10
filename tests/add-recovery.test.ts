import {describe, expect, it, vi} from 'vitest';
import {addRetry, recoverFailedAdd} from '../src/app/boards/add-recovery';

describe('failed card add recovery', () => {
  it('offers retry only when the text was not restored', () => {
    const retry = vi.fn();
    expect(addRetry(undefined, retry)).toBe(retry);
    expect(addRetry(() => {}, retry)).toBeUndefined();
  });
  it('restores once and offers no retry when a composer restores', () => {
    const restore = vi.fn();
    const retry = vi.fn();
    expect(recoverFailedAdd(restore, retry)).toBeUndefined();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
  it('keeps retry for callers without a composer', () => {
    const retry = vi.fn();
    expect(recoverFailedAdd(undefined, retry)).toBe(retry);
  });
});
