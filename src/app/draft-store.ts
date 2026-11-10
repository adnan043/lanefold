/** Pure parts of the draft keeper: text a person typed and has not sent yet, in sessionStorage, for one tab and 24 hours. */

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const DRAFT_MAX = 20000;
const PREFIX = 'lf:draft:';

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export type DraftKind = 'desc' | 'comment' | 'item' | 'lane' | 'cedit' | 'itemedit' | 'checklist' | 'newlist' | 'title' | 'board' | 'sfname' | 'wsname' | 'newboard' | 'capture' | 'label' | 'chat' | 'reply';

/** One key per user + workspace + kind + object id, so one person's or one card's text never lands in another field or account. */
export function draftKey(workspaceId: number, kind: DraftKind, id: number, userId = 0): string {
  return `${PREFIX}u${userId}:${workspaceId}:${kind}:${id}`;
}

/** Removes every draft (sign-out). */
export function clearAllDrafts(storage: DraftStorage | null): void {
  try {
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Ignore.
  }
}

export function browserStorage(): DraftStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps only the typed text and when it was kept. An empty text removes the draft. */
export function saveDraft(storage: DraftStorage | null, key: string, text: string, now = Date.now()): void {
  try {
    if (!storage) return;
    if (!text.trim() || text.length > DRAFT_MAX) return storage.removeItem(key);
    storage.setItem(key, JSON.stringify({t: text, at: now}));
  } catch {
    // Storage full or blocked: the draft is simply not kept.
  }
}

export function clearDraft(storage: DraftStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

/** The kept text, or null when there is none, it is older than 24 h, or it is not what we wrote (then it is removed). */
export function loadDraft(storage: DraftStorage | null, key: string, now = Date.now()): string | null {
  try {
    if (!storage) return null;
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const entry = parsed as {t?: unknown; at?: unknown} | null;
    if (entry && typeof entry.t === 'string' && typeof entry.at === 'number' && entry.t.trim() && now - entry.at >= 0 && now - entry.at < DRAFT_TTL_MS) {
      return entry.t.length <= DRAFT_MAX ? entry.t : null;
    }
    storage.removeItem(key);
    return null;
  } catch {
    clearDraft(storage, key);
    return null;
  }
}

/** The text to put back: only into a field still holding what it started with (never over what was typed since). */
export function restoreDraft(current: string, baseline: string, stored: string | null): string | null {
  if (stored === null || current !== baseline || stored === baseline) return null;
  return stored;
}

/** Removes every expired or unreadable draft (run once per page load). */
export function pruneDrafts(storage: DraftStorage | null, now = Date.now()): void {
  try {
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) loadDraft(storage, key, now);
  } catch {
    // Ignore.
  }
}
