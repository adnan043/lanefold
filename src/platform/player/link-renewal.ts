// Signed playback links run out. The platform's last
// clamp(1.2 × the video's length + 10 min, 30 min, 4 h) and say when
// (`expiresAt`). The player renews one ahead of time while it plays, and
// when the stream refuses a part (401, 403 or 410), then swaps the fresh
// link in at the same moment, playing or paused as it was. This file is
// the timing and the decisions, without React or the media, so it is tested
// on its own (link-renewal.test.ts); the engine wires it to the media.

// RENEW_EARLY_MS: how long before `expiresAt` a fresh link is asked for.
export const RENEW_EARLY_MS = 2 * 60 * 1000;
// At most this many renewals in RENEW_WINDOW_MS: more means something else is
// wrong (a clock far off, a link refused at once), and the player stops asking.
export const MAX_RENEWALS = 3;
export const RENEW_WINDOW_MS = 5 * 60 * 1000;

// PlaybackLink is a playing source and when it stops working.
export type PlaybackLink = {src: string; expiresAt?: string | number | null};

// linkLifetimeSeconds is how long the platform's link for a video of this
// length lasts: 1.2 × the length plus 10 minutes, at least 30 minutes and at
// most 4 hours. The player trusts `expiresAt`; this documents the rule.
export function linkLifetimeSeconds(lengthSeconds: number): number {
  const length = Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds : 0;
  return Math.min(4 * 3600, Math.max(30 * 60, Math.round(1.2 * length + 10 * 60)));
}

// expiryOf is `expiresAt` in epoch ms, or null when there is none or it
// isn't a date.
export function expiryOf(expiresAt: PlaybackLink['expiresAt']): number | null {
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return null;
  const ms = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  return Number.isFinite(ms) ? ms : null;
}

// renewDelay is how long from `now` to ask for a fresh link (0: now), or
// null for a link that doesn't run out.
export function renewDelay(
  expiresAt: PlaybackLink['expiresAt'],
  now: number,
  early = RENEW_EARLY_MS,
): number | null {
  const at = expiryOf(expiresAt);
  return at === null ? null : Math.max(0, at - early - now);
}

// refusedStatus is the HTTP status of a media error, when the engine knows it
// (hls.js puts the response on the error's data), else undefined.
export function refusedStatus(error: unknown): number | undefined {
  const e = error as {data?: {response?: {code?: unknown}}; status?: unknown} | null | undefined;
  const code = e?.data?.response?.code ?? e?.status;
  return typeof code === 'number' && code > 0 ? code : undefined;
}

// linkRefused: the error means the link stopped working. A 401, 403 or 410
// always does. A network error without a status (the browser's own HLS, as
// on Safari, never says) does only once the link is near its end; before
// that it is a real network problem and the player shows it.
export function linkRefused(
  error: unknown,
  expiresAt: PlaybackLink['expiresAt'],
  now: number,
): boolean {
  const status = refusedStatus(error);
  if (status !== undefined) return status === 401 || status === 403 || status === 410;
  const code = (error as {code?: unknown} | null | undefined)?.code;
  if (code !== 2) return false; // MediaError.MEDIA_ERR_NETWORK
  const delay = renewDelay(expiresAt, now);
  return delay !== null && delay === 0;
}

export type LinkRenewalOptions = {
  link: PlaybackLink;
  // Asks for a fresh link; null (or a throw) when there is none to have.
  renew: () => Promise<PlaybackLink | null>;
  // Plays the fresh link from where the old one was.
  swap: (link: PlaybackLink) => void;
  isPlaying: () => boolean;
  // Renewing failed or was asked for too often: the caller shows a problem.
  onGiveUp?: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export type LinkRenewal = {
  // The media started playing: a link that came due while paused is renewed now.
  played: () => void;
  // The media failed: a refused link is renewed (true), anything else is not (false).
  failed: (error: unknown) => boolean;
  // Asks for a fresh link now (one at a time).
  renewNow: () => Promise<void>;
  // The link in use.
  current: () => PlaybackLink;
  stop: () => void;
};

// Timers above this wait in steps: setTimeout fires at once past ~24.8 days.
const MAX_TIMER_MS = 2 ** 31 - 1;

// createLinkRenewal keeps one link fresh. While the media plays it renews
// RENEW_EARLY_MS before `expiresAt`; if it is paused then, it waits for the
// next play. A refused link (linkRefused) renews at once. One request at a
// time, at most MAX_RENEWALS in RENEW_WINDOW_MS.
export function createLinkRenewal(options: LinkRenewalOptions): LinkRenewal {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let link = options.link;
  let timer: unknown = null;
  let due = false;
  let pending: Promise<void> | null = null;
  let stopped = false;
  let recent: number[] = [];

  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    due = false;
    const delay = renewDelay(link.expiresAt, now());
    if (delay === null || stopped) return;
    const wait = Math.min(delay, MAX_TIMER_MS);
    timer = setTimer(() => {
      timer = null;
      if (renewDelay(link.expiresAt, now()) !== 0) return schedule();
      if (options.isPlaying()) void renewNow();
      else due = true;
    }, wait);
  };

  const giveUp = () => {
    stop();
    options.onGiveUp?.();
  };

  const renewNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    const at = now();
    recent = recent.filter((t) => at - t < RENEW_WINDOW_MS);
    if (recent.length >= MAX_RENEWALS) {
      giveUp();
      return Promise.resolve();
    }
    recent.push(at);
    due = false;
    pending = (async () => {
      let next: PlaybackLink | null = null;
      try {
        next = await options.renew();
      } catch {
        next = null;
      }
      if (stopped) return;
      if (!next?.src) return giveUp();
      link = next;
      options.swap(next);
      schedule();
    })().finally(() => {
      pending = null;
    });
    return pending;
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  schedule();
  return {
    played: () => {
      if (due || renewDelay(link.expiresAt, now()) === 0) void renewNow();
    },
    failed: (error) => {
      if (!linkRefused(error, link.expiresAt, now())) return false;
      void renewNow();
      return true;
    },
    renewNow,
    current: () => link,
    stop,
  };
}
