import {useQueryClient} from '@tanstack/react-query';
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
  }
}

/** True from drag start to drop/cancel: no delta is applied while a card or lane is held (the draft would jump). */
let paused = false;
export function pauseBoardSync(on: boolean) {
  paused = on;
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

    const schedule = () => {
      if (stopped) return;
      window.clearTimeout(timer);
      const delay = Math.min(MAX_MS, idleBaseMs(idle) * 2 ** failures) + Math.random() * 1000;
      timer = window.setTimeout(tick, delay);
    };

    async function tick() {
      if (stopped || running) return;
      running = true;
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
      if (document.hidden || stopped) return;
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
