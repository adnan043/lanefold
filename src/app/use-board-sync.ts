import {type QueryClient, useQueryClient} from '@tanstack/react-query';
import {useEffect} from 'react';

import {ApiError, type BoardData, call, type Delta} from './api';
import {applyChanges} from './board-state';

/**
 * Board sync by polling (SPEC §8). The ONLY place that knows the transport: a future push channel replaces this
 * hook and no screen changes.
 *
 * Every ~5 s (while the tab is visible) ask `GET /boards/:id/rev` (one primary-key read); only when it moved,
 * fetch `GET /boards/:id/changes?since=<our rev>` and merge it into the cached board. Never applies a poll
 * while one of our own writes is in flight (the answer could predate it); errors back off (5, 10, 20 … 60 s);
 * a hidden tab polls nothing and checks at once when it comes back.
 */
let inflight = 0;
/** Counts every write that STARTS or ENDS: a poll that saw it change while it was fetching drops its answer. */
let writeGen = 0;
/** Wrap every write: `await tracked(() => call(...))`. */
export async function tracked<T>(run: () => Promise<T>): Promise<T> {
  inflight += 1;
  writeGen += 1;
  try {
    return await run();
  } finally {
    inflight -= 1;
    writeGen += 1;
    if (inflight === 0) for (const done of settledWaiters.splice(0)) done();
  }
}

let settledWaiters: (() => void)[] = [];
/** Resolves once no write is in flight (at once if none is), or after `maxMs` so a stuck request never blocks a sync. */
function writesSettled(maxMs = 10_000): Promise<void> {
  if (inflight === 0) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      window.clearTimeout(timer);
      settledWaiters = settledWaiters.filter(w => w !== done);
      resolve();
    };
    const timer = window.setTimeout(done, maxMs);
    settledWaiters.push(done);
  });
}

/** True from drag start to drop/cancel: no delta is applied while a card or lane is held (the draft would jump). */
let paused = false;
export function pauseBoardSync(on: boolean) {
  paused = on;
}

/**
 * Right after one of our own writes that the client cannot apply by itself (bulk actions, moving a lane's cards):
 * fetch the delta now instead of reloading the whole board. A reload re-caps every lane at its first page (the
 * "Load more" pages are lost) and re-fires a page request per lane; the delta changes only what moved.
 * Another write in flight, or one that started while the delta was on its way (its answer could predate it): wait
 * for the writes to settle and ask again, a few times; then reload, as do a too-big delta and an error. Never leaves
 * the result to the poll, which can be 15 s away on a quiet board. Call it AFTER `tracked(...)` has settled.
 */
export async function syncBoardNow(queryClient: QueryClient, boardId: number) {
  const key = ['board', boardId];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await writesSettled();
    const data = queryClient.getQueryData<BoardData>(key);
    if (!data) return;
    const gen = writeGen;
    try {
      const delta = await call<Delta>('GET', `/boards/${boardId}/changes?since=${data.board.rev}`);
      if (inflight > 0 || gen !== writeGen) continue;
      if (delta.truncated) await queryClient.invalidateQueries({queryKey: key});
      else queryClient.setQueryData<BoardData>(key, current => (current ? applyChanges(current, delta) : current));
      return;
    } catch {
      break;
    }
  }
  await queryClient.invalidateQueries({queryKey: key});
}

const BASE_MS = 5000;
const MAX_MS = 60_000;
/** Quiet board: after ~1 min of unchanged polls ask every 10 s, after ~5 min every 15 s (halves the idle cost). Any change or wake-up resets it. */
export const idleBaseMs = (idlePolls: number) => (idlePolls >= 40 ? 15_000 : idlePolls >= 12 ? 10_000 : BASE_MS);

export function useBoardSync(boardId: number) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const key = ['board', boardId];
    let timer: number | undefined;
    let stopped = false;
    let failures = 0;
    let running = false;
    let idle = 0;
    /** When the last poll started: a wake right after it (visibilitychange then focus, or focus from devtools) is skipped. */
    let lastRun = 0;

    const schedule = () => {
      if (stopped) return;
      window.clearTimeout(timer);
      const delay = Math.min(MAX_MS, idleBaseMs(idle) * 2 ** failures) + Math.random() * 1000;
      timer = window.setTimeout(tick, delay);
    };

    async function tick() {
      if (stopped || running) return;
      running = true;
      lastRun = Date.now();
      try {
        await run();
      } finally {
        running = false;
      }
      schedule();
    }

    async function run() {
      if (document.hidden || inflight > 0 || paused) return;
      const data = queryClient.getQueryData<BoardData>(key);
      if (!data) return;
      const gen = writeGen;
      try {
        const head = await call<{rev: string}>('GET', `/boards/${boardId}/rev`);
        failures = 0;
        idle = head.rev === data.board.rev ? idle + 1 : 0;
        if (head.rev !== data.board.rev && inflight === 0 && !paused && gen === writeGen) {
          const delta = await call<Delta>('GET', `/boards/${boardId}/changes?since=${data.board.rev}`);
          if (inflight === 0 && !paused && gen === writeGen) {
            if (delta.truncated) await queryClient.invalidateQueries({queryKey: key});
            else queryClient.setQueryData<BoardData>(key, current => (current ? applyChanges(current, delta) : current));
          }
        }
      } catch (error) {
        failures = Math.min(failures + 1, 4);
        // Lost access (or the board is gone): reload so the screen shows its own answer.
        if (error instanceof ApiError && error.status === 401) {
          // Signed out: stop polling; the shell re-checks who is signed in and sends them to sign in.
          stopped = true;
          void queryClient.invalidateQueries({queryKey: ['me']});
          return;
        }
        if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
          stopped = true;
          void queryClient.invalidateQueries({queryKey: key});
          return;
        }
      }
    }

    const wake = () => {
      if (document.hidden || stopped || Date.now() - lastRun < 2000) return;
      window.clearTimeout(timer);
      idle = 0;
      void tick();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [boardId, queryClient]);
}
