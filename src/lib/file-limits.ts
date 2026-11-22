/**
 * The largest file ANY upload in this app may be: 250 MB, Trello's paid limit. It is only the ceiling. The real limit
 * is the workspace plan's `maxFileBytes` (Free 10 MB, Pro and Team 250 MB), which an admin sets on /dashboard/plans;
 * the server checks it on every upload. There is no storage limit on any plan (like Trello).
 * Shared by the browser and the server, so it lives here and not in src/platform/ (server-only).
 */
export const FILE_CEILING_MB = 250;
export const FILE_CEILING_BYTES = FILE_CEILING_MB * 1024 * 1024;
export const FILE_CEILING_LABEL = '250 MB';
