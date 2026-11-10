/**
 * LOCAL DEVELOPMENT MODE: for building this site on your own computer, never anywhere else.
 *
 * On your machine there is no Site Key, so the platform can't relay account emails: without this,
 * nobody could finish signing up. In this mode the email that would have been sent (its code and
 * its link) is printed in the terminal running `npm run dev`, marked "local development only".
 *
 * It is on ONLY when ALL of these hold, each checked on the server (fail closed: anything unsure
 * means off):
 *   - no Site Key (`SITE_KEY` empty): every site the platform hosts, its Preview and its staging
 *     copy have one, so it can never be on there;
 *   - not a production build (`import.meta.env.PROD` is false: `astro dev`, `vitest`); in
 *     `npm run build` output the check is compiled to `false`;
 *   - `NODE_ENV` is not `production`;
 *   - not the editor Preview (`SITE_PREVIEW` unset).
 *
 * It never makes an owner or an admin: `npm run platform -- dev-admin <email>` gives a local user
 * `admin` in a LOCAL database (scripts/platform.mjs), and the owner still comes only from
 * "View as admin" in the dashboard.
 */
export interface LocalDevInputs {
  siteKey: string | null | undefined;
  preview: boolean;
  /** `import.meta.env.PROD` */
  prodBuild: unknown;
  /** `import.meta.env.DEV` */
  devBuild: unknown;
  nodeEnv: string | null | undefined;
}

export function localDevAllowed(input: LocalDevInputs): boolean {
  if (input.siteKey) return false;
  if (input.preview) return false;
  if (input.prodBuild !== false) return false;
  if (input.devBuild !== true) return false;
  if ((input.nodeEnv ?? '').trim().toLowerCase() === 'production') return false;
  return true;
}

/** `process.env.NODE_ENV` where there is a `process` (Node, workerd with Node compatibility). */
export function nodeEnv(): string | undefined {
  const p = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process;
  return p?.env?.NODE_ENV;
}

/** What the terminal shows instead of an email. Never called where `localDevAllowed` is false. */
export function localDevEmailLines(email: {kind: string; to?: string; code?: string; path?: string}, origin: string): string[] {
  const lines = [
    '────────── LOCAL DEVELOPMENT ONLY: this email was not sent ──────────',
    `  ${email.kind} → ${email.to ?? '(the site owner)'}`,
  ];
  if (email.code) lines.push(`  code: ${email.code}`);
  if (email.path) lines.push(`  link: ${origin}${email.path}`);
  lines.push('  (no Site Key on this machine, so nothing is emailed; a hosted site always emails)');
  lines.push('─────────────────────────────────────────────────────────────────────');
  return lines;
}
