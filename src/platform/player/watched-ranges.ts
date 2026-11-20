// Watched ranges: the stretches of a video a person actually played, in
// seconds. The course progress API merges them into distinct watched
// segments on the server, so clients report ranges,
// never a percentage.

export type WatchedRange = [start: number, end: number];

// Two ranges this close count as one (timeupdate fires every ~250 ms).
const joinGap = 0.5;

// mergeRanges sorts ranges and joins the ones that overlap or touch.
export function mergeRanges(ranges: readonly WatchedRange[]): WatchedRange[] {
  const sorted: WatchedRange[] = [];
  for (const r of ranges) {
    if (r[1] <= r[0]) continue;
    const at = sorted.findIndex((x) => x[0] > r[0]);
    sorted.splice(at < 0 ? sorted.length : at, 0, r);
  }
  const out: WatchedRange[] = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1] + joinGap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export type WatchTracker = {
  // observe records the position while playing; now is a wall clock in ms.
  observe: (time: number, rate: number, now: number) => void;
  // interrupt ends the current stretch (a seek, a pause, a source change).
  interrupt: () => void;
  // take returns the ranges watched since the last take and forgets them.
  take: () => WatchedRange[];
  // furthest is the latest position reached by playing, not by seeking.
  furthest: () => number;
};

// createWatchTracker follows playback. A step counts as watched only when
// the position moved forward by no more than the wall clock allows at the
// current rate, so a jump the media reports without a seeking event is
// never counted.
export function createWatchTracker(furthestWatched = 0): WatchTracker {
  let start: number | null = null;
  let last = 0;
  let lastAt = 0;
  let furthest = furthestWatched;
  let pending: WatchedRange[] = [];

  const close = () => {
    if (start !== null && last > start) pending.push([start, last]);
  };

  return {
    observe(time, rate, now) {
      const allowed = ((now - lastAt) / 1000) * Math.max(rate, 1) + joinGap;
      if (start !== null && time >= last && time - last <= allowed) {
        last = time;
        furthest = Math.max(furthest, last);
      } else {
        close();
        start = time;
        last = time;
      }
      lastAt = now;
    },
    interrupt() {
      close();
      start = null;
    },
    take() {
      close();
      if (start !== null) start = last;
      const out = mergeRanges(pending);
      pending = [];
      return out;
    },
    furthest: () => furthest,
  };
}
