/**
 * The largest file ANY upload in this app may be. It is only the ceiling. The real limit is the workspace plan's
 * `maxFileBytes`, which an admin sets on /dashboard/plans; the server checks it on every upload.
 * 2047 MB, just under 2 GiB: `attachments.size` is a Postgres `integer` (at most 2,147,483,647 bytes), so a bigger
 * file could not be recorded (the platform itself would take up to 5 GB). Still far above what a board needs
 * (Trello: 10 MB free, 250 MB paid). Raising it means widening that column to BIGINT first.
 * Shared by the browser and the server, so it lives here and not in src/platform/ (server-only).
 */
export const FILE_CEILING_MB = 2047;
export const FILE_CEILING_BYTES = FILE_CEILING_MB * 1024 * 1024;
export const FILE_CEILING_LABEL = '2 GB';

/**
 * The most storage an admin may give one plan on /dashboard/plans (10 TB). Only a sanity ceiling: the real room is the
 * account's storage on the platform (the owner's storage packs), and uploads stop there whatever a plan says.
 */
export const STORAGE_CEILING_GB = 10 * 1024;
