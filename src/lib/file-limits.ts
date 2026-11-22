/**
 * The largest file ANY upload in this app may be: the platform's own per-file maximum (MAX_FILE_BYTES in
 * src/platform/files.ts, 5 GB). It is only the ceiling. The real limit is the workspace plan's `maxFileBytes`,
 * which an admin sets on /dashboard/plans; the server checks it on every upload.
 * Shared by the browser and the server, so it lives here and not in src/platform/ (server-only).
 */
export const FILE_CEILING_MB = 5 * 1024;
export const FILE_CEILING_BYTES = FILE_CEILING_MB * 1024 * 1024;
export const FILE_CEILING_LABEL = '5 GB';

/**
 * The most storage an admin may give one plan on /dashboard/plans (10 TB). Only a sanity ceiling: the real room is the
 * account's storage on the platform (the owner's storage packs), and uploads stop there whatever a plan says.
 */
export const STORAGE_CEILING_GB = 10 * 1024;
