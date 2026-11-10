/** True when the error is a failed dynamic import (a deploy replaced the chunk while the app was open). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /dynamically imported module|module script|Importing a module|Loading chunk|ChunkLoadError|error loading dynamically/i.test(message);
}

/** What may be logged about a failure: its kind only (messages can carry titles, names or addresses). */
export function safeErrorLabel(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
}
