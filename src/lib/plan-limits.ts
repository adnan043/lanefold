/**
 * Plan limit ceilings shared by the browser and the server (src/server/entitlements.ts enforces them).
 * Like Trello, a paid plan has "unlimited" members and boards: behind that word is the app's safety cap below.
 */
/** The most members any workspace may have. A plan at this number shows as "Unlimited". */
export const UNLIMITED_MEMBERS = 500;
/** The most open boards any workspace may have ("Unlimited" boards on a plan). */
export const MAX_BOARDS_CAP = 1000;
/** The most flow runs a month an admin may type for a plan (empty = unlimited). */
export const MAX_FLOW_RUNS_INPUT = 1_000_000;
