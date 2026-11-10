/**
 * A board's uploaded background photo (`boards.bg_file_id`), shown through `GET /boards/:id/background`
 * (access check, then a short link: never a stored link). The `v` part changes with each new photo so the
 * browser never shows the old one from its cache. Null when the board has no photo.
 */
export function bgImageUrl(boardId: number, bgFileId: string | null): string | null {
  if (!bgFileId) return null;
  const version = bgFileId.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase() || '1';
  return `/site-api/boards/${boardId}/background?v=${version}`;
}

/** Photo types a board background may be (shown with CSS, so never SVG), and its size cap. */
export const BG_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
export const BG_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
