import {siteFetch} from '../platform/browser';
import {codeForStatus, parseRetryAfter} from './resilience';

/**
 * The Lanefold client's one way to call the Site API. Like the portal's `read()`, but it keeps the
 * server's error `code` and `fieldCodes`, so `useI18n().errorMessage(error)` can answer in the user's language.
 * Every call goes through `siteFetch` (CSRF header, one session refresh).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly fields: Record<string, string> = {},
    readonly fieldCodes: Record<string, string> = {},
    /** Seconds the server asked us to wait (429 / 503 `Retry-After`). */
    readonly retryAfter?: number
  ) {
    super(message);
  }
}

type ErrorBody = {error?: string; message?: string; fields?: Record<string, string>; fieldCodes?: Record<string, string>} | null;

export async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await siteFetch(`/site-api${path}`, {
      method,
      ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}),
    });
  } catch {
    throw new ApiError('We could not reach the server.', 0, 'network');
  }
  const data = (await res.json().catch(() => null)) as (ErrorBody & T) | null;
  if (!res.ok) {
    // A bare status (managed guard, proxy, platform outage) still maps to an `errors.*` key.
    throw new ApiError(
      data?.message ?? `Request failed (${res.status})`,
      res.status,
      data?.error ?? codeForStatus(res.status),
      data?.fields,
      data?.fieldCodes,
      parseRetryAfter(res.headers.get('retry-after'))
    );
  }
  return data as T;
}

/** Wire shapes (`src/server/routes/boards.ts`). Revisions are strings (bigint). */
export type WorkspaceT = {id: number; name: string; slug: string; plan: string; memberCount: number; role: string};
export type BoardSummary = {
  id: number;
  name: string;
  visibility: string;
  bgKind: string;
  bgColor1: string;
  bgColor2: string;
  bgAngle: number;
  bgPattern: string;
  /** The uploaded background photo's address (`/site-api/boards/:id/background?v=`), or null. Shown when `bgKind` is `image`. */
  bgImage?: string | null;
  starred: boolean;
};
export type CardT = {
  id: number;
  /** Short number within the board (#42); null for a card made before numbers existed. */
  number?: number | null;
  laneId: number;
  title: string;
  position: string;
  priority: string;
  dueDate: string | null;
  /** Optional start day and creation day (`YYYY-MM-DD`): the Timeline draws start-to-due bars from them. */
  startDate?: string | null;
  createdAt?: string;
  completed: boolean;
  checklistTotal: number;
  checklistDone: number;
  commentCount: number;
  attachmentCount: number;
  archived: boolean;
  rev?: string;
  /** Card face extras (the board answer only; a card patch never carries them, so they survive a merge). */
  labels?: {id: number; name: string; colorHex: string}[];
  labelCount?: number;
  members?: {id: number; name: string}[];
  memberCount?: number;
  coverAttachmentId?: number | null;
};
export type LaneT = {
  id: number;
  name: string;
  position: string;
  colorHex: string | null;
  wipLimit: number | null;
  cardCount: number;
  collapsed: boolean;
  archived: boolean;
  rev: string;
  /** This person's own flags (the board answer only; a delta never carries them, so they survive a merge). */
  pinned?: boolean;
  watching?: boolean;
  cards: CardT[];
  /** False for a lane the answer left empty (the card cap): it loads its first cards when shown. */
  loaded: boolean;
  hasMore: boolean;
};
export type BoardT = {
  id: number;
  workspaceId: number;
  name: string;
  visibility: string;
  bgKind: string;
  bgColor1: string;
  bgColor2: string;
  bgAngle: number;
  bgPattern: string;
  /** The uploaded background photo's address, or null. Shown when `bgKind` is `image`. */
  bgImage?: string | null;
  archived: boolean;
  rev: string;
  starred: boolean;
  role: 'admin' | 'member' | 'viewer';
  canWrite: boolean;
  canAdmin: boolean;
  /** Not a member of the board's workspace: sees only the boards they were added to (no chat, search or workspace pages). */
  guest?: boolean;
};
export type BoardData = {board: BoardT; lanes: LaneT[]};
/** The board fields a delta carries (name, visibility, background, and the caller's own role). */
export type BoardDelta = Pick<BoardT, 'name' | 'visibility' | 'bgKind' | 'bgColor1' | 'bgColor2' | 'bgAngle' | 'bgPattern' | 'bgImage' | 'role' | 'canWrite' | 'canAdmin'>;
export type Delta = {rev: string; archived: boolean; truncated: boolean; board?: BoardDelta; lanes: Omit<LaneT, 'cards' | 'loaded' | 'hasMore'>[]; cards: CardT[]};

/** `GET /site-api/memberships` rows (`src/server/routes/checkout.ts`). `workspaceId` scopes a row to a workspace's plan. */
export type MembershipT = {
  subscriptionId: string;
  priceKey: string;
  mode: string;
  status: string;
  workspaceId?: number | null;
  currentPeriodEnd: string | null;
  accessEndsAt: string | null;
};

/** `api.<route>`: the memberships calls, typed once. */
export const api = {
  memberships: {
    list: () => call<{memberships: MembershipT[]}>('GET', '/memberships').then(r => r.memberships),
    cancel: (subscriptionId: string, atPeriodEnd = true) =>
      call<{ok: true; accessEndsAt: string | null}>('POST', `/memberships/${encodeURIComponent(subscriptionId)}/cancel`, {atPeriodEnd}),
  },
};
