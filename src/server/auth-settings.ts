import {type AuthSettings, DEFAULT_AUTH_SETTINGS} from '../platform/auth';
import {config} from '../platform/config';

/**
 * ONLY `astro dev` on this machine (`SITE_PREVIEW=1`, a localhost address) with no Site Key cannot relay the
 * confirmation email, so nobody could ever sign in. There, and only there, a password account works without
 * confirming its email. `import.meta.env.DEV` is false in every build, so the live site always requires it.
 */
const localDevWithoutMail = () =>
  import.meta.env.DEV === true && config.preview && /^https?:\/\/localhost(:\d+)?\/?$/.test(config.siteUrl ?? '') && !config.siteKey;

/**
 * How sign-in works on THIS site (yours to edit; the auth core in
 * `src/platform/auth/` reads it). Every option is explained in
 * `src/platform/auth/settings.ts` and docs/agent/auth.md.
 *
 * Who may become owner: The platform hands the live site the account owner's
 * email at each Publish (`SITE_OWNER_EMAILS`); add more addresses in
 * `ownerEmails`. On the live site, with no owner email at all, nobody becomes
 * owner (the first person to sign up never does).
 */
export const authSettings: AuthSettings = {
  ...DEFAULT_AUTH_SETTINGS,
  registration: 'open',
  // true everywhere except `astro dev` on localhost without a Site Key (see `localDevWithoutMail`).
  get requireEmailVerification() {
    return !localDevWithoutMail();
  },
  // ownerEmails: ['owner@example.com'],
  // Lanefold lives at /app (docs/product/SPEC.md §2); the owner's one-click "Open admin" lands there too; the dashboard stays at /dashboard.
  afterSignInPath: '/app',
};
