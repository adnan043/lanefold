import {useCallback, useInsertionEffect, useRef} from 'react';

// useEffectEvent is React 19.2's hook of the same name for React 18 as well
// (the dashboard runs 18, sites run 19): a function that always calls the
// latest render's `fn`, for effects and handlers only, never during render.
// Like React's, it is left out of effect dependencies.
export function useEffectEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useInsertionEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
