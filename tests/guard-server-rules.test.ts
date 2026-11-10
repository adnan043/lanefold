import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Static guard for AGENTS.md "Production rules" / "Never" over src/server/** (ts only).
 * Heuristic text scans: they catch regressions, not every possible shape. A hit that is fine goes in an
 * allowlist below WITH a reason; never loosen a regex to silence one.
 */
const ROOT = join(__dirname, '..');
const SERVER = join(ROOT, 'src', 'server');

function walk(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}
const files = walk(SERVER).map(p => ({path: p, rel: relative(ROOT, p).replace(/\\/g, '/')}));

/** Source with comments blanked (same length, so offsets and line numbers hold) and string/template contents kept. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let q: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    const two = src.slice(i, i + 2);
    if (q) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === q) q = null;
      i++;
    } else if (two === '//') {
      while (i < src.length && src[i] !== '\n') out += ' ', i++;
    } else if (two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') out += src[i] === '\n' ? '\n' : ' ', i++;
      out += '  ';
      i += 2;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') q = ch;
      out += ch;
      i++;
    }
  }
  return out;
}

const code = new Map(files.map(f => [f.rel, stripComments(readFileSync(f.path, 'utf8'))]));
const lineOf = (text: string, idx: number) => text.slice(0, idx).split('\n').length;

/** The text of the call whose "(" is at `open` (balanced; strings and templates skipped). */
function callText(text: string, open: number): string {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '\\') i++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

type Hit = string;
function scan(re: RegExp, filter?: (rel: string, text: string, m: RegExpExecArray) => boolean): Hit[] {
  const hits: Hit[] = [];
  for (const [rel, text] of code) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      if (!filter || filter(rel, text, m as RegExpExecArray)) hits.push(`${rel}:${lineOf(text, m.index!)}  ${m[0].trim()}`);
    }
  }
  return hits;
}
/** An allowlist key is `file` (any line: robust to edits) or `file:line`. */
const unlisted = (hits: Hit[], allow: Record<string, string>) =>
  hits.filter(h => {
    const at = h.split('  ')[0]!;
    return !allow[at] && !allow[at.slice(0, at.lastIndexOf(':'))];
  });

describe('server guard: SQL', () => {
  it('no $queryRawUnsafe / $executeRawUnsafe / Prisma.raw(', () => {
    expect(scan(/\$queryRawUnsafe|\$executeRawUnsafe|Prisma\.raw\s*\(/)).toEqual([]);
  });

  it('$queryRaw / $executeRaw are always the tagged template (no call parenthesis, no string-built SQL)', () => {
    // `$queryRaw(` or `$queryRaw<T>(` is the untagged form; `${...}` inside a tagged template is fine.
    expect(scan(/\$(?:queryRaw|executeRaw)\s*(?:<[^`]*?>)?\s*\(/)).toEqual([]);
    // a template literal assembled in a variable and passed in later
    expect(scan(/\$(?:queryRaw|executeRaw)\s*(?:<[^`]*?>)?\s*(?!`|\s*<)[A-Za-z_(]/)).toEqual([]);
  });

  it('SQL is never built with string concatenation or sql-looking strings joined with +', () => {
    expect(scan(/['"]\s*(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^'"]*['"]\s*\+/i)).toEqual([]);
  });
});

describe('server guard: queries', () => {
  /** findMany with no `take`: file:line -> why it is bounded by construction. */
  const FINDMANY_UNBOUNDED: Record<string, string> = {};

  it('every findMany has a take', () => {
    const hits = scan(/\.findMany\(/, (rel, text, m) => !/\btake\b/.test(callText(text, m.index! + m[0].length - 1)));
    expect(unlisted(hits, FINDMANY_UNBOUNDED)).toEqual([]);
  });

  it('no offset paging (skip:/offset:/OFFSET)', () => {
    const hits = scan(/\bskip\s*:|\boffset\s*:|\bOFFSET\s+\$\{|\bOFFSET\s+\d/);
    expect(unlisted(hits, {'src/server/mail/templates.ts': 'a String.replace callback parameter named offset, not paging'})).toEqual([]);
  });

  /** Prisma .count( in a list/overview route: file:line -> why it is bounded. */
  const COUNT_ALLOWED: Record<string, string> = {
    'src/server/routes/board-extras.ts': 'lane limit check inside a transaction, scoped by workspace + board',
    'src/server/routes/boards.ts': 'limit checks inside transactions (owned workspaces, lanes), scoped and index-backed',
    'src/server/routes/card-fields.ts': 'per-board field limit and per-field option limit checks inside a transaction, after the board row lock, scoped by workspace',
    'src/server/routes/card-detail.ts': 'per-card/per-board limit checks (labels, checklist items, attachments) and a per-user comment rate limit on an index',
    'src/server/routes/chat-extras.ts': 'per-message card-ref limit check under a row lock',
    'src/server/routes/card-recurrence.ts': 'per-workspace enabled-rule cap inside the save transaction, scoped by workspace',
    'src/server/routes/card-templates.ts': 'per-card checklist cap and per-workspace template cap inside transactions (advisory lock), scoped by workspace',
    'src/server/routes/flows.ts': 'flow caps inside the create transaction (workspace row lock) and the plan cap shown on the list: workspace-scoped, tiny, indexed, bounded by the plan limit',
    'src/server/routes/import-export.ts': 'idempotency check by importId inside the import transaction',
    'src/server/routes/lane-actions.ts': 'lane limit check inside the copy transaction, after the board row lock, scoped by workspace + board',
    'src/server/routes/members.ts': 'last-owner check inside the transaction',
    'src/server/routes/saved-filters.ts': 'per-user per-board and per-board shared limit checks under advisory locks; id checks count at most 20 listed ids against the board/workspace',
  };
  it('no Prisma count() in list / overview routes (bounded counts go in a LIMITed raw subquery)', () => {
    const hits = scan(/\.count\(/, rel => rel.startsWith('src/server/routes/'));
    expect(unlisted(hits, COUNT_ALLOWED)).toEqual([]);
  });

  it('no request body spread or passed whole into prisma data', () => {
    const whole = scan(/\bdata\s*:\s*(?:body|input|payload|c\.req\.valid\([^)]*\))\s*[,}]/);
    expect(unlisted(whole, {'src/server/routes/card-detail.ts': 'label update: `input` is the validator-checked {name, colorHex} only'})).toEqual([]);
    expect(scan(/\.\.\.\s*(?:body|payload|c\.req\.valid\([^)]*\))\b/)).toEqual([]);
  });

  /** Public/list selects must not expose another person's address. Heuristic: `email: true` inside a select. */
  const EMAIL_SELECT_ALLOWED: Record<string, string> = {
    'src/server/jobs/notification-email.ts': 'the opt-in recipient\'s OWN address, read at send time and handed to the mail sender only; never stored, logged or returned',
    'src/server/routes/members.ts': 'member directory: selected only to build maskEmail(), shown to admins+ (never the full address)',
  };
  it('no email selected in a Prisma select (another person\'s address never leaves the server)', () => {
    const hits = scan(/\bemail\s*:\s*true\b/);
    expect(unlisted(hits, EMAIL_SELECT_ALLOWED)).toEqual([]);
  });
});

describe('server guard: environment, logs, timers', () => {
  it('no process.env / env. reads in src/server (config only)', () => {
    expect(scan(/\bprocess\.env\b|(?<![\w.])env\.[A-Z_]{3,}\b|import\.meta\.env\.(?!DEV\b)/)).toEqual([]);
  });

  it('no secrets, tokens, passwords or keys in console.*', () => {
    const hits = unlisted(scan(/console\.\w+\(/, (rel, text, m) => /secret|token|password|passwd|apikey|api_key|siteKey|jwt|cookie|authorization|\bemail\b/i.test(callText(text, m.index! + m[0].length - 1))), {
      'src/server/jobs/notification-email.ts': 'only the word "email" in the log tag; logs a user id and a result kind, never an address',
      'src/server/jobs/invite-email.ts': 'only the word "email" in the log tag; logs invite ids and status codes, never an address or token',
    });
    expect(hits).toEqual([]);
  });

  it('no setTimeout / setInterval for later work (send a job)', () => {
    expect(scan(/\bset(?:Timeout|Interval)\s*\(/)).toEqual([]);
  });
});

describe('server guard: route guards', () => {
  /** Routes that are public on purpose: "<file>:<METHOD> <path>" -> why. */
  const PUBLIC_ROUTES: Record<string, string> = {
    'src/server/routes/checkout.ts:POST /': 'start a checkout: guests may buy, the handler reads the viewer itself (withViewer)',
    'src/server/routes/checkout.ts:GET /gateways': 'public list of ways to pay for a price key',
    'src/server/routes/checkout.ts:GET /:id': 'checkout status by unguessable id (format-checked), as payments.md describes',
    'src/server/routes/public-board.ts:GET /public/boards/:token': 'public read-only board: the unguessable hashed share token in the where is the capability; no viewer is read',
    'src/server/routes/billing.ts:GET /billing/public-plans': 'public pricing page data: plan limits and catalogue amounts only, cached, no viewer read, price keys stripped',
    'src/server/routes/site.ts:GET /': 'the public brand (name, logo), re-projected field by field',
    'src/server/routes/branding.ts:GET /brand.css': 'the brand colour as accent CSS for every page: one hex from app_settings, cached, no viewer read',
  };

  type Route = {rel: string; id: string; head: string; line: number};
  const routes: Route[] = [];
  for (const [rel, text] of code) {
    if (!rel.startsWith('src/server/routes/')) continue;
    for (const m of text.matchAll(/\.(get|post|put|patch|delete)\(\s*(['"`])(\/[^'"`]*)\2/g)) {
      const open = m.index! + m[0].indexOf('(');
      const call = callText(text, open);
      // the guard chain is what comes before the handler function
      const cut = call.search(/\basync\b|=>|\bfunction\b/);
      routes.push({rel, id: `${rel}:${m[1]!.toUpperCase()} ${m[3]}`, head: cut > 0 ? call.slice(0, cut) : call, line: lineOf(text, m.index!)});
    }
  }

  it('finds the route registrations (parser sanity)', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it('every non-public route has requireAuth', () => {
    const bad = routes.filter(r => !PUBLIC_ROUTES[r.id] && !/\brequireAuth\b/.test(r.head)).map(r => `${r.rel}:${r.line} ${r.id.slice(r.id.indexOf(':', 4) + 1)}`);
    expect(bad).toEqual([]);
  });

  it('withViewer comes before requireAuth in every chain that has both', () => {
    const bad = routes
      .filter(r => /\brequireAuth\b/.test(r.head) && !(r.head.search(/\bwithViewer\b/) >= 0 && r.head.search(/\bwithViewer\b/) < r.head.search(/\brequireAuth\b/)))
      .map(r => `${r.rel}:${r.line} ${r.id.slice(r.id.indexOf(':', 4) + 1)}`);
    expect(bad).toEqual([]);
  });

  it('every PUBLIC_ROUTES entry still exists (no stale allowlist)', () => {
    const ids = new Set(routes.map(r => r.id));
    expect(Object.keys(PUBLIC_ROUTES).filter(k => !ids.has(k))).toEqual([]);
  });
});
