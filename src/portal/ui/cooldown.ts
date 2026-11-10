import {useCallback, useEffect, useRef, useState} from 'react';

import {extendUntil, secondsLeft} from '../../lib/cooldown';

/**
 * Keeps an action disabled until the server's `Retry-After` has elapsed after a 429 (cap 60 s).
 * `note(error)` after a failed call; `blocked` goes into `disabled`. Other errors change nothing.
 */
export function useCooldown() {
  const until = useRef(0);
  const [left, setLeft] = useState(0);

  const note = useCallback((error: unknown) => {
    until.current = extendUntil(until.current, error, Date.now());
    setLeft(secondsLeft(until.current, Date.now()));
  }, []);

  // An interval, not a timeout keyed on `left`: a tick that computes the same number would not re-render, and the countdown would stall.
  const running = left > 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setLeft(secondsLeft(until.current, Date.now())), 500);
    return () => clearInterval(timer);
  }, [running]);

  return {blocked: left > 0, secondsLeft: left, note};
}
