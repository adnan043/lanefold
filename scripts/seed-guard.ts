/** Pure guard for scripts/seed-demo.ts: decides whether a database URL is safe for demo data. No imports, no secrets in output. */
export type SeedGuard = {ok: boolean; reason: string};

export function checkSeedTarget(rawUrl: string | undefined, env: {SITE_PREVIEW?: string} = {}): SeedGuard {
  if (!rawUrl) return {ok: false, reason: 'DATABASE_URL is not set.'};
  let host: string;
  let dbName: string;
  try {
    const u = new URL(rawUrl);
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    dbName = decodeURIComponent(u.pathname.replace(/^\/+/, '')).toLowerCase();
  } catch {
    return {ok: false, reason: 'DATABASE_URL is not a valid URL.'};
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return {ok: true, reason: 'local host'};
  if (dbName.endsWith('_test') || dbName.endsWith('_demo')) return {ok: true, reason: 'database name ends with _test or _demo'};
  if (env.SITE_PREVIEW === '1') return {ok: true, reason: 'SITE_PREVIEW=1 (Preview Database)'};
  return {ok: false, reason: 'Refusing to run: the database must be on localhost/127.0.0.1/::1, named *_test or *_demo, or SITE_PREVIEW=1. This script is for demo data only.'};
}
