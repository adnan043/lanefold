import {describe, expect, it, vi} from 'vitest';

import {createLoader} from '../src/app/lazy';

describe('createLoader', () => {
  it('retries once and resolves', async () => {
    const importer = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('mod');
    const loader = createLoader(importer, 0);
    expect(await loader.load()).toBe('mod');
    expect(importer).toHaveBeenCalledTimes(2);
    expect(loader.loaded()).toBe('mod');
  });
  it('returns null after two failures and does not cache the failure', async () => {
    const importer = vi.fn().mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValue('mod');
    const loader = createLoader(importer, 0);
    expect(await loader.load()).toBeNull();
    expect(loader.loaded()).toBeNull();
    expect(await loader.load()).toBe('mod');
    expect(importer).toHaveBeenCalledTimes(3);
  });
  it('shares one in-flight load and caches success', async () => {
    const importer = vi.fn().mockResolvedValue('mod');
    const loader = createLoader(importer, 0);
    await Promise.all([loader.load(), loader.load()]);
    await loader.load();
    expect(importer).toHaveBeenCalledTimes(1);
  });
});
