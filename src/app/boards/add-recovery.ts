/**
 * A failed card add has exactly ONE recovery path. When the composer takes the text back (`restore` given),
 * that is the path: no "Try again" in the failure bar, or using both would add the cards twice. Without a
 * composer (no `restore`), the bar's retry is the path.
 */
export function addRetry(restore: (() => void) | undefined, retry: () => void): (() => void) | undefined {
  return restore ? undefined : retry;
}

/** Run the restore (when there is one) and return the retry the failure bar may offer. */
export function recoverFailedAdd(restore: (() => void) | undefined, retry: () => void): (() => void) | undefined {
  restore?.();
  return addRetry(restore, retry);
}
