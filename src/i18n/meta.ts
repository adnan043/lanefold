import {LOCALES} from './locales';

/**
 * Catalogs that a native speaker has NOT reviewed yet (machine drafts).
 * Everything except `en` starts here; remove a code once it is reviewed.
 * The language picker shows a hint for these.
 */
export const NEEDS_REVIEW: ReadonlySet<string> = new Set(LOCALES.map(locale => locale.code).filter(code => code !== 'en'));

export const needsReview = (code: string) => NEEDS_REVIEW.has(code);
