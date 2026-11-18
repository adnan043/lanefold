/**
 * Files sent in chat: ONE place for the rules, read by the server route (the real check), the composer (a quick check
 * before an upload starts) and the help text, so the three always agree (files.md › Your own limits).
 */

/** Documents and pictures. Never SVG, HTML or scripts (the platform refuses them too); no audio or video in chat. */
export const CHAT_FILE_TYPES: readonly string[] = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** For the file picker (`accept`): narrows what it shows; the check is CHAT_FILE_TYPES. */
export const CHAT_FILE_ACCEPT = '.pdf,.txt,.csv,.docx,.xlsx,.pptx,.zip,.png,.jpg,.jpeg,.webp,.gif';

/** The most one chat file may weigh (the workspace plan may allow less: the server checks both). */
export const CHAT_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** Files on one message. */
export const CHAT_FILES_PER_MESSAGE = 10;

/** Pictures shown in the message itself (the others are a file row with a download link). */
export const CHAT_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Shown in the browser instead of downloaded (pictures and PDF); everything else downloads. */
export const CHAT_INLINE_TYPES: readonly string[] = [...CHAT_IMAGE_TYPES, 'application/pdf'];

/**
 * The type a file is sent with: the browser's, or (some systems leave it empty for Office files and CSV) the one its
 * extension names. Lowercased; '' when neither is known.
 */
export function chatFileType(name: string, browserType: string): string {
  const given = browserType.toLowerCase();
  if (given) return given;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const byExt: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return byExt[ext] ?? '';
}

/** A chat file as the server stores it (the columns the client may see). */
export type ChatFileRow = {id: number; name: string; contentType: string; size: number};

/** What the client gets of a chat file: never the platform file id, never a stored link. */
export const chatFileShape = (f: ChatFileRow) => ({id: f.id, name: f.name, contentType: f.contentType, size: f.size, isImage: CHAT_IMAGE_TYPES.includes(f.contentType)});

export type ChatFileT = ReturnType<typeof chatFileShape>;
