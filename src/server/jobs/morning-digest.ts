import type {PrismaClient} from '../../generated/prisma/client';
import {config} from '../../platform/config';
import {getEntitlements} from '../entitlements';
import {escapeHtml} from '../mail/templates';
import {mailCredentials, sendMail} from '../mail/send';

/**
 * MORNING DIGEST: the job behind the hourly schedule `morning-digest` (background.json). One message per person
 * per day: what is due today, what is overdue, and the mentions and assignments they have not read.
 *
 * DESIGN
 *  - Opt-in, default OFF. The person picks a LOCAL hour 5 to 12 in Settings > Notifications (`user_profiles.digest_hour`,
 *    CHECK in the migration) and their browser's IANA time zone is stored with it (`digest_tz`, checked when saved).
 *    No stored zone reads as UTC. The profile's `timezone` column is not used: nothing sets it.
 *  - A person is DUE when their local hour is at least the chosen hour (and at most `LATEST_HOUR`, so a digest never
 *    arrives in the evening) and they have not been handled for their local day (`digest_last_on`). The local hour and
 *    day are worked out here with Intl (an unknown zone falls back to UTC), not in SQL, so a bad zone can never break
 *    a whole page.
 *  - ONE SQL statement per page of people does everything and is atomic: it CLAIMS the day (`UPDATE ... digest_last_on`),
 *    reads the content for the people it claimed, and inserts the `digest` notification (kind `digest`, no board, no
 *    card, system actor) plus its numbers (`digests`). A run that overlaps, or runs twice, claims nothing the second
 *    time. A person with nothing to say has the day claimed and gets NO notification: an empty digest is never made.
 *  - CONTENT (only for cards and notifications the person may still see: active workspace member, a seat on a private
 *    board, only the owner on a personal Inbox, board and workspace not archived, workspace not read-only):
 *      due today    = their cards (assigned or followed, not done, not archived) due on their local day;
 *      overdue      = the same, due in the 90 days before it (older ones are stale, not "stuck"), and the oldest 5 are listed;
 *      mentions     = their unread `mentioned`, `message_mention` and `assigned` notifications newer than the last digest
 *                     (at most 7 days back), in boards and chats they can still reach.
 *    The notification carries counts and up to 15 card ids (oldest overdue first, then due today). NEVER a title, a
 *    name or an address: the bell and My Day show the details to the person who may see them.
 *  - The notification sits in the workspace where most of the items are (ties: the lowest id).
 *  - EMAIL: only for someone who also turned notification emails on (`email_notify_mode` digest or immediate), is
 *    active and verified, and only when the owner set up mail (no secrets: in-app only, no error). One email per
 *    person per day with COUNTS only (no names, titles or addresses), idempotency key `digest-<user>-<day>`. A send
 *    that fails is logged and not retried: the in-app digest is the record.
 *  - BOUNDED: people are read by keyset on the user id (200 a page, at most `MAX_PEOPLE_SCAN` per run), the due ones
 *    are handled `BATCH` at a time (one statement per batch, no query per person), 40 s budget, at most 5 mails at once.
 */
export const MORNING_DIGEST_LIST = 'morning-digest';
export const MIN_HOUR = 5;
export const MAX_HOUR = 12;
/** A digest is never made after this local hour: a morning digest in the evening is noise. */
export const LATEST_HOUR = 14;
export const PEOPLE_PAGE = 200;
export const MAX_PEOPLE_SCAN = 5000;
export const BATCH = 50;
export const RUN_BUDGET_MS = 40_000;
/** Overdue cards older than this many days are not "stuck", they are forgotten: not counted. */
export const OVERDUE_DAYS = 90;
/** Mentions older than this are never counted, even for a first digest. */
export const MENTION_DAYS = 7;
const DAY = 86_400_000;

export type DigestResult = {scanned: number; due: number; made: number; emailed: number};

/** Pure: is `tz` a time zone Intl knows? */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: tz});
    return true;
  } catch {
    return false;
  }
}

/** Pure: the local calendar day (`YYYY-MM-DD`) and hour (0 to 23) at `now` in `tz` (UTC when the zone is unknown). */
export function localParts(now: Date, tz: string | null): {day: string; hour: number} {
  const zone = tz && validTimeZone(tz) ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'}).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const hour = Number(get('hour'));
  return {day: `${get('year')}-${get('month')}-${get('day')}`, hour: hour === 24 ? 0 : hour};
}

/** Pure: is this person due a digest now? `lastOn` is the local day last handled (`YYYY-MM-DD`) or null. */
export function digestDue(opts: {hour: number | null; tz: string | null; lastOn: string | null}, now: Date): {due: boolean; day: string} {
  const local = localParts(now, opts.tz);
  if (opts.hour === null || opts.hour < MIN_HOUR || opts.hour > MAX_HOUR) return {due: false, day: local.day};
  if (opts.lastOn !== null && opts.lastOn >= local.day) return {due: false, day: local.day};
  return {due: local.hour >= opts.hour && local.hour <= LATEST_HOUR, day: local.day};
}

type Person = {user_id: number; digest_hour: number | null; digest_tz: string | null; last_on: string | null; sent_at: Date | null};
type Made = {user_id: number; due: number; overdue: number; mentions: number; day: string};

export async function runMorningDigest(db: PrismaClient, now: Date = new Date()): Promise<DigestResult> {
  const started = Date.now();
  const result: DigestResult = {scanned: 0, due: 0, made: 0, emailed: 0};
  const frozenMemo = new Map<number, boolean>();
  const mentionFloor = now.getTime() - MENTION_DAYS * DAY;
  const made: Made[] = [];
  let cursor = 0;
  while (result.scanned < MAX_PEOPLE_SCAN && Date.now() - started < RUN_BUDGET_MS) {
    // One query per page: opted-in people only (indexed by digest_hour), keyset on the user id.
    const people = await db.$queryRaw<Person[]>`
      SELECT p.user_id, p.digest_hour::int AS digest_hour, p.digest_tz, p.digest_last_on::text AS last_on, p.digest_sent_at AS sent_at
      FROM user_profiles p
      WHERE p.digest_hour IS NOT NULL AND p.user_id > ${cursor}::int
      ORDER BY p.user_id
      LIMIT ${PEOPLE_PAGE}`;
    if (people.length === 0) break;
    result.scanned += people.length;
    cursor = people[people.length - 1]!.user_id;
    const due = people
      .map(p => ({p, d: digestDue({hour: p.digest_hour, tz: p.digest_tz, lastOn: p.last_on}, now)}))
      .filter(x => x.d.due);
    result.due += due.length;
    for (let i = 0; i < due.length && Date.now() - started < RUN_BUDGET_MS; i += BATCH) {
      const batch = due.slice(i, i + BATCH);
      try {
        made.push(...(await makePage(db, batch, now, mentionFloor, frozenMemo)));
      } catch (error) {
        // The message only. The statement is atomic, so nothing of this batch was claimed: the next run tries again.
        console.error(`morning-digest batch after user ${cursor}: ${(error as Error).message}`);
      }
    }
    if (people.length < PEOPLE_PAGE) break;
  }
  result.made = made.length;
  result.emailed = await emailDigests(db, made, started);
  return result;
}

async function frozenIn(db: PrismaClient, userIds: number[], memo: Map<number, boolean>): Promise<number[]> {
  const rows = await db.$queryRaw<{workspace_id: number}[]>`
    SELECT DISTINCT m.workspace_id FROM workspace_members m WHERE m.user_id = ANY(${userIds}::int[])`;
  const frozen: number[] = [];
  for (const {workspace_id: id} of rows) {
    let value = memo.get(id);
    if (value === undefined) {
      const ent = await getEntitlements(db, id);
      value = !ent || ent.readOnly;
      memo.set(id, value);
    }
    if (value) frozen.push(id);
  }
  return frozen;
}

/**
 * Claim the day for these people and make the digests of those who have something to say, in ONE statement.
 * Returns who got one, with the counts (for the email).
 */
async function makePage(db: PrismaClient, batch: {p: Person; d: {day: string}}[], now: Date, mentionFloor: number, memo: Map<number, boolean>): Promise<Made[]> {
  const ids = batch.map(x => x.p.user_id);
  const days = batch.map(x => x.d.day);
  const since = batch.map(x => new Date(Math.max(x.p.sent_at?.getTime() ?? 0, mentionFloor)).toISOString());
  const frozen = await frozenIn(db, ids, memo);
  const nowIso = now.toISOString();
  return db.$queryRaw<Made[]>`
    WITH input AS (
      SELECT * FROM unnest(${ids}::int[], ${days}::date[], ${since}::timestamptz[]) AS t(user_id, local_day, since)
    ),
    claimed AS (
      UPDATE user_profiles p SET digest_last_on = i.local_day, digest_sent_at = ${nowIso}::timestamptz
      FROM input i JOIN users u ON u.id = i.user_id AND u.status = 'active'
      WHERE p.user_id = i.user_id AND p.digest_hour IS NOT NULL
        AND (p.digest_last_on IS NULL OR p.digest_last_on < i.local_day)
      RETURNING p.user_id, i.local_day, i.since
    ),
    people AS (
      SELECT m.card_id, m.user_id FROM card_members m JOIN claimed cl ON cl.user_id = m.user_id
      UNION
      SELECT w.card_id, w.user_id FROM card_watchers w JOIN claimed cl ON cl.user_id = w.user_id
    ),
    items AS (
      SELECT cl.user_id, c.id AS card_id, c.workspace_id, c.due_date, cl.local_day,
        row_number() OVER (PARTITION BY cl.user_id, (c.due_date < cl.local_day) ORDER BY c.due_date, c.id) AS rn
      FROM people p
      JOIN claimed cl ON cl.user_id = p.user_id
      JOIN cards c ON c.id = p.card_id AND c.archived_at IS NULL AND c.completed_at IS NULL
        AND c.due_date IS NOT NULL AND c.due_date <= cl.local_day AND c.due_date >= cl.local_day - ${OVERDUE_DAYS}::int
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id AND b.archived_at IS NULL
      JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL AND NOT (w.id = ANY(${frozen}::int[]))
      JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = cl.user_id
      WHERE (b.inbox_of IS NULL OR b.inbox_of = cl.user_id)
        AND (b.visibility <> 'private' OR m.role IN ('owner', 'admin')
             OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = cl.user_id))
    ),
    card_sum AS (
      SELECT user_id,
        (count(*) FILTER (WHERE due_date = local_day))::int AS due,
        (count(*) FILTER (WHERE due_date < local_day))::int AS overdue,
        array_agg(card_id ORDER BY (due_date = local_day), due_date, card_id)
          FILTER (WHERE (due_date < local_day AND rn <= 5) OR (due_date = local_day AND rn <= 10)) AS cards
      FROM items GROUP BY user_id
    ),
    mentions AS (
      SELECT n.user_id, n.workspace_id
      FROM notifications n
      JOIN claimed cl ON cl.user_id = n.user_id
      JOIN workspaces w ON w.id = n.workspace_id AND w.archived_at IS NULL AND NOT (w.id = ANY(${frozen}::int[]))
      JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = n.user_id
      WHERE n.read_at IS NULL AND n.kind IN ('mentioned', 'message_mention', 'assigned') AND n.created_at > cl.since
        AND (n.board_id IS NULL OR EXISTS (
          SELECT 1 FROM boards b
          WHERE b.id = n.board_id AND b.workspace_id = n.workspace_id AND b.archived_at IS NULL
            AND (b.inbox_of IS NULL OR b.inbox_of = n.user_id)
            AND (b.visibility <> 'private' OR m.role IN ('owner', 'admin')
                 OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = n.user_id))))
        AND (n.conversation_id IS NULL OR EXISTS (
          SELECT 1 FROM conversations cv
          WHERE cv.id = n.conversation_id AND cv.workspace_id = n.workspace_id
            AND (cv.kind = 'channel'
              OR (cv.kind = 'board' AND cv.board_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM boards b2
                    WHERE b2.id = cv.board_id AND b2.workspace_id = n.workspace_id AND b2.archived_at IS NULL
                      AND (b2.inbox_of IS NULL OR b2.inbox_of = n.user_id)
                      AND (b2.visibility <> 'private' OR m.role IN ('owner', 'admin')
                           OR EXISTS (SELECT 1 FROM board_members bm2 WHERE bm2.board_id = b2.id AND bm2.user_id = n.user_id))))
              OR (cv.kind NOT IN ('channel', 'board')
                  AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = cv.id AND cm.user_id = n.user_id)))))
    ),
    mention_sum AS (SELECT user_id, count(*)::int AS c FROM mentions GROUP BY user_id),
    spread AS (
      SELECT user_id, workspace_id, count(*) AS c FROM items GROUP BY user_id, workspace_id
      UNION ALL
      SELECT user_id, workspace_id, count(*) AS c FROM mentions GROUP BY user_id, workspace_id
    ),
    best AS (
      SELECT DISTINCT ON (user_id) user_id, workspace_id
      FROM (SELECT user_id, workspace_id, sum(c) AS total FROM spread GROUP BY user_id, workspace_id) s
      ORDER BY user_id, total DESC, workspace_id
    ),
    summary AS (
      SELECT cl.user_id, cl.local_day, COALESCE(cs.due, 0) AS due, COALESCE(cs.overdue, 0) AS overdue,
        COALESCE(ms.c, 0) AS mentions, COALESCE(cs.cards, ARRAY[]::int[]) AS cards, bt.workspace_id
      FROM claimed cl
      JOIN best bt ON bt.user_id = cl.user_id
      LEFT JOIN card_sum cs ON cs.user_id = cl.user_id
      LEFT JOIN mention_sum ms ON ms.user_id = cl.user_id
    ),
    notif AS (
      INSERT INTO notifications (user_id, workspace_id, kind, actor_id, board_id, card_id)
      SELECT user_id, workspace_id, 'digest', NULL, NULL, NULL FROM summary
      RETURNING id, user_id
    ),
    made AS (
      INSERT INTO digests (notification_id, user_id, day, due_count, overdue_count, mention_count, card_ids)
      SELECT nf.id, s.user_id, s.local_day, s.due, s.overdue, s.mentions, s.cards
      FROM notif nf JOIN summary s ON s.user_id = nf.user_id
      ON CONFLICT (user_id, day) DO NOTHING
      RETURNING user_id
    )
    SELECT s.user_id, s.due::int AS due, s.overdue::int AS overdue, s.mentions::int AS mentions, s.local_day::text AS day
    FROM summary s JOIN made ON made.user_id = s.user_id`;
}

/** Pure: the email for one digest. Counts only: no names, titles or addresses go in. */
export function renderDigestEmail(counts: {due: number; overdue: number; mentions: number}, link: string): {subject: string; text: string; html: string} {
  const part = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  const bits: string[] = [];
  if (counts.due > 0) bits.push(part(counts.due, 'card due today', 'cards due today'));
  if (counts.overdue > 0) bits.push(part(counts.overdue, 'overdue card', 'overdue cards'));
  if (counts.mentions > 0) bits.push(part(counts.mentions, 'unread mention or assignment', 'unread mentions and assignments'));
  const summary = bits.join(', ');
  const subject = `Your Lanefold morning: ${summary}`;
  const text = [`Good morning. In Lanefold you have ${summary}.`, '', `Open My Day: ${link}`, '', 'You get this because you turned on the morning digest. Switch it off in Settings > Notifications.', 'This is an automated message. Replies are not read.'].join('\n');
  const html = `<p>Good morning. In Lanefold you have ${escapeHtml(summary)}.</p><p><a href="${escapeHtml(link)}">Open My Day</a></p><p style="color:#666;font-size:13px">You get this because you turned on the morning digest. Switch it off in Settings &gt; Notifications.<br>This is an automated message. Replies are not read.</p>`;
  return {subject, text, html};
}

/** One email per person who made a digest AND has notification emails on. In-app only when mail is not set up. */
async function emailDigests(db: PrismaClient, made: Made[], started: number): Promise<number> {
  const creds = mailCredentials();
  const origin = config.siteUrl;
  if (!creds || !origin || made.length === 0) return 0;
  const ids = made.map(m => m.user_id);
  const recipients = await db.$queryRaw<{id: number; email: string}[]>`
    SELECT u.id, u.email
    FROM users u JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = ANY(${ids}::int[]) AND u.status = 'active' AND u.email_verified_at IS NOT NULL
      AND p.email_notify_mode IN ('digest', 'immediate')`;
  const byId = new Map(made.map(m => [m.user_id, m]));
  const link = `${origin.replace(/\/+$/, '')}/app/my-day`;
  let sent = 0;
  for (let i = 0; i < recipients.length && Date.now() - started < RUN_BUDGET_MS + 15_000; i += 5) {
    const chunk = recipients.slice(i, i + 5);
    const results = await Promise.all(
      chunk.map(async r => {
        const m = byId.get(r.id);
        if (!m) return false;
        const mail = renderDigestEmail(m, link);
        const out = await sendMail({to: r.email, subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: `digest-${r.id}-${m.day}`}, creds);
        if (out.kind !== 'sent') console.warn('[morning-digest] mail not delivered', r.id, out.kind);
        return out.kind === 'sent';
      }),
    );
    sent += results.filter(Boolean).length;
  }
  return sent;
}
