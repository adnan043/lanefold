/**
 * A tiny batching loader: every `load(id)` asked for in the same tick joins ONE request per `max` distinct ids
 * (`GET /cards/refs` takes 20), instead of one request per message. The server decides access exactly as before;
 * an id it does not answer (missing, or a card the viewer may not see) resolves to null.
 */
export function createBatcher<T>(fetchChunk: (ids: number[]) => Promise<T[]>, idOf: (item: T) => number, max = 20) {
  let queue = new Map<number, {resolve: (v: T | null) => void; reject: (e: unknown) => void}[]>();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const batch = queue;
    queue = new Map();
    const ids = [...batch.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i += max) {
      const chunk = ids.slice(i, i + max);
      fetchChunk(chunk).then(
        items => {
          const found = new Map(items.map(item => [idOf(item), item]));
          for (const id of chunk) for (const w of batch.get(id) ?? []) w.resolve(found.get(id) ?? null);
        },
        error => {
          for (const id of chunk) for (const w of batch.get(id) ?? []) w.reject(error);
        }
      );
    }
  };

  return (id: number): Promise<T | null> =>
    new Promise((resolve, reject) => {
      const waiting = queue.get(id) ?? [];
      waiting.push({resolve, reject});
      queue.set(id, waiting);
      if (!scheduled) {
        scheduled = true;
        // A macrotask, not a microtask: every chip mounted in the same render commit has asked by then.
        setTimeout(flush, 0);
      }
    });
}
