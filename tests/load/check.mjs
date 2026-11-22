// Data-consistency check of the load-test data, run AFTER a k6 level (local database only).
//
//   node --env-file=.env tests/load/check.mjs [--since <ISO time>] [--sent <chat_sent_ok from k6>]
//
// Prints JSON: every count should be 0 (lostMessages compares what k6 was told was sent with what is stored).
import pg from 'pg';

const url = process.env.DATABASE_URL || '';
if (!/^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('Refusing: DATABASE_URL must be a local database.');
const arg = name => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const since = arg('--since') || '1970-01-01';
const sent = arg('--sent') === undefined ? null : Number(arg('--sent'));

const db = new pg.Client({connectionString: url});
await db.connect();
const one = async sql => (await db.query(sql, sql.includes('$1') ? [since] : [])).rows[0];
const LT_BOARDS = `SELECT b.id FROM boards b JOIN workspaces w ON w.id = b.workspace_id WHERE w.name LIKE 'LT-%'`;
const LT_CONVS = `SELECT c.id FROM conversations c JOIN workspaces w ON w.id = c.workspace_id WHERE w.name LIKE 'LT-%'`;

const out = {
  // A lane's stored card_count differs from its real number of open cards.
  laneCountDrift: (await one(`
    SELECT count(*)::int AS n FROM lanes l
    WHERE l.board_id IN (${LT_BOARDS}) AND l.archived_at IS NULL
      AND l.card_count <> (SELECT count(*) FROM cards c WHERE c.lane_id = l.id AND c.archived_at IS NULL)`)).n,
  // Two open cards share one position in a lane (their order is undefined).
  duplicatePositions: (await one(`
    SELECT count(*)::int AS n FROM (
      SELECT lane_id, position FROM cards WHERE board_id IN (${LT_BOARDS}) AND archived_at IS NULL
      GROUP BY lane_id, position HAVING count(*) > 1) d`)).n,
  // A card points at a lane of another board.
  cardLaneMismatch: (await one(`
    SELECT count(*)::int AS n FROM cards c JOIN lanes l ON l.id = c.lane_id
    WHERE c.board_id IN (${LT_BOARDS}) AND l.board_id <> c.board_id`)).n,
  // A board's revision is behind a row it covers (a poll could miss that change).
  revBehind: (await one(`
    SELECT count(*)::int AS n FROM boards b
    WHERE b.id IN (${LT_BOARDS}) AND b.rev < GREATEST(
      (SELECT coalesce(max(updated_rev), 0) FROM cards WHERE board_id = b.id),
      (SELECT coalesce(max(updated_rev), 0) FROM lanes WHERE board_id = b.id))`)).n,
  // Message numbers per chat: a hole, or last_seq not the highest one.
  seqGaps: (await one(`
    SELECT count(*)::int AS n FROM conversations c
    WHERE c.id IN (${LT_CONVS}) AND c.last_seq <> coalesce((SELECT max(seq) FROM messages m WHERE m.conversation_id = c.id), 0)
       OR (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) <> c.last_seq`)).n,
  // The same test message (sender VU + its sequence) stored twice.
  duplicateMessages: (await one(`
    SELECT count(*)::int AS n FROM (
      SELECT conversation_id, substring(body_md from '\\[lt v=\\d+ s=\\d+') AS k FROM messages
      WHERE conversation_id IN (${LT_CONVS}) AND body_md LIKE '%[lt v=%' AND created_at >= $1
      GROUP BY 1, 2 HAVING count(*) > 1) d`)).n,
  // A workspace's stored member_count differs from its member rows.
  memberCountDrift: (await one(`
    SELECT count(*)::int AS n FROM workspaces w
    WHERE w.name LIKE 'LT-%' AND w.member_count <> (SELECT count(*) FROM workspace_members m WHERE m.workspace_id = w.id)`)).n,
};
const stored = (await one(`SELECT count(*)::int AS n FROM messages WHERE conversation_id IN (${LT_CONVS}) AND body_md LIKE '%[lt v=%' AND created_at >= $1`)).n;
out.messagesStored = stored;
if (sent !== null) out.lostMessages = Math.max(0, sent - stored);
await db.end();
console.log(JSON.stringify(out));
