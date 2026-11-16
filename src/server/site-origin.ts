import {config} from '../platform/config';

/**
 * The origin to put in links that carry a secret (invite and share links). On the live site it is ONLY the
 * platform's `SITE_URL`: the request's own Host may not be one we chose, and a link built from it would hand the
 * token to that host. Outside production (your machine, tests) the request's origin stands in when it is unset.
 */
export function linkOrigin(requestUrl: string): string {
  if (config.siteUrl) return config.siteUrl;
  if (config.production) throw new Error('SITE_URL is not set: refusing to build a link from the request host.');
  return new URL(requestUrl).origin;
}
