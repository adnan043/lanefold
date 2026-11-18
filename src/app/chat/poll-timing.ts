/**
 * How often chat polls, as pure functions of how long the person has been away from the page (no DOM here, so the
 * rules are unit-tested). A hidden tab never polls at all: the timers check `document.hidden` and the tab coming back
 * polls at once, so being away costs nothing and coming back feels live.
 */

const MINUTE = 60_000;

/**
 * The pulse (which conversations moved). `fast` while a chat is on screen: every 3 s while the person is active,
 * 12 s after a minute without input, 30 s after five, 60 s after fifteen. Elsewhere (the unread badge) 30 s, 60 s
 * after fifteen idle minutes.
 */
export function pulseDelayMs(idleMs: number, fast: boolean): number {
  if (idleMs >= 15 * MINUTE) return 60_000;
  if (!fast || idleMs >= 5 * MINUTE) return 30_000;
  return idleMs >= MINUTE ? 12_000 : 3000;
}

/**
 * The open list's window refresh (edits, deletes and reactions that `after` cannot see): every 20 s while the person
 * is active, 60 s after a minute without input, 3 minutes after five.
 */
export function windowDelayMs(idleMs: number): number {
  if (idleMs >= 5 * MINUTE) return 3 * MINUTE;
  return idleMs >= MINUTE ? MINUTE : 20_000;
}
