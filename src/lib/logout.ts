import {siteFetch} from '../platform/browser';

/**
 * Signs this device out. On a public page it reloads, so the page renders signed out. From a signed-in-only
 * area (the app, the dashboard) it opens the sign-in page WITHOUT `?next=` instead: a reload there would bounce
 * to `/account/login/?next=<this page>`, and whoever signs in next on this device (another account, without
 * access to that page) would land on it. The template's `logout()` (src/platform/browser.ts) always reloads.
 */
export async function logout(): Promise<void> {
  await siteFetch('/site-api/auth/logout', {method: 'POST'}).catch(() => null);
  if (/^\/(app|dashboard|portal)(\/|$)/.test(window.location.pathname)) window.location.replace('/account/login/');
  else window.location.reload();
}
